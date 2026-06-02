// src/services/scalp-execution.service.ts
// Execution trigger validation layer for scalp mode.
//
// Called AFTER strategy.service.ts has decided BUY/SELL direction.
// Validates that a candle-close-confirmed execution condition exists before
// routing to Groq. Enforces spread gates, cooldowns, and news lockouts.
//
// Trigger priority (first confirmed wins, then scored):
//   LIQUIDITY_RECLAIM  — highest conviction: sweep + close reclaim
//   BOS_CLOSE          — structure break confirmed on close
//   OB_MITIGATION      — institutional demand/supply zone reaction
//   FVG_REJECTION      — imbalance respect (wick into gap, close out/inside)
//   DISPLACEMENT_CLOSE — momentum candle body > 1.5×ATR
//   ENGULFING          — body engulfs previous candle
//
// Anti-repaint rule: ALL triggers require candle CLOSE confirmation.
// Wick-only touches are detected and explicitly blocked.

import { Types } from 'mongoose';
import Signal from '../models/Signal.model';
import { IOHLCV, ValidPair } from '../types/chart.types';
import { Indicators } from './indicator.service';
import { MarketStructure } from './structure.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TriggerType =
  | 'LIQUIDITY_RECLAIM'
  | 'BOS_CLOSE'
  | 'OB_MITIGATION'
  | 'FVG_REJECTION'
  | 'DISPLACEMENT_CLOSE'
  | 'ENGULFING'
  | 'NONE';

export interface ExecutionTrigger {
  type:        TriggerType;
  confirmed:   boolean;   // all conditions met on candle close
  candleClose: boolean;   // true = close-confirmed; false = wick-only (repaint risk)
  quality:     number;    // 0–100
  reasons:     string[];  // why it triggered
  blockers:    string[];  // why it was rejected
}

export interface RetestScore {
  rejectionStrength: number;  // 0–100: wick size at zone
  retracementDepth:  number;  // 0–100: premium/discount zone context
  mitigationQuality: number;  // 0–100: precision of OB entry
  imbalanceRespect:  number;  // 0–100: FVG boundary interaction
  total:             number;  // weighted composite
}

export interface ScalpExecutionParams {
  candles:         IOHLCV[];
  indicators:      Indicators;
  structure:       MarketStructure;
  signal:          'BUY' | 'SELL';
  pair:            ValidPair;
  userId:          string;
  currentSpread?:  number;   // from broker tick feed; absent = check skipped
  upcomingEvents?: Array<{ date: string; country: string; title: string }>;
}

export interface ScalpExecutionResult {
  canExecute:      boolean;
  trigger:         ExecutionTrigger;
  retestScore:     RetestScore;
  spreadBlocked:   boolean;
  cooldownBlocked: boolean;
  newsBlocked:     boolean;
  executionReason: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Max acceptable spread per pair (broker feed unit: same as price)
const MAX_SPREAD: Record<ValidPair, number> = {
  'XAU/USD': 0.50,    // 50 cents
  'GBP/USD': 0.00020, // 2.0 pips
  'EUR/USD': 0.00015, // 1.5 pips
  'USD/JPY': 0.040,   // 4 pips (JPY 2dp)
};

// Cooldown: no same-direction re-entry within this window
const DIRECTION_COOLDOWN_MS = 5  * 60 * 1000;
// Chop: if ≥ N BUY/SELL signals in the last CHOP_WINDOW_MS → market is choppy
const CHOP_WINDOW_MS        = 20 * 60 * 1000;
const CHOP_SIGNAL_LIMIT     = 3;
// News lockout: block within this window before AND after a high-impact event
const NEWS_DANGER_MIN       = 15;
// Minimum trigger quality to allow entry
const MIN_TRIGGER_QUALITY   = 40;
// Minimum retest score to allow entry
const MIN_RETEST_SCORE      = 25;

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function evaluateScalpExecution(
  params: ScalpExecutionParams,
): Promise<ScalpExecutionResult> {
  const { candles, indicators, structure, signal, pair, userId, currentSpread, upcomingEvents } = params;

  // Hard gate 1: spread
  const spreadBlocked = _checkSpread(pair, currentSpread);
  if (spreadBlocked) {
    const reason = `[SCALP-EXEC] BLOCKED: spread ${currentSpread} exceeds max ${MAX_SPREAD[pair]} for ${pair}`;
    console.info(reason);
    return _blocked(reason, true, false, false);
  }

  // Hard gate 2: news lockout
  const newsBlocked = _checkNewsLockout(upcomingEvents ?? []);
  if (newsBlocked) {
    const reason = `[SCALP-EXEC] BLOCKED: high-impact event within ${NEWS_DANGER_MIN}min lockout window`;
    console.info(reason);
    return _blocked(reason, false, false, true);
  }

  // Hard gate 3: trade cooldown (async DB check)
  const { cooldownBlocked, cooldownReason } = await _checkCooldown(userId, pair, signal);
  if (cooldownBlocked) {
    console.info(cooldownReason);
    return _blocked(cooldownReason, false, true, false);
  }

  // Trigger detection and retest scoring (pure computation — fast)
  const trigger     = _detectExecutionTrigger(candles, indicators, structure, signal);
  const retestScore = _scoreRetest(candles, indicators, structure, signal);

  console.info(
    `[SCALP-EXEC] Trigger=${trigger.type} confirmed=${trigger.confirmed} quality=${trigger.quality} | retest=${retestScore.total} (rej=${retestScore.rejectionStrength} ret=${retestScore.retracementDepth} mit=${retestScore.mitigationQuality} fvg=${retestScore.imbalanceRespect})`
  );

  if (!trigger.confirmed) {
    const reason = `[SCALP-EXEC] BLOCKED: no candle-close execution trigger for ${signal} — ${trigger.blockers.join(' | ')}`;
    console.info(reason);
    return { canExecute: false, trigger, retestScore, spreadBlocked: false, cooldownBlocked: false, newsBlocked: false, executionReason: reason };
  }

  if (trigger.quality < MIN_TRIGGER_QUALITY) {
    const reason = `[SCALP-EXEC] BLOCKED: trigger ${trigger.type} quality ${trigger.quality} < ${MIN_TRIGGER_QUALITY} minimum`;
    console.info(reason);
    return { canExecute: false, trigger, retestScore, spreadBlocked: false, cooldownBlocked: false, newsBlocked: false, executionReason: reason };
  }

  if (retestScore.total < MIN_RETEST_SCORE) {
    const reason = `[SCALP-EXEC] BLOCKED: retest score ${retestScore.total} < ${MIN_RETEST_SCORE} — zone interaction quality too low`;
    console.info(reason);
    return { canExecute: false, trigger, retestScore, spreadBlocked: false, cooldownBlocked: false, newsBlocked: false, executionReason: reason };
  }

  const executionReason =
    `[SCALP-EXEC] ${signal} APPROVED — trigger: ${trigger.type} (quality=${trigger.quality}) | retest: ${retestScore.total}/100 | ${trigger.reasons[0] ?? ''}`;
  console.info(executionReason);

  return { canExecute: true, trigger, retestScore, spreadBlocked: false, cooldownBlocked: false, newsBlocked: false, executionReason };
}

// ─── Trigger detection ────────────────────────────────────────────────────────

function _detectExecutionTrigger(
  candles:    IOHLCV[],
  indicators: Indicators,
  structure:  MarketStructure,
  signal:     'BUY' | 'SELL',
): ExecutionTrigger {
  const last     = candles[candles.length - 1];
  const prev     = candles.length >= 2 ? candles[candles.length - 2] : last;
  const price    = last.close;
  const atr      = indicators.atr;
  const sideDir  = signal === 'BUY' ? 'bullish' : 'bearish';
  const isBuy    = signal === 'BUY';

  const confirmed: ExecutionTrigger[] = [];
  const rejected:  ExecutionTrigger[] = [];

  // ── LIQUIDITY_RECLAIM ───────────────────────────────────────────────────────
  // Stop-hunt: price swept a swing level and closed BACK THROUGH it.
  // This is the highest-conviction scalp trigger — institutional reversal.
  {
    const sweep = structure.liquiditySweeps[structure.liquiditySweeps.length - 1];
    if (sweep?.reversed && sweep.direction === sideDir) {
      const reclaimed = isBuy
        ? last.close > sweep.sweptLevel
        : last.close < sweep.sweptLevel;
      const wickOnly = isBuy
        ? last.high > sweep.sweptLevel && last.close <= sweep.sweptLevel
        : last.low  < sweep.sweptLevel && last.close >= sweep.sweptLevel;

      if (wickOnly) {
        rejected.push({
          type: 'LIQUIDITY_RECLAIM', confirmed: false, candleClose: false, quality: 0,
          reasons: [],
          blockers: [`[REPAINT] Liquidity reclaim wick-only @ ${sweep.sweptLevel.toFixed(5)} — close did not confirm, not yet traded`],
        });
      } else if (reclaimed) {
        const dist    = Math.abs(price - sweep.sweptLevel);
        const quality = Math.min(100, Math.round(60 + (dist / Math.max(atr, 0.0001)) * 40));
        confirmed.push({
          type: 'LIQUIDITY_RECLAIM', confirmed: true, candleClose: true, quality,
          reasons: [`Liquidity reclaim @ ${sweep.sweptLevel.toFixed(5)} — close ${isBuy ? 'above' : 'below'} swept level confirms reversal (${dist.toFixed(5)} clearance)`],
          blockers: [],
        });
      }
    }
  }

  // ── BOS_CLOSE ───────────────────────────────────────────────────────────────
  // Structure break confirmed by candle CLOSE — not a wick poke through the level.
  {
    if (structure.latestBOS?.direction === sideDir) {
      const bosLevel  = structure.latestBOS.price;
      const closedThrough = isBuy ? last.close > bosLevel : last.close < bosLevel;
      const wickOnly      = isBuy
        ? last.high > bosLevel && last.close <= bosLevel
        : last.low  < bosLevel && last.close >= bosLevel;

      if (wickOnly) {
        rejected.push({
          type: 'BOS_CLOSE', confirmed: false, candleClose: false, quality: 0,
          reasons: [],
          blockers: [`[REPAINT] BOS wick-only @ ${bosLevel.toFixed(5)} — close did not confirm break (anti-repaint)`],
        });
      } else if (closedThrough) {
        const dist    = Math.abs(price - bosLevel);
        const quality = Math.min(100, Math.round(45 + (dist / Math.max(atr, 0.0001)) * 50));
        confirmed.push({
          type: 'BOS_CLOSE', confirmed: true, candleClose: true, quality,
          reasons: [`${sideDir.toUpperCase()} BOS confirmed on close @ ${price.toFixed(5)} (level ${bosLevel.toFixed(5)}, clearance ${dist.toFixed(5)})`],
          blockers: [],
        });
      }
    }
  }

  // ── OB_MITIGATION ───────────────────────────────────────────────────────────
  // Price entered an institutional OB zone and the candle CLOSE confirms demand/supply holding.
  // Wick below OB low (BUY) / above OB high (SELL) with close inside = rejection confirmation.
  for (const ob of structure.orderBlocks) {
    if (ob.direction !== sideDir) continue;
    const inZone  = last.low <= ob.high && last.high >= ob.low;
    if (!inZone) continue;

    const obSize = ob.high - ob.low;
    if (obSize <= 0) continue;

    if (isBuy) {
      const closeInsideOrAbove = last.close >= ob.low;
      const wickFailure        = last.low < ob.low && last.close < ob.low;

      if (wickFailure) {
        rejected.push({
          type: 'OB_MITIGATION', confirmed: false, candleClose: false, quality: 0,
          reasons: [],
          blockers: [`[REPAINT] Bullish OB wick-close failure @ ${ob.low.toFixed(5)} — close below OB (demand broke down)`],
        });
      } else if (closeInsideOrAbove) {
        // Optimal entry: close near bottom of OB = maximum distance to TP
        const distFromOptimal = Math.abs(last.close - ob.low) / obSize;
        const quality         = Math.min(100, Math.round(55 + (1 - Math.min(1, distFromOptimal)) * 45));
        confirmed.push({
          type: 'OB_MITIGATION', confirmed: true, candleClose: true, quality,
          reasons: [`Bullish OB mitigated @ ${ob.low.toFixed(5)}–${ob.high.toFixed(5)}, close ${last.close.toFixed(5)} confirms demand zone holding`],
          blockers: [],
        });
      }
    } else {
      const closeInsideOrBelow = last.close <= ob.high;
      const wickFailure        = last.high > ob.high && last.close > ob.high;

      if (wickFailure) {
        rejected.push({
          type: 'OB_MITIGATION', confirmed: false, candleClose: false, quality: 0,
          reasons: [],
          blockers: [`[REPAINT] Bearish OB wick-close failure @ ${ob.high.toFixed(5)} — close above OB (supply broke down)`],
        });
      } else if (closeInsideOrBelow) {
        const distFromOptimal = Math.abs(last.close - ob.high) / obSize;
        const quality         = Math.min(100, Math.round(55 + (1 - Math.min(1, distFromOptimal)) * 45));
        confirmed.push({
          type: 'OB_MITIGATION', confirmed: true, candleClose: true, quality,
          reasons: [`Bearish OB mitigated @ ${ob.low.toFixed(5)}–${ob.high.toFixed(5)}, close ${last.close.toFixed(5)} confirms supply zone holding`],
          blockers: [],
        });
      }
    }
  }

  // ── FVG_REJECTION ───────────────────────────────────────────────────────────
  // Price enters a Fair Value Gap. Valid triggers:
  //   (a) Wick poke into FVG + close back outside = strong rejection
  //   (b) Close inside FVG at optimal boundary = zone fill entry
  for (const gap of structure.fairValueGaps) {
    if (gap.direction !== sideDir) continue;
    const fvgSize = gap.top - gap.bottom;
    if (fvgSize <= 0) continue;
    const touched = last.low <= gap.top && last.high >= gap.bottom;
    if (!touched) continue;

    if (isBuy) {
      const closedAboveFVGTop    = last.close > gap.top;    // full fill + exit = strong
      const closedInsideFVG      = last.close >= gap.bottom && last.close <= gap.top;
      const wickBelowClose       = last.low < gap.bottom && last.close > gap.bottom; // wick through, close back
      const closeBelow           = last.close < gap.bottom;

      if (closeBelow) {
        rejected.push({
          type: 'FVG_REJECTION', confirmed: false, candleClose: false, quality: 0,
          reasons: [],
          blockers: [`FVG_REJECTION: close ${last.close.toFixed(5)} below bullish FVG bottom ${gap.bottom.toFixed(5)} — FVG invalidated`],
        });
      } else if (wickBelowClose) {
        confirmed.push({
          type: 'FVG_REJECTION', confirmed: true, candleClose: true, quality: 80,
          reasons: [`Bullish FVG swept-and-reclaimed: wick below ${gap.bottom.toFixed(5)}, close at ${last.close.toFixed(5)} — demand holding`],
          blockers: [],
        });
      } else if (closedAboveFVGTop) {
        confirmed.push({
          type: 'FVG_REJECTION', confirmed: true, candleClose: true, quality: 70,
          reasons: [`Bullish FVG fully filled and closed above ${gap.top.toFixed(5)} — imbalance resolved, continuation`],
          blockers: [],
        });
      } else if (closedInsideFVG) {
        const posInGap = (last.close - gap.bottom) / fvgSize;
        const quality  = Math.round(Math.max(40, 65 - posInGap * 30)); // lower in gap = better buy
        confirmed.push({
          type: 'FVG_REJECTION', confirmed: true, candleClose: true, quality,
          reasons: [`Inside bullish FVG ${gap.bottom.toFixed(5)}–${gap.top.toFixed(5)} at ${(posInGap * 100).toFixed(0)}% depth — imbalance fill entry`],
          blockers: [],
        });
      }
    } else {
      const closedBelowFVGBottom = last.close < gap.bottom;
      const closedInsideFVG      = last.close >= gap.bottom && last.close <= gap.top;
      const wickAboveClose       = last.high > gap.top && last.close < gap.top;
      const closeAbove           = last.close > gap.top;

      if (closeAbove) {
        rejected.push({
          type: 'FVG_REJECTION', confirmed: false, candleClose: false, quality: 0,
          reasons: [],
          blockers: [`FVG_REJECTION: close ${last.close.toFixed(5)} above bearish FVG top ${gap.top.toFixed(5)} — FVG invalidated`],
        });
      } else if (wickAboveClose) {
        confirmed.push({
          type: 'FVG_REJECTION', confirmed: true, candleClose: true, quality: 80,
          reasons: [`Bearish FVG swept-and-reclaimed: wick above ${gap.top.toFixed(5)}, close at ${last.close.toFixed(5)} — supply holding`],
          blockers: [],
        });
      } else if (closedBelowFVGBottom) {
        confirmed.push({
          type: 'FVG_REJECTION', confirmed: true, candleClose: true, quality: 70,
          reasons: [`Bearish FVG fully filled and closed below ${gap.bottom.toFixed(5)} — continuation`],
          blockers: [],
        });
      } else if (closedInsideFVG) {
        const posInGap = (gap.top - last.close) / fvgSize;
        const quality  = Math.round(Math.max(40, 65 - posInGap * 30));
        confirmed.push({
          type: 'FVG_REJECTION', confirmed: true, candleClose: true, quality,
          reasons: [`Inside bearish FVG ${gap.bottom.toFixed(5)}–${gap.top.toFixed(5)} at ${(posInGap * 100).toFixed(0)}% depth`],
          blockers: [],
        });
      }
    }
  }

  // ── DISPLACEMENT_CLOSE ─────────────────────────────────────────────────────
  // Institutional momentum: large-body candle close (> 1.5×ATR) in signal direction.
  // Body only — wick size irrelevant. Close is what matters.
  {
    const body         = Math.abs(last.close - last.open);
    const isBullBody   = last.close > last.open;
    const isBearBody   = last.close < last.open;
    const sizeOk       = atr > 0 && body > atr * 1.5;
    const dirAligned   = isBuy ? isBullBody : isBearBody;

    if (sizeOk && dirAligned) {
      const ratio   = atr > 0 ? body / atr : 1;
      const quality = Math.min(100, Math.round(40 + ratio * 15));
      confirmed.push({
        type: 'DISPLACEMENT_CLOSE', confirmed: true, candleClose: true, quality,
        reasons: [`Displacement ${isBuy ? 'bullish' : 'bearish'} close — body ${body.toFixed(5)} = ${ratio.toFixed(1)}×ATR`],
        blockers: [],
      });
    } else if (sizeOk && !dirAligned) {
      rejected.push({
        type: 'DISPLACEMENT_CLOSE', confirmed: false, candleClose: true, quality: 0,
        reasons: [],
        blockers: [`Displacement candle body direction opposes ${signal} signal`],
      });
    }
  }

  // ── ENGULFING ──────────────────────────────────────────────────────────────
  // Last candle body engulfs the previous candle body. Close-confirmed by definition.
  {
    const lastBody  = Math.abs(last.close - last.open);
    const prevBody  = Math.abs(prev.close - prev.open);
    const prevBull  = prev.close >= prev.open;
    const lastBull  = last.close >= last.open;

    // Bullish engulf: bearish prev candle, bullish current, body engulfs
    const bullEngulf = lastBull && !prevBull
      && lastBody > prevBody * 1.05
      && last.close > prev.open
      && last.open  < prev.close;

    // Bearish engulf: bullish prev, bearish current, body engulfs
    const bearEngulf = !lastBull && prevBull
      && lastBody > prevBody * 1.05
      && last.close < prev.open
      && last.open  > prev.close;

    const engulfs = isBuy ? bullEngulf : bearEngulf;
    if (engulfs) {
      const engulfRatio = prevBody > 0 ? lastBody / prevBody : 1;
      const quality     = Math.min(100, Math.round(40 + engulfRatio * 12));
      confirmed.push({
        type: 'ENGULFING', confirmed: true, candleClose: true, quality,
        reasons: [`${isBuy ? 'Bullish' : 'Bearish'} engulfing — body ${(engulfRatio * 100).toFixed(0)}% of previous candle`],
        blockers: [],
      });
    }
  }

  // ── Select best trigger ────────────────────────────────────────────────────
  if (confirmed.length > 0) {
    confirmed.sort((a, b) => b.quality - a.quality);
    const best = confirmed[0];
    // Merge reasons from additional confirmed triggers for richer logging
    if (confirmed.length > 1) {
      best.reasons.push(
        ...confirmed.slice(1).flatMap((t) => t.reasons).map((r) => `+ ${r}`),
      );
      // Multi-trigger bonus: capped at 100
      best.quality = Math.min(100, Math.round(best.quality + (confirmed.length - 1) * 5));
    }
    return best;
  }

  // No confirmed trigger — aggregate all rejection reasons
  const blockers = [
    ...rejected.flatMap((t) => t.blockers),
  ];
  if (blockers.length === 0) {
    blockers.push(
      `[SCALP-EXEC] No ${signal} execution trigger at current price — structure setup valid but no BOS/OB/FVG/displacement/engulf trigger confirmed on candle close`,
    );
  }

  return {
    type: 'NONE', confirmed: false, candleClose: false, quality: 0,
    reasons: [], blockers,
  };
}

// ─── Retest quality scoring ───────────────────────────────────────────────────

function _scoreRetest(
  candles:    IOHLCV[],
  indicators: Indicators,
  structure:  MarketStructure,
  signal:     'BUY' | 'SELL',
): RetestScore {
  const last     = candles[candles.length - 1];
  const price    = last.close;
  const range    = last.high - last.low;
  const sideDir  = signal === 'BUY' ? 'bullish' : 'bearish';
  const isBuy    = signal === 'BUY';

  // Rejection strength — size of the rejection wick at the zone
  // BUY: lower wick (swept lows and came back up) = good rejection
  // SELL: upper wick (swept highs and came back down) = good rejection
  let rejectionStrength = 50;
  if (range > 0) {
    if (isBuy) {
      const bodyBottom = Math.min(last.open, last.close);
      const lowerWick  = bodyBottom - last.low;
      rejectionStrength = Math.min(100, Math.round((lowerWick / range) * 150));
    } else {
      const bodyTop   = Math.max(last.open, last.close);
      const upperWick = last.high - bodyTop;
      rejectionStrength = Math.min(100, Math.round((upperWick / range) * 150));
    }
  }

  // Retracement depth — premium/discount context as proxy
  // Ideal BUY setup: price is in DISCOUNT zone (deep retracement = better value)
  // Ideal SELL setup: price is in PREMIUM zone
  let retracementDepth = 50;
  if (isBuy) {
    if (structure.inDiscount)       retracementDepth = 85;
    else if (!structure.inPremium)  retracementDepth = 60;
    else                            retracementDepth = 20;  // buying at premium = poor retracement
  } else {
    if (structure.inPremium)        retracementDepth = 85;
    else if (!structure.inDiscount) retracementDepth = 60;
    else                            retracementDepth = 20;  // selling at discount = poor
  }

  // Mitigation quality — precision of OB entry
  // Optimal: close at OB boundary (low for BUY, high for SELL)
  let mitigationQuality = 50;
  const ob = structure.orderBlocks.find((b) => b.direction === sideDir);
  if (ob && ob.high > ob.low) {
    const obSize     = ob.high - ob.low;
    const optimal    = isBuy ? ob.low : ob.high;
    const dist       = Math.abs(price - optimal);
    mitigationQuality = Math.max(10, Math.round(100 - (dist / obSize) * 60));
  }

  // Imbalance respect — how price interacted with the FVG boundary
  let imbalanceRespect = 50;
  const fvg = structure.fairValueGaps.find((g) => g.direction === sideDir);
  if (fvg && fvg.top > fvg.bottom) {
    const fvgSize = fvg.top - fvg.bottom;
    if (isBuy) {
      if (price < fvg.bottom) {
        // Price broke below FVG → FVG not respected → low score
        imbalanceRespect = 20;
      } else {
        const posInGap = (price - fvg.bottom) / fvgSize; // 0 = at bottom, 1 = at top
        // Better score when closer to bottom of bullish FVG
        imbalanceRespect = Math.round(Math.max(30, 95 - posInGap * 50));
      }
    } else {
      if (price > fvg.top) {
        imbalanceRespect = 20;
      } else {
        const posInGap = (fvg.top - price) / fvgSize;
        imbalanceRespect = Math.round(Math.max(30, 95 - posInGap * 50));
      }
    }
  }

  const total = Math.round(
    rejectionStrength * 0.35 +
    retracementDepth  * 0.25 +
    mitigationQuality * 0.25 +
    imbalanceRespect  * 0.15,
  );

  return { rejectionStrength, retracementDepth, mitigationQuality, imbalanceRespect, total };
}

// ─── Spread protection ────────────────────────────────────────────────────────
// currentSpread comes from broker tick feed (bid/ask difference).
// OHLCV data does not carry spread — if absent, the check is skipped (fail-open).

function _checkSpread(pair: ValidPair, currentSpread?: number): boolean {
  if (currentSpread === undefined || currentSpread <= 0) {
    console.info('[SCALP-EXEC] Spread data unavailable (no broker feed) — spread check skipped');
    return false;
  }
  const maxAllowed = MAX_SPREAD[pair];
  if (currentSpread > maxAllowed) {
    console.info(`[SCALP-EXEC] Spread ${currentSpread.toFixed(5)} > max ${maxAllowed} for ${pair}`);
    return true;
  }
  return false;
}

// ─── News lockout ─────────────────────────────────────────────────────────────
// Blocks entries within NEWS_DANGER_MIN before AND after any high-impact event.
// The outer signal flow already blocks auto-trade at 30min — this tighter window
// prevents execution trigger approval in the last 15min around events.

function _checkNewsLockout(
  events: Array<{ date: string; country: string; title: string }>,
): boolean {
  if (events.length === 0) return false;
  const nowMs = Date.now();
  return events.some((e) => {
    const eventMs = new Date(e.date).getTime();
    const diffMin = (eventMs - nowMs) / 60000;
    return diffMin > -NEWS_DANGER_MIN && diffMin < NEWS_DANGER_MIN;
  });
}

// ─── Trade cooldown ────────────────────────────────────────────────────────────

async function _checkCooldown(
  userId: string,
  pair:   ValidPair,
  signal: 'BUY' | 'SELL',
): Promise<{ cooldownBlocked: boolean; cooldownReason: string }> {
  try {
    const userOid = new Types.ObjectId(userId);
    const now     = Date.now();

    // Block: same direction on same pair within 5 minutes
    const recentSameDir = await Signal.findOne({
      userId:    userOid,
      pair,
      signal,
      createdAt: { $gte: new Date(now - DIRECTION_COOLDOWN_MS) },
    }).sort({ createdAt: -1 }).lean();

    if (recentSameDir) {
      const ageMin = ((now - (recentSameDir.createdAt as Date).getTime()) / 60000).toFixed(1);
      return {
        cooldownBlocked: true,
        cooldownReason:  `[SCALP-EXEC] BLOCKED: direction cooldown — ${signal} on ${pair} was signalled ${ageMin}min ago (5min cooldown to prevent double-entry)`,
      };
    }

    // Block: chop detection — too many signals in the last 20 minutes
    const recentSignals = await Signal.countDocuments({
      userId:    userOid,
      pair,
      signal:    { $in: ['BUY', 'SELL'] },
      createdAt: { $gte: new Date(now - CHOP_WINDOW_MS) },
    });

    if (recentSignals >= CHOP_SIGNAL_LIMIT) {
      return {
        cooldownBlocked: true,
        cooldownReason:  `[SCALP-EXEC] BLOCKED: chop detection — ${recentSignals} signals on ${pair} in last 20min (limit ${CHOP_SIGNAL_LIMIT}); market is oscillating without direction`,
      };
    }

    return { cooldownBlocked: false, cooldownReason: '' };
  } catch {
    // DB failure is non-fatal for cooldown check
    console.warn('[SCALP-EXEC] Cooldown DB check failed — allowing entry (fail-open)');
    return { cooldownBlocked: false, cooldownReason: '' };
  }
}

// ─── Shared HOLD factory ──────────────────────────────────────────────────────

function _blocked(
  reason:          string,
  spreadBlocked:   boolean,
  cooldownBlocked: boolean,
  newsBlocked:     boolean,
): ScalpExecutionResult {
  return {
    canExecute:      false,
    spreadBlocked,
    cooldownBlocked,
    newsBlocked,
    executionReason: reason,
    trigger: {
      type: 'NONE', confirmed: false, candleClose: false, quality: 0,
      reasons: [], blockers: [reason],
    },
    retestScore: {
      rejectionStrength: 0, retracementDepth: 0,
      mitigationQuality: 0, imbalanceRespect: 0, total: 0,
    },
  };
}
