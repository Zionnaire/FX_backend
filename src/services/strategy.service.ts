// src/services/strategy.service.ts
// Deterministic rule engine — decides signal direction from market structure,
// indicators, and session context WITHOUT involving the LLM.
//
// SCALP mode  — priority-based, structure-first:
//   HIGH   : CHOCH, liquidity sweep, BOS, OB, FVG, displacement candle (decide direction)
//   MEDIUM : ADX, session, ATR expansion (validate timing)
//   LOW    : RSI, MACD, stoch, EMA (confidence modifiers — NEVER block)
//
// SWING mode  — HTF-weighted flat scoring:
//   All factors contribute to bull/bear score; HTF bias carries highest weight.
//   Hard gates: ADX < 20, AVOID session, counter-weekly trend.

import { IOHLCV } from '../types/chart.types';
import { ValidPair } from '../types/chart.types';
import { Indicators } from './indicator.service';
import { MarketStructure } from './structure.service';
import { SessionRating } from '../types/signal.types';

export type TradingBias = 'bullish' | 'bearish' | 'neutral';

export interface StrategyDecision {
  signal:          'BUY' | 'SELL' | 'HOLD';
  reasons:         string[];
  blockers:        string[];
  bullScore:       number;      // 0–100
  bearScore:       number;      // 0–100
  confluenceScore: number;      // 0–8
  entryType:       'MARKET' | 'LIMIT';
  suggestedSL:     number | null;
  suggestedTP:     number | null;
}

export function extractBias(summary: string): TradingBias {
  if (summary.includes('BULLISH'))  return 'bullish';
  if (summary.includes('BEARISH'))  return 'bearish';
  return 'neutral';
}

const BULLISH_PATTERNS = new Set([
  'Bullish Engulfing', 'Hammer',
  'Three White Soldiers', 'Three Inside Up', 'Three Outside Up', 'Morning Star',
]);
const BEARISH_PATTERNS = new Set([
  'Bearish Engulfing', 'Shooting Star',
  'Three Black Crows', 'Three Inside Down', 'Three Outside Down', 'Evening Star',
]);

// ─── Public dispatcher ────────────────────────────────────────────────────────

export function runStrategy(
  candles:       IOHLCV[],
  indicators:    Indicators,
  structure:     MarketStructure,
  sessionRating: SessionRating,
  htfBias:       TradingBias,
  dailyBias:     TradingBias,
  weeklyBias:    TradingBias,
  pair:          ValidPair,
  tradingStyle:  'scalp' | 'swing',
  atrTrend:      'expanding' | 'contracting' | 'stable',
  macroBias?:    TradingBias,  // scalp-specific 1H/4H bias; falls back to htfBias
): StrategyDecision {
  if (tradingStyle === 'scalp') {
    return _runScalpStrategy(
      candles, indicators, structure, sessionRating,
      macroBias ?? htfBias, pair, atrTrend,
    );
  }
  return _runSwingStrategy(
    candles, indicators, structure, sessionRating,
    htfBias, dailyBias, weeklyBias, pair, atrTrend,
  );
}

// ─── SCALP ENGINE ─────────────────────────────────────────────────────────────
// Priority-based. Structure signals decide direction. Lagging indicators are
// confidence modifiers ONLY — they can never veto a valid structural setup.

function _runScalpStrategy(
  candles:       IOHLCV[],
  indicators:    Indicators,
  structure:     MarketStructure,
  sessionRating: SessionRating,
  macroBias:     TradingBias,  // 1H or 4H bias for the execution TF
  _pair:         ValidPair,
  atrTrend:      'expanding' | 'contracting' | 'stable',
): StrategyDecision {
  const lastCandle = candles[candles.length - 1];
  const price      = lastCandle.close;
  const reasons:   string[] = [];
  const blockers:  string[] = [];

  // ── Stage 1: Hard gates ────────────────────────────────────────────────────

  if (sessionRating === 'AVOID') {
    blockers.push('[SCALP] AVOID session — insufficient liquidity for scalp execution');
    console.info('[SCALP] BLOCKED | reason: AVOID session');
    return _hold(reasons, blockers, indicators);
  }

  if (indicators.adx < 12) {
    blockers.push(`[SCALP] ADX ${indicators.adx.toFixed(1)} < 12 — dead market, no directional momentum`);
    console.info(`[SCALP] BLOCKED | reason: ADX ${indicators.adx.toFixed(1)} below floor (12)`);
    return _hold(reasons, blockers, indicators);
  }

  if (atrTrend === 'contracting') {
    blockers.push('[SCALP] ATR contracting — shrinking volatility collapses scalp risk/reward');
    console.info('[SCALP] BLOCKED | reason: ATR contracting');
    return _hold(reasons, blockers, indicators);
  }

  // ── Stage 2: Structure scoring (HIGH PRIORITY — decides direction) ─────────

  let bullStruct = 0;
  let bearStruct = 0;
  let hasBullTrigger = false;
  let hasBearTrigger = false;

  // CHOCH — strongest signal; confirms reversal direction
  if (structure.latestCHOCH?.direction === 'bullish') {
    bullStruct += 30;
    hasBullTrigger = true;
    reasons.push(`[SCALP] CHOCH BULLISH @ ${structure.latestCHOCH.price.toFixed(5)} — reversal trigger confirmed`);
  } else if (structure.latestCHOCH?.direction === 'bearish') {
    bearStruct += 30;
    hasBearTrigger = true;
    reasons.push(`[SCALP] CHOCH BEARISH @ ${structure.latestCHOCH.price.toFixed(5)} — reversal trigger confirmed`);
  }

  // Liquidity sweep with reversal — stop-hunt entry signal
  const lastSweep = structure.liquiditySweeps[structure.liquiditySweeps.length - 1];
  if (lastSweep?.reversed) {
    if (lastSweep.direction === 'bullish') {
      bullStruct += 25;
      hasBullTrigger = true;
      reasons.push(`[SCALP] Liquidity sweep BULLISH @ ${lastSweep.sweptLevel.toFixed(5)} — buy-side stops swept, reversal due`);
    } else {
      bearStruct += 25;
      hasBearTrigger = true;
      reasons.push(`[SCALP] Liquidity sweep BEARISH @ ${lastSweep.sweptLevel.toFixed(5)} — sell-side stops swept, reversal due`);
    }
  }

  // BOS — structure continuation
  if (structure.latestBOS?.direction === 'bullish') {
    bullStruct += 15;
    hasBullTrigger = true;
    reasons.push('[SCALP] BOS BULLISH — bullish structure break, continuation bias');
  } else if (structure.latestBOS?.direction === 'bearish') {
    bearStruct += 15;
    hasBearTrigger = true;
    reasons.push('[SCALP] BOS BEARISH — bearish structure break, continuation bias');
  }

  // Order blocks (within 0.5% of midpoint)
  for (const ob of structure.orderBlocks) {
    const mid = (ob.high + ob.low) / 2;
    if (Math.abs(price - mid) / mid < 0.005) {
      if (ob.direction === 'bullish') {
        bullStruct += 15;
        hasBullTrigger = true;
        reasons.push(`[SCALP] At bullish OB ${ob.low.toFixed(5)}–${ob.high.toFixed(5)} — institutional demand zone`);
      } else {
        bearStruct += 15;
        hasBearTrigger = true;
        reasons.push(`[SCALP] At bearish OB ${ob.low.toFixed(5)}–${ob.high.toFixed(5)} — institutional supply zone`);
      }
    }
  }

  // FVG (within 0.3% of midpoint)
  for (const gap of structure.fairValueGaps) {
    const mid = (gap.top + gap.bottom) / 2;
    if (Math.abs(price - mid) / mid < 0.003) {
      if (gap.direction === 'bullish') {
        bullStruct += 10;
        hasBullTrigger = true;
        reasons.push(`[SCALP] At bullish FVG ${gap.bottom.toFixed(5)}–${gap.top.toFixed(5)} — imbalance fill`);
      } else {
        bearStruct += 10;
        hasBearTrigger = true;
        reasons.push(`[SCALP] At bearish FVG ${gap.bottom.toFixed(5)}–${gap.top.toFixed(5)} — imbalance fill`);
      }
    }
  }

  // Displacement candle (body > 1.5×ATR = institutional momentum candle)
  const candleBody = Math.abs(lastCandle.close - lastCandle.open);
  if (indicators.atr > 0 && candleBody > indicators.atr * 1.5) {
    if (lastCandle.close > lastCandle.open) {
      bullStruct += 8;
      hasBullTrigger = true;
      reasons.push(`[SCALP] Displacement candle BULLISH — body ${candleBody.toFixed(5)} > 1.5×ATR`);
    } else {
      bearStruct += 8;
      hasBearTrigger = true;
      reasons.push(`[SCALP] Displacement candle BEARISH — body ${candleBody.toFixed(5)} > 1.5×ATR`);
    }
  }

  // Candlestick patterns (lowest structure weight)
  for (const p of indicators.patterns) {
    if (BULLISH_PATTERNS.has(p))      { bullStruct += 5; hasBullTrigger = true; }
    else if (BEARISH_PATTERNS.has(p)) { bearStruct += 5; hasBearTrigger = true; }
  }

  console.info(`[SCALP] Stage 2 structure — bull: ${bullStruct}, bear: ${bearStruct}`);

  // ── Stage 3: Macro bias adjustment (scalar — NEVER a gate) ────────────────
  // Aligning with 1H/4H macro bias boosts confidence; opposing reduces it slightly.
  // A counter-trend structural setup is ALLOWED — the scalp engine does not block it.

  const isBullStruct     = bullStruct >= bearStruct;
  const structDirection  = isBullStruct ? 'bullish' : 'bearish';

  if (macroBias === structDirection) {
    if (isBullStruct) bullStruct = Math.round(bullStruct * 1.15);
    else              bearStruct = Math.round(bearStruct * 1.15);
    reasons.push(`[SCALP] Macro bias (1H/4H) ALIGNED with structure — confidence +15%`);
  } else if (macroBias !== 'neutral') {
    if (isBullStruct) bullStruct = Math.round(bullStruct * 0.90);
    else              bearStruct = Math.round(bearStruct * 0.90);
    reasons.push(`[SCALP] Macro bias (1H/4H) OPPOSED — counter-trend setup; confidence −10% (not blocked)`);
    console.info(`[SCALP] Counter-trend vs macro bias (${macroBias}) — structure score reduced 10%, setup still valid`);
  }

  // ── Stage 4: Momentum validation (MEDIUM PRIORITY) ────────────────────────

  let momentumScore = 0;

  if (indicators.adx >= 25)      { momentumScore += 20; reasons.push(`[SCALP] ADX ${indicators.adx.toFixed(1)} — strong trending momentum`); }
  else if (indicators.adx >= 20) { momentumScore += 15; }
  else if (indicators.adx >= 15) { momentumScore += 8; }
  // ADX 12–15: hard gate already cleared; gives partial credit only

  if (sessionRating === 'PRIME')       { momentumScore += 15; reasons.push('[SCALP] PRIME session — peak liquidity for execution'); }
  else if (sessionRating === 'ACTIVE') { momentumScore += 10; }

  if (atrTrend === 'expanding') { momentumScore += 10; reasons.push('[SCALP] ATR expanding — volatility increasing, momentum behind move'); }
  else if (atrTrend === 'stable') { momentumScore += 5; }

  if (structure.inDiscount && isBullStruct) { momentumScore += 5; reasons.push('[SCALP] Price in DISCOUNT zone — optimal BUY territory'); }
  if (structure.inPremium  && !isBullStruct) { momentumScore += 5; reasons.push('[SCALP] Price in PREMIUM zone — optimal SELL territory'); }

  console.info(`[SCALP] Stage 4 momentum: ${momentumScore}/50 (need ≥20)`);

  // ── Stage 5: Decision ──────────────────────────────────────────────────────

  const STRUCT_THRESHOLD   = 25;
  const MOMENTUM_THRESHOLD = 20;

  const dominantStruct    = Math.max(bullStruct, bearStruct);
  const signalDir         = isBullStruct ? 'BUY' : 'SELL';
  const hasTriggerForSide = signalDir === 'BUY' ? hasBullTrigger : hasBearTrigger;

  if (dominantStruct < STRUCT_THRESHOLD) {
    blockers.push(`[SCALP] HOLD: structure score ${dominantStruct} < ${STRUCT_THRESHOLD} — CHOCH, sweep, BOS, OB, or FVG needed`);
    console.info(`[SCALP] BLOCKED | reason: structure ${dominantStruct}/${STRUCT_THRESHOLD} — no dominant structural setup`);
    return _hold(reasons, blockers, indicators);
  }

  if (momentumScore < MOMENTUM_THRESHOLD) {
    blockers.push(`[SCALP] HOLD: momentum score ${momentumScore} < ${MOMENTUM_THRESHOLD} — ADX/session/ATR insufficient for execution`);
    console.info(`[SCALP] BLOCKED | reason: momentum ${momentumScore}/${MOMENTUM_THRESHOLD} | ADX=${indicators.adx.toFixed(1)}, session=${sessionRating}, ATR=${atrTrend}`);
    return _hold(reasons, blockers, indicators);
  }

  if (!hasTriggerForSide) {
    blockers.push(`[SCALP] HOLD: ${signalDir} structure confirmed but no immediate execution trigger (no OB/FVG/sweep/CHOCH at current price)`);
    console.info(`[SCALP] BLOCKED | reason: ${signalDir} setup formed but no execution trigger at current price`);
    return _hold(reasons, blockers, indicators);
  }

  // ── Stage 6: Confluence score (0–8, structure-focused) ────────────────────

  const sideDir = isBullStruct ? 'bullish' : 'bearish';
  let cs = 0;

  if (structure.latestCHOCH?.direction === sideDir)                cs++;
  if (lastSweep?.reversed && lastSweep.direction === sideDir)      cs++;
  if (structure.latestBOS?.direction === sideDir)                  cs++;

  const nearOB  = structure.orderBlocks.some((ob) => {
    const m = (ob.high + ob.low) / 2;
    return ob.direction === sideDir && Math.abs(price - m) / m < 0.005;
  });
  const nearFVG = structure.fairValueGaps.some((g) => {
    const m = (g.top + g.bottom) / 2;
    return g.direction === sideDir && Math.abs(price - m) / m < 0.003;
  });
  if (nearOB || nearFVG) cs++;

  if (indicators.adx >= 20)                                        cs++;
  if (sessionRating === 'PRIME' || sessionRating === 'ACTIVE')     cs++;
  if (macroBias === sideDir)                                       cs++;

  if (
    candleBody > indicators.atr * 1.5 &&
    ((isBullStruct && lastCandle.close > lastCandle.open) ||
     (!isBullStruct && lastCandle.close < lastCandle.open))
  ) cs++;

  const confluenceScore = Math.min(8, cs);
  console.info(`[SCALP] Confluence: ${confluenceScore}/8`);

  // ── Stage 7: Confidence modifiers (LOW PRIORITY — additive only) ──────────
  // RSI, MACD, stoch, EMA add to the final score for reporting. They CANNOT
  // subtract from the score and CANNOT block a trade that passed stages 1–5.

  let bullBonus = 0;
  let bearBonus = 0;

  // RSI
  if (indicators.rsi < 35)      bullBonus += 5;
  else if (indicators.rsi > 65) bearBonus += 5;
  else if (indicators.rsi < 45) bullBonus += 2;
  else if (indicators.rsi > 55) bearBonus += 2;

  // MACD histogram
  if (indicators.macd.histogram > 0) bullBonus += 3; else bearBonus += 3;

  // Stochastic
  if (indicators.stoch.k < 25)      bullBonus += 2;
  else if (indicators.stoch.k > 75) bearBonus += 2;

  // EMA alignment (context only — 3 points max across 3 EMAs)
  const ema200 = indicators.ema200 ?? indicators.ema50;
  if (price > indicators.ema20)  bullBonus += 1; else bearBonus += 1;
  if (price > indicators.ema50)  bullBonus += 1; else bearBonus += 1;
  if (price > ema200)            bullBonus += 1; else bearBonus += 1;

  console.info(`[SCALP] Stage 7 modifiers — bull: +${bullBonus}, bear: +${bearBonus} (lagging, additive only, no veto)`);
  console.info(`[SCALP] SIGNAL: ${signalDir} | struct=${dominantStruct} | momentum=${momentumScore} | confluence=${confluenceScore}/8`);

  // ── SL/TP hints ────────────────────────────────────────────────────────────

  let suggestedSL: number | null = null;
  let suggestedTP: number | null = null;

  if (isBullStruct) {
    const ob = structure.orderBlocks.find((b) => b.direction === 'bullish');
    if (ob) {
      suggestedSL = parseFloat((ob.low - indicators.atr * 0.2).toFixed(5));
    } else if (structure.swingLows.length > 0) {
      const sw = structure.swingLows[structure.swingLows.length - 1];
      suggestedSL = parseFloat((sw.price - indicators.atr * 0.2).toFixed(5));
    }
    const fvg = structure.fairValueGaps.find((g) => g.direction === 'bearish' && g.bottom > price);
    if (fvg) { suggestedTP = fvg.bottom; }
    else {
      const hi = structure.swingHighs.filter((h) => h.price > price).sort((a, b) => a.price - b.price)[0];
      if (hi) suggestedTP = hi.price;
    }
  } else {
    const ob = structure.orderBlocks.find((b) => b.direction === 'bearish');
    if (ob) {
      suggestedSL = parseFloat((ob.high + indicators.atr * 0.2).toFixed(5));
    } else if (structure.swingHighs.length > 0) {
      const sw = structure.swingHighs[structure.swingHighs.length - 1];
      suggestedSL = parseFloat((sw.price + indicators.atr * 0.2).toFixed(5));
    }
    const fvg = structure.fairValueGaps.find((g) => g.direction === 'bullish' && g.top < price);
    if (fvg) { suggestedTP = fvg.top; }
    else {
      const lo = structure.swingLows.filter((l) => l.price < price).sort((a, b) => b.price - a.price)[0];
      if (lo) suggestedTP = lo.price;
    }
  }

  return {
    signal:     signalDir,
    reasons,
    blockers,
    bullScore:  Math.min(100, Math.round(bullStruct + bullBonus)),
    bearScore:  Math.min(100, Math.round(bearStruct + bearBonus)),
    confluenceScore,
    entryType:  'MARKET',
    suggestedSL,
    suggestedTP,
  };
}

// ─── SWING ENGINE ─────────────────────────────────────────────────────────────
// HTF-weighted flat scoring. All factors contribute. Hard gates: ADX < 20,
// AVOID session, counter-weekly swing (no counter-trend swing trades).

function _runSwingStrategy(
  candles:       IOHLCV[],
  indicators:    Indicators,
  structure:     MarketStructure,
  sessionRating: SessionRating,
  htfBias:       TradingBias,
  dailyBias:     TradingBias,
  weeklyBias:    TradingBias,
  _pair:         ValidPair,
  atrTrend:      'expanding' | 'contracting' | 'stable',
): StrategyDecision {
  const price    = candles[candles.length - 1].close;
  const reasons:  string[] = [];
  const blockers: string[] = [];

  // ── Hard gates ─────────────────────────────────────────────────────────────

  if (sessionRating === 'AVOID') {
    blockers.push(`AVOID session — ${_pair} not tradeable here (low liquidity)`);
    return _hold(reasons, blockers, indicators);
  }

  if (indicators.adx < 20) {
    blockers.push(`ADX ${indicators.adx.toFixed(1)} < 20 — dead market, no directional bias`);
    return _hold(reasons, blockers, indicators);
  }

  // ── Directional scoring ────────────────────────────────────────────────────

  let bull = 0;
  let bear = 0;

  // CHOCH
  if (structure.latestCHOCH?.direction === 'bullish') {
    bull += 25;
    reasons.push(`CHOCH bullish @ ${structure.latestCHOCH.price.toFixed(5)} — structural reversal confirmed`);
  } else if (structure.latestCHOCH?.direction === 'bearish') {
    bear += 25;
    reasons.push(`CHOCH bearish @ ${structure.latestCHOCH.price.toFixed(5)} — structural reversal confirmed`);
  }

  // Structure trend
  if (structure.trend === 'bullish') {
    bull += 15;
    reasons.push('Structure: BULLISH (higher highs + higher lows)');
  } else if (structure.trend === 'bearish') {
    bear += 15;
    reasons.push('Structure: BEARISH (lower highs + lower lows)');
  }

  // BOS
  if (structure.latestBOS?.direction === 'bullish')      bull += 8;
  else if (structure.latestBOS?.direction === 'bearish') bear += 8;

  // Liquidity sweep
  const lastSweep = structure.liquiditySweeps[structure.liquiditySweeps.length - 1];
  if (lastSweep?.reversed) {
    if (lastSweep.direction === 'bullish') {
      bull += 12;
      reasons.push(`Liquidity sweep reversed BULLISH @ ${lastSweep.sweptLevel.toFixed(5)}`);
    } else {
      bear += 12;
      reasons.push(`Liquidity sweep reversed BEARISH @ ${lastSweep.sweptLevel.toFixed(5)}`);
    }
  }

  // HTF alignment
  if (weeklyBias === 'bullish') bull += 10; else if (weeklyBias === 'bearish') bear += 10;
  if (dailyBias  === 'bullish') bull += 10; else if (dailyBias  === 'bearish') bear += 10;
  if (htfBias    === 'bullish') bull += 8;  else if (htfBias    === 'bearish') bear += 8;

  // EMA stack
  const ema200 = indicators.ema200 ?? indicators.ema50;
  if (price > ema200)           bull += 5; else bear += 5;
  if (price > indicators.ema50) bull += 5; else bear += 5;
  if (price > indicators.ema20) bull += 3; else bear += 3;

  // MACD
  if (indicators.macd.histogram > 0) bull += 5; else bear += 5;

  // RSI
  if (indicators.rsi > 55 && indicators.rsi < 70)      bull += 5;
  else if (indicators.rsi < 45 && indicators.rsi > 30)  bear += 5;
  else if (indicators.rsi >= 70)                         bear += 3;
  else if (indicators.rsi <= 30)                         bull += 3;

  // Stochastic
  if (indicators.stoch.k < 30)      bull += 3;
  else if (indicators.stoch.k > 70) bear += 3;

  // ADX amplifier
  if (indicators.adx >= 30) {
    if (bull > bear) bull += 5; else bear += 5;
  }

  // Price zone
  if (structure.inDiscount) {
    bull += 5;
    if (bull > bear) reasons.push('Price in DISCOUNT zone — below equilibrium, BUY territory');
  } else if (structure.inPremium) {
    bear += 5;
    if (bear > bull) reasons.push('Price in PREMIUM zone — above equilibrium, SELL territory');
  }

  // ATR expansion
  if (atrTrend === 'expanding') {
    if (bull > bear) bull += 3; else bear += 3;
  }

  // Order blocks
  for (const ob of structure.orderBlocks) {
    const mid = (ob.high + ob.low) / 2;
    if (Math.abs(price - mid) / mid < 0.005) {
      if (ob.direction === 'bullish') {
        bull += 8;
        reasons.push(`At bullish OB ${ob.low.toFixed(5)}–${ob.high.toFixed(5)}`);
      } else {
        bear += 8;
        reasons.push(`At bearish OB ${ob.low.toFixed(5)}–${ob.high.toFixed(5)}`);
      }
    }
  }

  // FVGs
  for (const gap of structure.fairValueGaps) {
    const mid = (gap.top + gap.bottom) / 2;
    if (Math.abs(price - mid) / mid < 0.003) {
      if (gap.direction === 'bullish') {
        bull += 5;
        reasons.push(`At bullish FVG ${gap.bottom.toFixed(5)}–${gap.top.toFixed(5)}`);
      } else {
        bear += 5;
        reasons.push(`At bearish FVG ${gap.bottom.toFixed(5)}–${gap.top.toFixed(5)}`);
      }
    }
  }

  // Candlestick patterns
  for (const p of indicators.patterns) {
    if (BULLISH_PATTERNS.has(p))      bull += 4;
    else if (BEARISH_PATTERNS.has(p)) bear += 4;
  }

  // ── Confluence score (0–8) ─────────────────────────────────────────────────

  const isBull = bull >= bear;
  let cs = 0;

  if ((isBull && weeklyBias === 'bullish') || (!isBull && weeklyBias === 'bearish')) cs++;
  if ((isBull && dailyBias  === 'bullish') || (!isBull && dailyBias  === 'bearish')) cs++;
  if ((isBull && htfBias    === 'bullish') || (!isBull && htfBias    === 'bearish')) cs++;

  if (isBull && price > indicators.ema50 && price > indicators.ema20)       cs++;
  else if (!isBull && price < indicators.ema50 && price < indicators.ema20) cs++;

  if (isBull && indicators.rsi > 50 && indicators.rsi < 70)      cs++;
  else if (!isBull && indicators.rsi < 50 && indicators.rsi > 30) cs++;

  if (isBull && indicators.macd.histogram > 0)   cs++;
  else if (!isBull && indicators.macd.histogram < 0) cs++;

  if (indicators.adx >= 25) cs++;

  const sideDir = isBull ? 'bullish' : 'bearish';
  const hasTrigger =
    (lastSweep?.reversed && lastSweep.direction === sideDir) ||
    structure.orderBlocks.some((ob) => {
      const m = (ob.high + ob.low) / 2;
      return ob.direction === sideDir && Math.abs(price - m) / m < 0.005;
    }) ||
    structure.fairValueGaps.some((g) => {
      const m = (g.top + g.bottom) / 2;
      return g.direction === sideDir && Math.abs(price - m) / m < 0.003;
    }) ||
    indicators.patterns.some((p) => isBull ? BULLISH_PATTERNS.has(p) : BEARISH_PATTERNS.has(p));

  if (hasTrigger) cs++;

  const confluenceScore = Math.min(8, cs);

  // ── Signal decision ────────────────────────────────────────────────────────

  let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let entryType: 'MARKET' | 'LIMIT' = 'MARKET';

  if (bull - bear >= 30 && confluenceScore >= 4) {
    if (indicators.rsi > 72) {
      blockers.push(`BUY blocked: RSI ${indicators.rsi.toFixed(1)} > 72 (overbought — wait for pullback)`);
    } else {
      signal = 'BUY';
      if (weeklyBias === 'bearish') {
        // Counter-weekly BUY: valid trade, confidence penalised downstream (−10pts)
        reasons.push('Counter-trend BUY vs weekly BEARISH bias — confidence penalised −10pts; structure overrides');
      }
      if (!hasTrigger) {
        entryType = 'LIMIT';
        reasons.push('LIMIT entry — no immediate trigger; wait for retrace to OB/FVG');
      }
    }
  } else if (bear - bull >= 30 && confluenceScore >= 4) {
    if (indicators.rsi < 28) {
      blockers.push(`SELL blocked: RSI ${indicators.rsi.toFixed(1)} < 28 (oversold — wait for bounce)`);
    } else {
      signal = 'SELL';
      if (weeklyBias === 'bullish') {
        // Counter-weekly SELL: valid trade, confidence penalised downstream (−10pts)
        reasons.push('Counter-trend SELL vs weekly BULLISH bias — confidence penalised −10pts; structure overrides');
      }
      if (!hasTrigger) {
        entryType = 'LIMIT';
        reasons.push('LIMIT entry — no immediate trigger; wait for rally to OB/FVG');
      }
    }
  } else {
    if (confluenceScore < 4) {
      blockers.push(`HOLD: confluence ${confluenceScore}/4 — insufficient alignment`);
    } else {
      blockers.push(`HOLD: bull=${bull} bear=${bear} (spread ${Math.abs(bull - bear)} < 30 required)`);
    }
  }

  // ── Structure-based SL/TP hints ────────────────────────────────────────────

  let suggestedSL: number | null = null;
  let suggestedTP: number | null = null;

  if (signal === 'BUY') {
    const ob = structure.orderBlocks.find((b) => b.direction === 'bullish');
    if (ob) {
      suggestedSL = parseFloat((ob.low - indicators.atr * 0.25).toFixed(5));
    } else if (structure.swingLows.length > 0) {
      const sw = structure.swingLows[structure.swingLows.length - 1];
      suggestedSL = parseFloat((sw.price - indicators.atr * 0.25).toFixed(5));
    }
    const fvg = structure.fairValueGaps.find((g) => g.direction === 'bearish' && g.bottom > price);
    if (fvg) { suggestedTP = fvg.bottom; }
    else {
      const hi = structure.swingHighs.filter((h) => h.price > price).sort((a, b) => a.price - b.price)[0];
      if (hi) suggestedTP = hi.price;
    }
  } else if (signal === 'SELL') {
    const ob = structure.orderBlocks.find((b) => b.direction === 'bearish');
    if (ob) {
      suggestedSL = parseFloat((ob.high + indicators.atr * 0.25).toFixed(5));
    } else if (structure.swingHighs.length > 0) {
      const sw = structure.swingHighs[structure.swingHighs.length - 1];
      suggestedSL = parseFloat((sw.price + indicators.atr * 0.25).toFixed(5));
    }
    const fvg = structure.fairValueGaps.find((g) => g.direction === 'bullish' && g.top < price);
    if (fvg) { suggestedTP = fvg.top; }
    else {
      const lo = structure.swingLows.filter((l) => l.price < price).sort((a, b) => b.price - a.price)[0];
      if (lo) suggestedTP = lo.price;
    }
  }

  return {
    signal,
    reasons,
    blockers,
    bullScore:       Math.min(100, Math.round(bull)),
    bearScore:       Math.min(100, Math.round(bear)),
    confluenceScore,
    entryType,
    suggestedSL,
    suggestedTP,
  };
}

// ─── Shared HOLD factory ──────────────────────────────────────────────────────

function _hold(
  reasons:    string[],
  blockers:   string[],
  indicators: Indicators,
): StrategyDecision {
  return {
    signal:          'HOLD',
    reasons,
    blockers,
    bullScore:       indicators.rsi > 50 ? 38 : 28,
    bearScore:       indicators.rsi < 50 ? 38 : 28,
    confluenceScore: 0,
    entryType:       'MARKET',
    suggestedSL:     null,
    suggestedTP:     null,
  };
}
