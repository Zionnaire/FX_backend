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
      max_tokens: 1200,
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

  const signal     = parsed.signal;
  const confidence = Math.min(100, Math.max(0, parsed.confidence));
  const confluenceScore = Math.min(8, Math.max(0, parsed.confluenceScore ?? 0));
  const isScalp = payload.tradingStyle === 'scalp';

  // Safety gate: thresholds differ between scalp and swing
  const autoTradeRecommended =
    signal !== "HOLD" &&
    confidence >= (isScalp ? 65 : 72) &&
    confluenceScore >= (isScalp ? 5 : 6) &&
    parsed.autoTradeRecommended === true;

  return {
    signal,
    confidence,
    bullScore:      Math.min(100, Math.max(0, parsed.bullScore ?? 50)),
    bearScore:      Math.min(100, Math.max(0, parsed.bearScore ?? 50)),
    reasoning:      parsed.reasoning ?? "",
    entry:          parsed.entry ?? payload.price,
    takeProfit:     parsed.takeProfit ?? payload.price,
    stopLoss:       parsed.stopLoss ?? payload.price,
    riskReward:     parsed.riskReward ?? "1:1",
    keyRisks:       Array.isArray(parsed.keyRisks) ? parsed.keyRisks : [],
    timeHorizon:    parsed.timeHorizon ?? "Unknown",
    autoTradeRecommended,
    confluenceScore,
    entryType:      (parsed.entryType === 'LIMIT' ? 'LIMIT' : 'MARKET'),
  };
}

const BULLISH_PATTERNS = new Set([
  'Bullish Engulfing', 'Hammer',
  'Three White Soldiers', 'Three Inside Up', 'Three Outside Up', 'Morning Star',
]);
const BEARISH_PATTERNS = new Set([
  'Bearish Engulfing', 'Shooting Star',
  'Three Black Crows', 'Three Inside Down', 'Three Outside Down', 'Evening Star',
]);

function formatPatternsForPrompt(patterns: string[]): string {
  if (patterns.length === 0) return 'None detected';
  return patterns.map(p => {
    if (BULLISH_PATTERNS.has(p)) return `${p} [BULLISH ↑]`;
    if (BEARISH_PATTERNS.has(p)) return `${p} [BEARISH ↓]`;
    return p;
  }).join(', ');
}

function buildSignalPrompt(payload: SignalPayload): string {
  const price   = payload.price;
  const atr     = payload.atr;
  const isScalp = payload.tradingStyle === 'scalp';

  const aboveEma20  = price > payload.ema20  ? 'above' : 'below';
  const aboveEma50  = price > payload.ema50  ? 'above' : 'below';
  const aboveEma200 = price > payload.ema200 ? 'above' : 'below';

  const macdMomentum = payload.macd.histogram > 0
    ? 'BULLISH (positive histogram)'
    : 'BEARISH (negative histogram)';

  const rsiContext =
    payload.rsi > 70 ? 'OVERBOUGHT — BUY signals unreliable here' :
    payload.rsi < 30 ? 'OVERSOLD — SELL signals unreliable here' :
    payload.rsi > 55 ? 'bullish range (>55)' :
    payload.rsi < 45 ? 'bearish range (<45)' : 'neutral (45–55)';

  const adxThreshold = isScalp ? 15 : 25;
  const adxContext = payload.adx >= adxThreshold
    ? `TRENDING (${payload.adx.toFixed(1)}) — directional trades valid`
    : `RANGING/WEAK (${payload.adx.toFixed(1)}) — ${isScalp ? 'momentum scalp only' : 'avoid trend-following entries'}`;

  const bbPosition =
    price > payload.bb.upper ? 'ABOVE upper band (overextended — caution on BUY)' :
    price < payload.bb.lower ? 'BELOW lower band (overextended — caution on SELL)' :
    price > payload.bb.mid   ? 'between mid and upper band' :
                               'between mid and lower band';

  const stochContext =
    payload.stoch.k > 80 ? `OVERBOUGHT (${payload.stoch.k.toFixed(1)})` :
    payload.stoch.k < 20 ? `OVERSOLD (${payload.stoch.k.toFixed(1)})` :
                           `neutral (${payload.stoch.k.toFixed(1)})`;

  const htfLabel = payload.higherTfTrend.split(':')[0]?.trim() || '4H';

  // Scalp: tighter SL/TP scaled to quick moves; swing: ATR × 1.5 / × 3.75
  const minSL = isScalp ? (atr * 0.5).toFixed(5) : (atr * 1.5).toFixed(5);
  const minTP = isScalp ? (atr * 0.75).toFixed(5) : (atr * 1.5 * 2.5).toFixed(5);
  const minRR = isScalp ? '1:1.5' : '1:2';

  const modeHeader = isScalp
    ? '⚡ SCALP MODE — Quick-profit intraday trades (5–30 min hold, 5–15 pip TP)'
    : '📊 SWING MODE — Multi-hour positional trades with full confluence';

  const confluenceMin  = isScalp ? 3 : 6;
  const confluenceGood = isScalp ? 5 : 8;

  return `You are AURA — an institutional-grade FOREX and Gold AI analyst.
${modeHeader}
Your output will be placed on a LIVE trading account. Be precise. Protect capital first.

═══════════════════════════════════════════════════════
SESSION & MARKET CONTEXT
═══════════════════════════════════════════════════════
Pair:            ${payload.pair}
Timeframe:       ${payload.timeframe}
Trading Style:   ${isScalp ? 'SCALP (fast, 5-30 min, tight SL/TP)' : 'SWING (multi-hour, full confluence required)'}
Session:         ${payload.session}
Session Rating:  ${payload.sessionRating}  (PRIME=ideal, ACTIVE=tradeable, AVOID=low liquidity)
Current Price:   ${price}
ATR(14):         ${atr.toFixed(5)}  →  min SL=${minSL}  |  min TP=${minTP}

MULTI-TIMEFRAME BIAS:
  Daily:         ${payload.dailyTrend}
  ${payload.higherTfTrend}

═══════════════════════════════════════════════════════
TECHNICAL INDICATORS — ${payload.timeframe}
═══════════════════════════════════════════════════════
  RSI(14):      ${payload.rsi.toFixed(2)} — ${rsiContext}
  MACD:         histogram=${payload.macd.histogram.toFixed(5)} — ${macdMomentum}
  EMA20:        ${payload.ema20.toFixed(5)}  price is ${aboveEma20} EMA20
  EMA50:        ${payload.ema50.toFixed(5)}  price is ${aboveEma50} EMA50
  EMA200:       ${payload.ema200.toFixed(5)}  price is ${aboveEma200} EMA200 (macro bias)
  BB:           price ${bbPosition}
    Upper=${payload.bb.upper.toFixed(5)} | Mid=${payload.bb.mid.toFixed(5)} | Lower=${payload.bb.lower.toFixed(5)}
  Stochastic:   %K=${stochContext}  %D=${payload.stoch.d.toFixed(1)}
  ADX:          ${adxContext}
  Patterns:     ${formatPatternsForPrompt(payload.patterns)}

═══════════════════════════════════════════════════════
CONFLUENCE CHECKLIST — score 1 point each (total → confluenceScore 0-8)
═══════════════════════════════════════════════════════
  [1] Daily trend AGREES with proposed signal direction
  [2] ${htfLabel} trend AGREES with proposed signal direction
  [3] EMA20 and EMA50 both aligned with signal (price above both for BUY / below both for SELL)
  [4] RSI supports direction (>50 for BUY, <50 for SELL; NOT in opposing extreme)
  [5] MACD histogram AGREES (positive for BUY, negative for SELL)
  [6] ADX ≥ ${adxThreshold} (confirmed momentum)
  [7] Stochastic NOT in opposing extreme (%K < 80 for BUY entry; %K > 20 for SELL entry)
  [8] Candlestick pattern or BB level supports signal

QUALITY THRESHOLDS (${isScalp ? 'SCALP MODE' : 'SWING MODE'}):
  confluenceScore ≥ ${confluenceGood} → A+ setup → full confidence BUY/SELL
  confluenceScore ${confluenceMin}–${confluenceGood - 1} → B setup → BUY/SELL with reduced conviction
  confluenceScore < ${confluenceMin} → MANDATORY HOLD — insufficient confluence

═══════════════════════════════════════════════════════
KEY STRUCTURE LEVELS (nearest support & resistance)
═══════════════════════════════════════════════════════
${payload.keyLevels || 'No key levels identified'}

  ⚠ SL MUST be placed BEYOND the nearest structure level, not mid-air.
  ⚠ TP MUST target the next structure level — do not set TP past resistance (BUY) or support (SELL).
  ⚠ If price is already AT a key level, factor this into entry type (LIMIT vs MARKET).

═══════════════════════════════════════════════════════
ADDITIONAL CONTEXT
═══════════════════════════════════════════════════════
News Sentiment:  ${payload.newsSentiment}
User Rules:      ${payload.ragContext || 'None provided'}
${payload.accuracyContext ? `Signal History:  ${payload.accuracyContext}` : ''}
${payload.tradingContext  ? `Personal Edge:   ${payload.tradingContext}`  : ''}

═══════════════════════════════════════════════════════
MANDATORY HOLD — output HOLD if ANY of these apply:
═══════════════════════════════════════════════════════
  ✗ confluenceScore < ${confluenceMin} (not enough indicators aligned)
  ✗ RSI > 70 with BUY signal, OR RSI < 30 with SELL signal (counter-extreme)
  ✗ MACD and RSI give OPPOSITE signals (momentum conflict — no edge)
  ✗ Cannot achieve R:R ≥ ${minRR} within SL rules
${isScalp ? `  ✗ ATR is too low to achieve minimum 5-pip profit target (no momentum)
  ✗ Price is not near a clear support/resistance level or EMA bounce point` :
`  ✗ ADX < 20 AND no strong candlestick reversal pattern (choppy market)
  ✗ Daily AND ${htfLabel} BOTH oppose the proposed signal direction
  ✗ Session Rating is AVOID`}

═══════════════════════════════════════════════════════
RISK MANAGEMENT (mandatory — ${isScalp ? 'SCALP' : 'SWING'} rules)
═══════════════════════════════════════════════════════
${isScalp ?
`  Stop Loss:   0.5× ATR or nearest micro-structure = ${minSL} minimum distance (3–8 pips)
  Take Profit: Target 5–15 pips from entry; min 1.5× SL distance = ${minTP}
  Entry Type:  MARKET preferred for scalps; LIMIT only if clear retrace expected
  R:R MUST be ≥ 1:1.5 for scalp. If not achievable, output HOLD.
  Time Horizon: 5–30 minutes. Do not hold through news events.` :
`  Stop Loss:   1.5× ATR beyond nearest swing = ${minSL} minimum distance
  Take Profit: 2.5× SL distance = ${minTP} minimum distance from entry
  Entry Type:  MARKET if price is at structure now; LIMIT if price should retrace first
  R:R MUST be ≥ 1:2. If not achievable, output HOLD.`}

═══════════════════════════════════════════════════════
AUTO-TRADE — set true only if ALL are true:
═══════════════════════════════════════════════════════
  1. signal = BUY or SELL
  2. confidence ≥ ${isScalp ? 65 : 72}
  3. confluenceScore ≥ ${isScalp ? 5 : 6}
  4. ADX ≥ ${adxThreshold}
  5. ${isScalp ? 'Price near EMA20/EMA50 or clear BB level (structure entry)' : `Both Daily AND ${htfLabel} agree with signal`}
  6. R:R ≥ ${minRR}
  7. Session is ${isScalp ? 'PRIME, ACTIVE, or AVOID (scalpers can trade any session with sufficient ATR)' : 'PRIME or ACTIVE'}
  8. No high-impact news within ${isScalp ? '15 minutes' : '1 hour'}

═══════════════════════════════════════════════════════
OUTPUT — valid JSON only, no markdown, no extra text
═══════════════════════════════════════════════════════
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "bullScore": 0-100,
  "bearScore": 0-100,
  "confluenceScore": 0-8,
  "entryType": "MARKET" | "LIMIT",
  "reasoning": "3-4 sentences. Must cite: (1) ${isScalp ? 'momentum and structure level for entry' : 'multi-TF bias alignment'}, (2) which indicators align or conflict, (3) exact entry/SL/TP price levels and why, (4) what would invalidate the setup.",
  "entry": number,
  "takeProfit": number,
  "stopLoss": number,
  "riskReward": "1:X.X",
  "keyRisks": ["risk1", "risk2"],
  "timeHorizon": "${isScalp ? 'e.g. 5-15 minutes' : 'e.g. 4-8 hours'}",
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
