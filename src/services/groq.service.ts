// src/services/groq.service.ts

import groqClient from "../config/groq";
import { SignalPayload, SignalResult } from "../types/signal.types";
import { IAiReview, ITrade } from "../types/trade.types";
import { INewsItem } from "../types/news.types";

// ─── Models ───────────────────────────────────────────────────────────────────

const GROQ_MODELS = {
  ANALYSIS: "llama-3.3-70b-versatile",
  SENTIMENT: "llama-3.1-8b-instant",
  PATTERN: "llama-3.3-70b-versatile",
} as const;

// ─── Timeout wrapper ──────────────────────────────────────────────────────────
// Groq occasionally hangs — abort after 30s rather than waiting forever

function withTimeout<T>(promise: Promise<T>, ms = 30_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Groq request timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

// ─── Safe JSON parse ──────────────────────────────────────────────────────────
// Groq occasionally wraps JSON in markdown fences despite response_format

function safeParseJSON<T>(content: string): T {
  const cleaned = content
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  return JSON.parse(cleaned) as T;
}

// ─── generateSignal ───────────────────────────────────────────────────────────

export async function generateSignal(
  payload: SignalPayload,
): Promise<SignalResult> {
  const response = await withTimeout(
    groqClient.chat.completions.create({
      model: GROQ_MODELS.ANALYSIS,
      messages: [
        {
          role: "system",
          content:
            "You are AURA, an expert FOREX and Gold trading AI. Respond with valid JSON only. No markdown, no explanation outside the JSON.",
        },
        {
          role: "user",
          content: buildSignalPrompt(payload),
        },
      ],
      temperature: 0.3,
      max_tokens: 1000,
      response_format: { type: "json_object" },
    }),
  );

  const content = response.choices[0]?.message?.content;
  if (!content)
    throw new Error("Groq returned empty response for signal generation");

  const parsed = safeParseJSON<SignalResult>(content);

  // Validate required fields before returning
  if (!parsed.signal || !["BUY", "SELL", "HOLD"].includes(parsed.signal)) {
    throw new Error(`Groq returned invalid signal value: ${parsed.signal}`);
  }
  if (typeof parsed.confidence !== "number") {
    throw new Error("Groq returned missing confidence value");
  }

  const signal = parsed.signal;
  const confidence = Math.min(100, Math.max(0, parsed.confidence));

  // Safety gate: never recommend an auto-trade on HOLD or low-confidence signals
  const autoTradeRecommended =
    signal !== "HOLD" &&
    confidence >= 72 &&
    parsed.autoTradeRecommended === true;

  return {
    signal,
    confidence,
    bullScore: Math.min(100, Math.max(0, parsed.bullScore ?? 50)),
    bearScore: Math.min(100, Math.max(0, parsed.bearScore ?? 50)),
    reasoning: parsed.reasoning ?? "",
    entry: parsed.entry ?? payload.price,
    takeProfit: parsed.takeProfit ?? payload.price,
    stopLoss: parsed.stopLoss ?? payload.price,
    riskReward: parsed.riskReward ?? "1:1",
    keyRisks: Array.isArray(parsed.keyRisks) ? parsed.keyRisks : [],
    timeHorizon: parsed.timeHorizon ?? "Unknown",
    autoTradeRecommended,
  };
}

function buildSignalPrompt(payload: SignalPayload): string {
  const price = payload.price;
  const atr   = payload.atr;
  const aboveEma20 = price > payload.ema20 ? 'above' : 'below';
  const aboveEma50 = price > payload.ema50 ? 'above' : 'below';
  const macdMomentum = payload.macd.histogram > 0 ? 'bullish (positive histogram)' : 'bearish (negative histogram)';
  const rsiContext =
    payload.rsi > 70 ? 'overbought zone' :
    payload.rsi < 30 ? 'oversold zone' :
    payload.rsi > 55 ? 'bullish range' :
    payload.rsi < 45 ? 'bearish range' : 'neutral';
  const adxContext = payload.adx >= 25 ? `trending (${payload.adx.toFixed(1)})` : `ranging/weak (${payload.adx.toFixed(1)}) — avoid counter-trend trades`;

  return `You are AURA, an elite multi-market AI trader specialising in FOREX and Gold.
Your task: produce a high-quality signal with precise, ATR-calibrated entry, stop-loss, and take-profit levels.

═══════════════════════════════════════
RISK MANAGEMENT RULES (mandatory)
═══════════════════════════════════════
• StopLoss: place 1.5× ATR beyond the nearest swing high/low or structure level.
  ATR(14) = ${atr} → minimum SL distance = ${(atr * 1.5).toFixed(5)}
• TakeProfit: target minimum 2:1 R:R (TP distance ≥ 2× SL distance from entry).
  Preferred target = 2.5-3× SL distance at next significant resistance/support.
• Entry: use current price for market entry; refine slightly for limit-order advantage if momentum is still building.

═══════════════════════════════════════
AUTO-TRADE CRITERIA (all must be true)
═══════════════════════════════════════
Set autoTradeRecommended=true ONLY when ALL of the following apply:
  1. signal is BUY or SELL (not HOLD)
  2. confidence ≥ 72
  3. ADX ≥ 25 (confirmed trend — not ranging)
  4. Higher-TF trend AGREES with signal direction
  5. MACD histogram AGREES with signal direction
  6. R:R ≥ 1:2 after applying ATR-based stops
  7. Session has adequate liquidity (London or NY preferred; Asian only for XAU/USD or USD/JPY with very strong setup)
  8. No imminent high-impact news event (check keyRisks — if a major event is within 1 hour, set false)

═══════════════════════════════════════
MARKET DATA
═══════════════════════════════════════
Pair:              ${payload.pair}
Timeframe:         ${payload.timeframe}
Session:           ${payload.session}
Current Price:     ${price}
ATR(14):           ${atr}

TECHNICAL INDICATORS (${payload.timeframe}):
  RSI(14):         ${payload.rsi.toFixed(2)} — ${rsiContext}
  MACD:            value=${payload.macd.value.toFixed(5)}, signal=${payload.macd.signal.toFixed(5)}, histogram=${payload.macd.histogram.toFixed(5)} — ${macdMomentum}
  EMA20:           ${payload.ema20.toFixed(5)} | price is ${aboveEma20} EMA20
  EMA50:           ${payload.ema50.toFixed(5)} | price is ${aboveEma50} EMA50
  Bollinger Bands: Upper=${payload.bb.upper}, Mid=${payload.bb.mid}, Lower=${payload.bb.lower}
  Stochastic:      %K=${payload.stoch.k}, %D=${payload.stoch.d}
  ADX:             ${adxContext}

HIGHER TIMEFRAME CONTEXT:
  ${payload.higherTfTrend}

PATTERNS DETECTED: ${payload.patterns.length > 0 ? payload.patterns.join(', ') : 'None'}
NEWS SENTIMENT:    ${payload.newsSentiment}
USER RULES:        ${payload.ragContext || 'None provided'}
${payload.accuracyContext ? `ACCURACY HISTORY:  ${payload.accuracyContext}` : ''}
${payload.tradingContext  ? `PERSONAL EDGE:     ${payload.tradingContext}`  : ''}

═══════════════════════════════════════
OUTPUT — valid JSON only, no markdown
═══════════════════════════════════════
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "bullScore": 0-100,
  "bearScore": 0-100,
  "reasoning": "3-4 sentence analysis citing specific indicator values, price vs EMAs, and ATR-based levels",
  "entry": number,
  "takeProfit": number (min 2× SL distance from entry),
  "stopLoss": number (1.5× ATR from entry, beyond structure),
  "riskReward": "1:X.X",
  "keyRisks": ["risk1", "risk2", "risk3"],
  "timeHorizon": "e.g. 2-4 hours",
  "autoTradeRecommended": true | false
}`;
}

// ─── scoreNewsSentiment ───────────────────────────────────────────────────────

export async function scoreNewsSentiment(
  headlines: string[],
  pair: string,
): Promise<Omit<INewsItem, "source" | "publishedAt" | "pairs">[]> {
  if (headlines.length === 0) return [];

  const response = await withTimeout(
    groqClient.chat.completions.create({
      model: GROQ_MODELS.SENTIMENT,
      messages: [
        {
          role: "system",
          content:
            "You are a financial news sentiment analyst. Respond with valid JSON only.",
        },
        {
          role: "user",
          content: `Score the sentiment of each headline for ${pair}.

Headlines:
${headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Respond with this exact JSON:
{
  "results": [
    {
      "headline": "original headline text",
      "sentiment": "bull" or "bear" or "neut",
      "impact": "high" or "med" or "low",
      "score": number from -1.0 to 1.0,
      "reasoning": "one sentence explanation"
    }
  ]
}`,
        },
      ],
      temperature: 0.1,
      max_tokens: 1200,
      response_format: { type: "json_object" },
    }),
    20_000, // sentiment is faster — shorter timeout
  );

  const content = response.choices[0]?.message?.content;
  if (!content) return [];

  try {
    const parsed = safeParseJSON<{
      results?: unknown[];
      sentiments?: unknown[];
    }>(content);
    const results = parsed.results ?? parsed.sentiments ?? [];
    return Array.isArray(results)
      ? (results as Omit<INewsItem, "source" | "publishedAt" | "pairs">[])
      : [];
  } catch {
    console.error("Failed to parse Groq sentiment response");
    return [];
  }
}

// ─── answerWithContext ────────────────────────────────────────────────────────

export async function answerWithContext(
  question: string,
  chunks: string[],
  tradingContext: string,
): Promise<string> {
  const response = await withTimeout(
    groqClient.chat.completions.create({
      model: GROQ_MODELS.ANALYSIS,
      messages: [
        {
          role: "system",
          content:
            "You are AURA AI, a personal trading assistant with access to the user's indexed knowledge base. Use the provided context chunks to give precise, actionable answers. Reference specific data from the context when available. If the context does not contain enough information, say so clearly.",
        },
        {
          role: "user",
          content: `Knowledge base context:
---
${chunks.length > 0 ? chunks.map((c, i) => `[${i + 1}] ${c}`).join("\n\n") : "No knowledge base context available."}
---

Current trading context:
${tradingContext || "No trading context available."}

User question: ${question}`,
        },
      ],
      temperature: 0.4,
      max_tokens: 1000,
    }),
  );

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Groq returned empty response for RAG query");
  return content;
}

// ─── explainPattern ───────────────────────────────────────────────────────────

export async function explainPattern(
  pattern: string,
  pair: string,
  price: number,
): Promise<string> {
  const response = await withTimeout(
    groqClient.chat.completions.create({
      model: GROQ_MODELS.PATTERN,
      messages: [
        {
          role: "system",
          content:
            "You are a technical analysis expert. Give concise, practical pattern explanations for traders.",
        },
        {
          role: "user",
          content: `Explain the "${pattern}" pattern detected on ${pair} at price ${price}.
Include: what it means, reliability rating, what to watch for next, and typical trade setup.
Keep response under 150 words.`,
        },
      ],
      temperature: 0.3,
      max_tokens: 300,
    }),
    15_000,
  );

  const content = response.choices[0]?.message?.content;
  if (!content)
    throw new Error("Groq returned empty response for pattern explanation");
  return content;
}

// ─── reviewTrade ──────────────────────────────────────────────────────────────

export async function reviewTrade(
  trade: Pick<
    ITrade,
    | "pair"
    | "type"
    | "entry"
    | "exit"
    | "size"
    | "pnl"
    | "rr"
    | "duration"
    | "notes"
    | "status"
  >,
): Promise<IAiReview> {
  const response = await withTimeout(
    groqClient.chat.completions.create({
      model: GROQ_MODELS.ANALYSIS,
      messages: [
        {
          role: "system",
          content:
            "You are an expert FOREX trade reviewer. Respond with valid JSON only.",
        },
        {
          role: "user",
          content: `Review this FOREX trade and provide constructive feedback.

Pair:     ${trade.pair}
Type:     ${trade.type}
Entry:    ${trade.entry}
Exit:     ${trade.exit ?? "Still open"}
Size:     ${trade.size}
P&L:      ${trade.pnl ?? "N/A"}
R:R:      ${trade.rr ?? "N/A"}
Duration: ${trade.duration ?? "N/A"}
Status:   ${trade.status}
Notes:    ${trade.notes ?? "None"}

Respond with exactly this JSON:
{
  "verdict": "good" or "poor" or "acceptable",
  "entryQuality": number 1-10,
  "exitQuality": number 1-10,
  "riskManagement": number 1-10,
  "lessonsLearned": ["lesson 1", "lesson 2"],
  "suggestions": "specific actionable improvement"
}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 600,
      response_format: { type: "json_object" },
    }),
  );

  const content = response.choices[0]?.message?.content;
  if (!content)
    throw new Error("Groq returned empty response for trade review");

  const parsed = safeParseJSON<IAiReview>(content);

  // Validate and normalise before saving to DB
  return {
    verdict: ["good", "poor", "acceptable"].includes(parsed.verdict)
      ? parsed.verdict
      : "acceptable",
    entryQuality: Math.min(10, Math.max(1, parsed.entryQuality ?? 5)),
    exitQuality: Math.min(10, Math.max(1, parsed.exitQuality ?? 5)),
    riskManagement: Math.min(10, Math.max(1, parsed.riskManagement ?? 5)),
    lessonsLearned: Array.isArray(parsed.lessonsLearned)
      ? parsed.lessonsLearned
      : [String(parsed.lessonsLearned ?? "")],
    suggestions: parsed.suggestions ?? "",
  };
}

// ─── generateCoachingInsights ─────────────────────────────────────────────────
// Analyses a trader's performance stats and produces AI-driven coaching insights.
// The profile parameter shape mirrors TradingProfileData from trading-profile.service.

interface ProfileForCoaching {
  totalTrades:        number;
  winRate:            number;
  profitFactor:       number;
  avgRR:              number;
  byPair:             { pair: string; count: number; winRate: number; netPnL: number; buyWinRate: number; sellWinRate: number }[];
  bySession:          { session: string; count: number; winRate: number; netPnL: number }[];
  byDay:              { day: string; count: number; winRate: number }[];
  buyWinRate:         number;
  sellWinRate:        number;
  avgWinDurationMin:  number;
  avgLossDurationMin: number;
  holdingTendency:    string;
  recentStreak:       { type: string; count: number };
  last10WinRate:      number;
  bestPair:           string | null;
  worstPair:          string | null;
  bestSession:        string | null;
  bestDay:            string | null;
}

export async function generateCoachingInsights(
  profile: ProfileForCoaching
): Promise<{ insights: string[]; topSuggestion: string }> {
  if (profile.totalTrades < 5) {
    return {
      insights: ['Log at least 5 trades to unlock personalised AI coaching.'],
      topSuggestion: 'Build your trade history — coaching unlocks after 5 closed trades.',
    };
  }

  const byPairStr    = profile.byPair.map((p) =>
    `  ${p.pair}: ${p.count} trades | WR ${p.winRate}% | Net $${p.netPnL} | BUY ${p.buyWinRate}% / SELL ${p.sellWinRate}%`
  ).join('\n') || '  No pair data';

  const bySessionStr = profile.bySession.map((s) =>
    `  ${s.session}: ${s.count} trades | WR ${s.winRate}% | Net $${s.netPnL}`
  ).join('\n') || '  No session data';

  const byDayStr = profile.byDay.map((d) =>
    `  ${d.day}: ${d.count} trades | WR ${d.winRate}%`
  ).join('\n') || '  No day data';

  const userPrompt = `You are an elite professional forex trading coach. Analyze this trader's REAL performance data.

OVERALL STATS:
  Total Trades: ${profile.totalTrades}
  Win Rate: ${profile.winRate}%
  Profit Factor: ${profile.profitFactor} (>1.5 good, >2 excellent)
  Avg R:R: 1:${profile.avgRR}
  BUY WR: ${profile.buyWinRate}% | SELL WR: ${profile.sellWinRate}%
  Holding Tendency: ${profile.holdingTendency}
  Avg Winner: ${profile.avgWinDurationMin}min | Avg Loser: ${profile.avgLossDurationMin}min
  Current Streak: ${profile.recentStreak.count} consecutive ${profile.recentStreak.type}s
  Last 10 Trades WR: ${profile.last10WinRate}%
  Best Pair: ${profile.bestPair ?? 'N/A'} | Worst Pair: ${profile.worstPair ?? 'N/A'}
  Best Session: ${profile.bestSession ?? 'N/A'} | Best Day: ${profile.bestDay ?? 'N/A'}

BY PAIR:
${byPairStr}

BY SESSION:
${bySessionStr}

BY DAY OF WEEK:
${byDayStr}

Generate exactly 6 coaching insights. Rules:
- MUST cite specific numbers from the data (percentages, dollar amounts, trade counts)
- MUST give a concrete actionable instruction ("Only trade X when Y", "Avoid Z", "Reduce size to...")
- NO generic advice like "follow your rules" or "manage risk" without specific data
- Be brutally honest about weaknesses
- If a pattern has fewer than 4 data points, note the limited sample size

Also identify the single most critical change this trader must make RIGHT NOW.

Respond ONLY with valid JSON (no markdown fences, no extra text):
{
  "insights": ["insight1", "insight2", "insight3", "insight4", "insight5", "insight6"],
  "topSuggestion": "The one most critical action this trader must take, with specific numbers."
}`;

  try {
    const response = await withTimeout(
      groqClient.chat.completions.create({
        model: GROQ_MODELS.ANALYSIS,
        messages: [
          {
            role: 'system',
            content: 'You are an elite forex trading coach. Analyze data and give brutally honest, data-driven coaching. Respond only with valid JSON.',
          },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.35,
        max_tokens: 1600,
      }),
      30_000
    );

    const raw    = (response as any).choices[0]?.message?.content ?? '{}';
    const parsed = safeParseJSON<{ insights: string[]; topSuggestion: string }>(raw);

    return {
      insights:      Array.isArray(parsed.insights) ? parsed.insights.slice(0, 6) : [],
      topSuggestion: typeof parsed.topSuggestion === 'string' ? parsed.topSuggestion : '',
    };
  } catch (err) {
    console.warn('[groq] generateCoachingInsights failed:', (err as Error).message);
    return { insights: [], topSuggestion: '' };
  }
}
