// src/services/adaptiveWeights.service.ts
// Adaptive weight learning engine.
//
// Algorithm:
//   1. Fetch closed TradeEvents sorted chronologically
//   2. Split into BATCH_SIZE batches (oldest → newest)
//   3. For each factor (trigger, session, regime, …):
//      a. For each batch compute the factor's R-contribution signal
//      b. Apply: weight = (weight × 0.8) + (signal × 0.2)   [spec formula]
//   4. Clamp weights to [MIN_WEIGHT, MAX_WEIGHT]
//   5. Cache the result for CACHE_TTL_MS
//
// A weight of 1.0 = neutral (no historical edge).
// A weight of 1.4 = that factor has historically produced +40% better outcomes.
// A weight of 0.7 = that factor has historically been associated with worse outcomes.

import { Types } from 'mongoose';
import TradeEvent, { ITradeEvent } from '../models/TradeEvent.model';
import AdaptiveWeightProfile, {
  IAdaptiveWeightProfile,
  IBiasWeights,
  IStructureWeights,
  CACHE_TTL_MS,
  MIN_WEIGHT,
  MAX_WEIGHT,
} from '../models/AdaptiveWeightProfile.model';
import { getRegimeProfile } from './onlineLearning.service';
import { IRegimeSubProfile } from '../models/RegimeWeightProfile.model';

const BATCH_SIZE     = 20;    // trades per smoothing batch
const SMOOTHING_α    = 0.2;   // new signal contribution per batch
const SMOOTHING_KEEP = 0.8;   // old weight retention per batch
const MIN_SAMPLES    = 30;

// Confidence-point scaling factors for bias adjustments
const BIAS_SCALE     = 15;    // maps 1R expectancy difference → 15 confidence pts

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns cached weights or recomputes if stale. Fast (single doc lookup). */
export async function getAdaptiveWeights(
  userId: string,
): Promise<IAdaptiveWeightProfile | null> {
  try {
    const userOid = new Types.ObjectId(userId);
    const cached  = await AdaptiveWeightProfile.findOne({ user_id: userOid }).lean() as IAdaptiveWeightProfile | null;

    if (cached && Date.now() - new Date(cached.computed_at).getTime() < CACHE_TTL_MS) {
      return cached;
    }

    // Cache miss or stale — recompute in background, return stale/null immediately
    // so the signal flow is never blocked
    computeAndCacheWeights(userId).catch(() => { /* non-fatal */ });
    return cached;  // return stale if exists; null if first time
  } catch {
    return null;
  }
}

/** Full weight recomputation. Called on-demand or by background refresh. */
export async function computeAndCacheWeights(
  userId:      string,
  lookbackDays: number = 90,
): Promise<IAdaptiveWeightProfile> {
  const userOid = new Types.ObjectId(userId);
  const since   = new Date(Date.now() - lookbackDays * 86_400_000);

  const events = await TradeEvent.find({
    user_id:   userOid,
    timestamp: { $gte: since },
    outcome:   { $in: ['win', 'loss', 'breakeven'] },
  }).sort({ timestamp: 1 }).lean() as ITradeEvent[];

  const n           = events.length;
  const is_reliable = n >= MIN_SAMPLES;

  // Build weight profile from events
  const triggerWeights  = _smoothMultiValueWeights(events, (e) => e.trigger_types_fired);
  const sessionWeights  = _smoothSingleValueWeights(events, (e) => e.session);
  const regimeWeights   = _smoothSingleValueWeights(events, (e) => e.market_regime);
  const biasWeights     = _computeBiasWeights(events);
  const structureWeights = _computeStructureWeights(events);

  // Execution condition weights (trigger type combination performance)
  const execWeights = _smoothSingleValueWeights(
    events,
    (e) => [...e.trigger_types_fired].sort().join('+') || 'NO_TRIGGER',
  );

  const profile = await AdaptiveWeightProfile.findOneAndUpdate(
    { user_id: userOid },
    {
      $set: {
        computed_at:                 new Date(),
        sample_size:                 n,
        lookback_days:               lookbackDays,
        is_reliable,
        trigger_weights:             triggerWeights,
        session_weights:             sessionWeights,
        regime_weights:              regimeWeights,
        bias_weights:                biasWeights,
        structure_weights:           structureWeights,
        execution_condition_weights: execWeights,
      },
    },
    { upsert: true, new: true },
  ) as IAdaptiveWeightProfile;

  console.info(`[Adaptive] Weights recomputed for user ${userId} — ${n} events, reliable=${is_reliable}`);
  return profile;
}

// ─── Exponential smoothing — single-value factors ─────────────────────────────
// e.g. session: each event has exactly one session label

function _smoothSingleValueWeights(
  events: ITradeEvent[],
  extractor: (e: ITradeEvent) => string,
): Record<string, number> {
  // Collect all possible values
  const allValues = [...new Set(events.map(extractor))];
  const weights: Record<string, number> = {};

  for (const value of allValues) {
    let w = 1.0;  // start neutral
    const batches = _toBatches(events, BATCH_SIZE);

    for (const batch of batches) {
      const inGroup = batch.filter((e) => extractor(e) === value);
      const signal  = inGroup.length > 0 ? _batchSignal(inGroup) : 1.0;
      w = SMOOTHING_KEEP * w + SMOOTHING_α * signal;
    }

    weights[value] = _clampWeight(w);
  }

  return weights;
}

// ─── Exponential smoothing — multi-value factors ──────────────────────────────
// e.g. triggers: each event may have multiple trigger types

function _smoothMultiValueWeights(
  events: ITradeEvent[],
  extractor: (e: ITradeEvent) => string[],
): Record<string, number> {
  const allValues = [...new Set(events.flatMap(extractor))];
  const weights: Record<string, number> = {};

  for (const value of allValues) {
    let w = 1.0;
    const batches = _toBatches(events, BATCH_SIZE);

    for (const batch of batches) {
      const inGroup = batch.filter((e) => extractor(e).includes(value));
      const signal  = inGroup.length > 0 ? _batchSignal(inGroup) : 1.0;
      w = SMOOTHING_KEEP * w + SMOOTHING_α * signal;
    }

    weights[value] = _clampWeight(w);
  }

  return weights;
}

// ─── Bias weights (learned confidence adjustments in pts) ─────────────────────

function _computeBiasWeights(events: ITradeEvent[]): IBiasWeights {
  if (events.length < 10) {
    return {
      aligned_edge: 0, opposed_edge: 0, neutral_edge: 0,
      bias_edge_diff: 0,
      verdict: 'Insufficient data — using neutral bias weights.',
    };
  }

  const aligned = events.filter((e) =>  e.bias_aligned && e.higher_timeframe_bias !== 'neutral');
  const opposed = events.filter((e) => !e.bias_aligned && e.higher_timeframe_bias !== 'neutral');
  const neutral = events.filter((e) =>  e.higher_timeframe_bias === 'neutral');

  const overallR  = _meanR(events);
  const alignedR  = _meanR(aligned);
  const opposedR  = _meanR(opposed);
  const neutralR  = _meanR(neutral);

  // Adjustment in confidence points: 1R above/below baseline → ±BIAS_SCALE pts
  const aligned_edge  = _scaleToConfPts(alignedR - overallR, BIAS_SCALE);
  const opposed_edge  = _scaleToConfPts(opposedR - overallR, BIAS_SCALE);
  const neutral_edge  = _scaleToConfPts(neutralR - overallR, BIAS_SCALE * 0.6);
  const bias_edge_diff = aligned_edge - opposed_edge;

  let verdict = `Bias aligned: ${aligned.length} trades (${_pct(aligned)} WR, expectancy ${_expectancy(aligned).toFixed(2)}R). `;
  verdict    += `Bias opposed: ${opposed.length} trades (${_pct(opposed)} WR, expectancy ${_expectancy(opposed).toFixed(2)}R). `;
  verdict    += `Learned edge diff: ${bias_edge_diff > 0 ? '+' : ''}${bias_edge_diff.toFixed(1)} conf pts. `;
  verdict    += bias_edge_diff > 5  ? 'Bias alignment adds measurable edge.' :
                bias_edge_diff < -3 ? 'Bias alignment shows inverse correlation — review.' :
                'Bias alignment shows minimal statistical impact.';

  return {
    aligned_edge:  parseFloat(aligned_edge.toFixed(2)),
    opposed_edge:  parseFloat(opposed_edge.toFixed(2)),
    neutral_edge:  parseFloat(neutral_edge.toFixed(2)),
    bias_edge_diff: parseFloat(bias_edge_diff.toFixed(2)),
    verdict,
  };
}

// ─── Structure quality weights ────────────────────────────────────────────────

function _computeStructureWeights(events: ITradeEvent[]): IStructureWeights {
  if (events.length < 10) {
    return { ob_multiplier: 1.0, fvg_multiplier: 1.0, displacement_multiplier: 1.0 };
  }

  const overallR = _meanR(events);

  const highOB = events.filter((e) => e.ob_quality_score >= 67);
  const lowOB  = events.filter((e) => e.ob_quality_score <  34);
  const highFVG = events.filter((e) => e.fvg_quality_score >= 67);
  const lowFVG  = events.filter((e) => e.fvg_quality_score <  34);
  const highDisp = events.filter((e) => e.displacement_strength >= 67);
  const lowDisp  = events.filter((e) => e.displacement_strength <  34);

  const obRatio   = _safeRatio(_meanR(highOB),  _meanR(lowOB));
  const fvgRatio  = _safeRatio(_meanR(highFVG), _meanR(lowFVG));
  const dispRatio = _safeRatio(_meanR(highDisp), _meanR(lowDisp));

  // Multiplier: > 1 means high-quality setups in this dimension perform better
  return {
    ob_multiplier:           _clampWeight(obRatio > 0 ? obRatio : 1.0),
    fvg_multiplier:          _clampWeight(fvgRatio > 0 ? fvgRatio : 1.0),
    displacement_multiplier: _clampWeight(dispRatio > 0 ? dispRatio : 1.0),
  };
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function _toBatches<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

/** Signal for a group of trades in a single batch. Mapped to [0.1, 2.5] around 1.0 neutral. */
function _batchSignal(events: ITradeEvent[]): number {
  if (events.length === 0) return 1.0;
  const meanR = _meanR(events);
  // tanh maps R to (-1, 1); add 1 for [0, 2] range centered at neutral (1.0)
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, 1.0 + Math.tanh(meanR)));
}

function _meanR(events: ITradeEvent[]): number {
  if (events.length === 0) return 0;
  const total = events.reduce((s, e) => {
    return s + (e.outcome === 'win' ? e.rr_ratio : e.outcome === 'breakeven' ? 0 : -1);
  }, 0);
  return total / events.length;
}

function _expectancy(events: ITradeEvent[]): number {
  return _meanR(events);
}

function _pct(events: ITradeEvent[]): string {
  if (events.length === 0) return '0%';
  const wins = events.filter((e) => e.outcome === 'win').length;
  return ((wins / events.length) * 100).toFixed(0) + '%';
}

/** Maps a R-difference to confidence points, using tanh for smooth saturation. */
function _scaleToConfPts(rDiff: number, scale: number): number {
  return parseFloat((Math.tanh(rDiff) * scale).toFixed(2));
}

function _safeRatio(a: number, b: number): number {
  if (b === 0) return a > 0 ? MAX_WEIGHT : 1.0;
  return (a + 1.001) / (b + 1.001);  // offset to avoid divide-by-zero and negative ratios
}

function _clampWeight(w: number): number {
  return parseFloat(Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, w)).toFixed(3));
}

// ─── Regime-specific weight lookup ───────────────────────────────────────────
// Returns the online-learned sub-profile for a specific regime.
// Falls back to null if no regime profile exists yet for that regime.
// Used by signal.service.ts to fetch regime weights in the parallel data fetch.

export async function getRegimeWeights(
  userId: string,
  regime: string,
): Promise<IRegimeSubProfile | null> {
  return getRegimeProfile(userId, regime);
}

export type { IRegimeSubProfile } from '../models/RegimeWeightProfile.model';
