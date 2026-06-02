// src/services/scanner.service.ts
// Multi-pair setup scanner.
//
// Runs the deterministic rule engine across all 4 pairs × configured timeframes
// in parallel, using cached OHLCV data. Does NOT call Groq — this is a lightweight
// "opportunity detector" that tells the trader WHERE to look, not WHAT to do.
//
// Each scan result is assigned an estimated quality tier using the same logic
// as the full signal flow (but without the AI confidence layer).
//
// Typical latency: <500ms when candles are cached (OHLCV TTL handles staleness).

import { getOHLCV } from './chart.service';
import { computeAll } from './indicator.service';
import { analyzeMarketStructure } from './structure.service';
import { runStrategy, extractBias } from './strategy.service';
import { atr as calcAtr } from '../utils/indicators.utils';
import { detectMarketRegime } from './tradeEvent.service';
import { utcHourToSession } from './tradeEvent.service';
import { VALID_PAIRS, ValidPair, ValidTimeframe } from '../types/chart.types';
import { SessionRating } from '../types/signal.types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScanHit {
  pair:             ValidPair;
  timeframe:        ValidTimeframe;
  signal:           'BUY' | 'SELL';
  estimated_tier:   'A+' | 'A' | 'B' | 'C';
  confluence_score: number;
  bias_aligned:     boolean;
  session:          string;
  session_rating:   SessionRating;
  regime:           string;
  structure_summary: string;
  reasons:          string[];
  scanned_at:       string;
}

export interface ScanSummary {
  scanned_at:    string;
  pairs_scanned: number;
  setups_found:  number;
  best_setup:    ScanHit | null;
  all_hits:      ScanHit[];
  scan_errors:   string[];
}

// ─── Configuration ────────────────────────────────────────────────────────────

const SCALP_TIMEFRAMES: ValidTimeframe[] = ['1m', '5m', '15m'];
const SWING_TIMEFRAMES: ValidTimeframe[] = ['1h', '4h', '1d'];

const HIGHER_TF: Record<ValidTimeframe, ValidTimeframe> = {
  '1m': '15m', '5m': '1h', '15m': '1h', '1h': '4h', '4h': '1d', '1d': '1d',
};

// ─── Main scanner ─────────────────────────────────────────────────────────────

export async function scanAllPairs(
  tradingStyle: 'scalp' | 'swing' = 'swing',
): Promise<ScanSummary> {
  const timeframes = tradingStyle === 'scalp' ? SCALP_TIMEFRAMES : SWING_TIMEFRAMES;
  const utcHour    = new Date().getUTCHours();
  const session    = utcHourToSession(utcHour);
  const errors: string[] = [];

  // Run all pair × timeframe combinations in parallel
  const tasks = VALID_PAIRS.flatMap((pair) =>
    timeframes.map((tf) => _scanSingle(pair, tf, tradingStyle, utcHour, session, errors)),
  );

  const results  = await Promise.allSettled(tasks);
  const allHits: ScanHit[] = results
    .filter((r): r is PromiseFulfilledResult<ScanHit | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((h): h is ScanHit => h !== null);

  // Sort: A+ first, then by confluence score descending
  allHits.sort((a, b) => {
    const tierRank = { 'A+': 4, 'A': 3, 'B': 2, 'C': 1 };
    const td = tierRank[b.estimated_tier] - tierRank[a.estimated_tier];
    return td !== 0 ? td : b.confluence_score - a.confluence_score;
  });

  return {
    scanned_at:    new Date().toISOString(),
    pairs_scanned: VALID_PAIRS.length * timeframes.length,
    setups_found:  allHits.length,
    best_setup:    allHits[0] ?? null,
    all_hits:      allHits,
    scan_errors:   errors,
  };
}

// ─── Single pair + timeframe scan ────────────────────────────────────────────

async function _scanSingle(
  pair:    ValidPair,
  tf:      ValidTimeframe,
  style:   'scalp' | 'swing',
  utcHour: number,
  session: string,
  errors:  string[],
): Promise<ScanHit | null> {
  try {
    const candles = await getOHLCV(pair, tf);
    if (candles.length < 30) return null;

    const indicators = computeAll(candles);
    if (!indicators || indicators.atr === 0) return null;

    const structure = analyzeMarketStructure(candles);
    const last      = candles[candles.length - 1];

    // ATR trend
    let atrTrend: 'expanding' | 'contracting' | 'stable' = 'stable';
    if (candles.length >= 20) {
      const prev = calcAtr(candles.slice(0, -5));
      if (prev > 0) {
        const pct = (indicators.atr - prev) / prev;
        atrTrend = pct > 0.15 ? 'expanding' : pct < -0.15 ? 'contracting' : 'stable';
      }
    }

    // HTF bias (simplified — from EMA stack, no external fetch needed for scan speed)
    const ema200     = indicators.ema200 ?? indicators.ema50;
    const htfBias    = extractBias(last.close > ema200 ? 'BULLISH' : 'BEARISH');
    const dailyBias  = extractBias(last.close > indicators.ema50 ? 'BULLISH' : 'BEARISH');
    const weeklyBias = htfBias;

    // Session rating (simple hour-based, avoids import cycle)
    const sessionRating = _sessionRating(pair, utcHour);

    // Run strategy engine
    const decision = runStrategy(
      candles, indicators, structure,
      sessionRating, htfBias, dailyBias, weeklyBias,
      pair, style, atrTrend,
    );

    if (decision.signal === 'HOLD') return null;

    // Estimate quality tier
    const htfSignal   = decision.signal;
    const biasAligned = !(
      (htfSignal === 'BUY'  && htfBias === 'bearish') ||
      (htfSignal === 'SELL' && htfBias === 'bullish')
    );
    const tier = _estimateTier(decision.confluenceScore, biasAligned);

    // Regime
    const regime = detectMarketRegime(indicators, structure, atrTrend, false);

    return {
      pair,
      timeframe:         tf,
      signal:            decision.signal,
      estimated_tier:    tier,
      confluence_score:  decision.confluenceScore,
      bias_aligned:      biasAligned,
      session,
      session_rating:    sessionRating,
      regime,
      structure_summary: structure.summary ?? structure.trend,
      reasons:           decision.reasons.slice(0, 5),
      scanned_at:        new Date().toISOString(),
    };
  } catch (err) {
    errors.push(`${pair}/${tf}: ${(err as Error).message}`);
    return null;
  }
}

// ─── Tier estimation (no Groq) ────────────────────────────────────────────────

function _estimateTier(
  confluenceScore: number,
  biasAligned:     boolean,
): 'A+' | 'A' | 'B' | 'C' {
  if (confluenceScore >= 7 && biasAligned)  return 'A+';
  if (confluenceScore >= 5 && biasAligned)  return 'A';
  if (confluenceScore >= 3)                  return 'B';
  return 'C';
}

function _sessionRating(pair: ValidPair, h: number): SessionRating {
  if (pair === 'XAU/USD') {
    if ((h >= 7 && h < 12) || (h >= 13 && h < 16)) return 'PRIME';
    if (h >= 12 && h < 20) return 'ACTIVE';
    return 'AVOID';
  }
  if (h >= 13 && h < 17) return 'PRIME';
  if (h >= 7  && h < 17) return 'ACTIVE';
  return 'AVOID';
}
