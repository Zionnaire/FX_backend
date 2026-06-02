// src/services/onlineLearning.service.ts
// Regime-partitioned online learning engine.
//
// Called after every trade closes (via updateTradeOutcome in tradeEvent.service.ts).
// Updates ONLY the regime sub-profile that matches the trade's recorded market_regime.
//
// Core algorithm:
//   1. Detect which regime profile to update
//   2. Apply exponential time-decay to the existing weights (older learning fades toward neutral)
//   3. Compute a normalized outcome signal from the trade result
//   4. Apply incremental update: new_w = old_w + lr × (signal_target − old_w)
//   5. Run stability controller — reduce lr and freeze weak weights if behavior is erratic
//   6. Update hysteresis state (prevents flip-flopping in regime confirmation)
//   7. Persist the updated document atomically
//
// Learning rate schedule:
//   < 50 trades  → 0.30  (fast adaptation — early learning)
//   50–200       → 0.12  (medium — growing evidence)
//   200+         → 0.04  (low — stabilization phase)

import { ITradeEvent } from '../models/TradeEvent.model';
import RegimeWeightProfile, {
  IRegimeWeightProfile,
  IRegimeSubProfile,
  IStabilityState,
  IHysteresisState,
  RegimeKey,
  ALL_REGIMES,
  DECAY_LAMBDA,
  REGIME_CHANGE_THRESHOLD,
  neutralSubProfile,
  defaultStabilityState,
  defaultHysteresisState,
} from '../models/RegimeWeightProfile.model';
import { IBiasWeights, IStructureWeights, MIN_WEIGHT, MAX_WEIGHT } from '../models/AdaptiveWeightProfile.model';

// ─── Learning rate schedule ───────────────────────────────────────────────────

const LR_HIGH   = 0.30;
const LR_MEDIUM = 0.12;
const LR_LOW    = 0.04;

// ─── Stability thresholds ─────────────────────────────────────────────────────

const WEIGHT_VARIANCE_TRIGGER      = 0.15;   // weight std-dev above this → stabilize
const REGIME_SWITCH_TRIGGER        = 5;      // consecutive switches → stabilize
const EXPECTANCY_DECLINE_TRIGGER   = -0.20;  // expectancy_trend below this → stabilize
const STABILIZING_LR_FACTOR        = 0.30;   // effective lr multiplier in stabilizing mode
const STABILIZING_FREEZE_THRESHOLD = 0.05;   // freeze weights within ±0.05 of 1.0 (neutral)

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Called after every trade closes.
 * Updates the regime sub-profile that corresponds to the trade's market_regime.
 * Non-blocking — caller wraps with .catch(() => {}).
 */
export async function onTradeClose(event: ITradeEvent): Promise<void> {
  if (event.outcome === 'open') return;

  const userOid = event.user_id;
  const regime  = _normalizeRegime(event.market_regime);

  // Load existing profile (or start fresh)
  const doc = await RegimeWeightProfile.findOne({ user_id: userOid }).lean() as IRegimeWeightProfile | null;

  const prevHysteresis: IHysteresisState = doc?.hysteresis_state ?? defaultHysteresisState();
  const prevStability:  IStabilityState  = doc?.stability_state  ?? defaultStabilityState();

  // Hysteresis: confirm regime change only after N consecutive detections
  const hysteresis    = _updateHysteresis(prevHysteresis, regime);
  const regimeSwitched = hysteresis.confirmed_regime !== prevHysteresis.confirmed_regime;

  // Resolve current sub-profile
  const currentSub: IRegimeSubProfile =
    (doc?.[regime] as IRegimeSubProfile | undefined) ?? neutralSubProfile();

  // 1. Time-decay: fade weights toward neutral based on age of last update
  const decayed = _applyDecay(currentSub);

  // 2. Outcome signal → weight-space target
  const signalTarget = _outcomeSignal(event);

  // 3. Effective learning rate (dampened by stability controller if active)
  const baseLR      = _dynamicLR(decayed.sample_size);
  const lrFactor    = prevStability.mode === 'stabilizing'
    ? prevStability.learning_rate_factor
    : 1.0;
  const effectiveLR = baseLR * lrFactor;

  // 4. Incremental weight update
  const updated = _incrementalUpdate(decayed, event, signalTarget, effectiveLR, prevStability);

  // 5. Build all-sub snapshot for stability check
  const allSubs = _buildAllSubs(doc, regime, updated);

  // 6. Update expectancy trend (EMA of outcome signals)
  const rawSignalDelta = signalTarget - 1.0;  // centre at 0 (neutral = 0, win > 0, loss < 0)
  const newExpectancyTrend = prevStability.expectancy_trend * 0.9 + rawSignalDelta * 0.1;

  // 7. Stability check
  const newStability = _runStabilityCheck(
    allSubs, hysteresis, regimeSwitched, newExpectancyTrend, prevStability,
  );

  // 8. Persist atomically
  await RegimeWeightProfile.findOneAndUpdate(
    { user_id: userOid },
    {
      $set: {
        computed_at:      new Date(),
        [regime]:         updated,
        stability_state:  newStability,
        hysteresis_state: hysteresis,
      },
    },
    { upsert: true },
  );

  if (newStability.mode !== prevStability.mode) {
    console.warn(`[OnlineLearning] Stability mode → ${newStability.mode}: ${newStability.trigger_reason}`);
  }
}

// ─── Get regime sub-profile for a user ───────────────────────────────────────

export async function getRegimeProfile(
  userId: string,
  regime: string,
): Promise<IRegimeSubProfile | null> {
  try {
    const { Types } = await import('mongoose');
    const doc = await RegimeWeightProfile.findOne({
      user_id: new Types.ObjectId(userId),
    }).lean() as IRegimeWeightProfile | null;

    if (!doc) return null;
    const key = _normalizeRegime(regime);
    const sub = doc[key] as IRegimeSubProfile | undefined;
    return (sub && sub.sample_size > 0) ? sub : null;
  } catch {
    return null;
  }
}

/** Full regime weight document for the telemetry endpoint. */
export async function getRegimeWeightDocument(
  userId: string,
): Promise<IRegimeWeightProfile | null> {
  try {
    const { Types } = await import('mongoose');
    return await RegimeWeightProfile.findOne({
      user_id: new Types.ObjectId(userId),
    }).lean() as IRegimeWeightProfile | null;
  } catch {
    return null;
  }
}

// ─── Outcome signal ───────────────────────────────────────────────────────────
// Maps a trade result to a weight-space target value around 1.0 (neutral).
// Consistent with the batch system: target = 1.0 + tanh(adjustedR)

function _outcomeSignal(event: ITradeEvent): number {
  if (event.outcome === 'breakeven') return 1.0;

  const baseR = event.outcome === 'win' ? event.rr_ratio : -1;

  // MFE efficiency: did price move strongly in our direction before closing?
  const mfeFactor = (event.mfe !== null && event.mfe > 0)
    ? Math.min(event.mfe / Math.max(event.rr_ratio, 0.1), 1.5)
    : 1.0;

  // MAE severity: deep adverse excursion on a win means the entry was sloppy
  const maePenalty = (event.mae !== null && event.outcome === 'win')
    ? Math.max(1 - (event.mae ?? 0) * 0.15, 0.5)
    : 1.0;

  const adjustedR = baseR * mfeFactor * maePenalty;
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, 1.0 + Math.tanh(adjustedR)));
}

// ─── Incremental weight update ────────────────────────────────────────────────

function _incrementalUpdate(
  profile:      IRegimeSubProfile,
  event:        ITradeEvent,
  signalTarget: number,
  lr:           number,
  stability:    IStabilityState,
): IRegimeSubProfile {
  const freeze = stability.mode === 'stabilizing' ? stability.freeze_threshold : 0;
  const updated: IRegimeSubProfile = {
    ...profile,
    trigger_weights:  { ...profile.trigger_weights },
    session_weights:  { ...profile.session_weights },
  };

  // Trigger weights (each fired trigger is credited/blamed)
  for (const trigger of event.trigger_types_fired) {
    const cur = profile.trigger_weights[trigger] ?? 1.0;
    if (Math.abs(cur - 1.0) < freeze) continue;
    updated.trigger_weights[trigger] = _clamp(cur + lr * (signalTarget - cur));
  }

  // Session weight
  const sCur = profile.session_weights[event.session] ?? 1.0;
  if (Math.abs(sCur - 1.0) >= freeze) {
    updated.session_weights[event.session] = _clamp(sCur + lr * (signalTarget - sCur));
  }

  // Bias weights (confidence-point space: ±15)
  updated.bias_weights    = _updateBiasWeights(profile.bias_weights, event, lr);

  // Structure multipliers
  updated.structure_weights = _updateStructureWeights(profile.structure_weights, event, lr, signalTarget);

  updated.sample_size   = profile.sample_size + 1;
  updated.is_reliable   = updated.sample_size >= 30;
  updated.last_updated  = new Date();
  updated.learning_rate = _dynamicLR(updated.sample_size);

  return updated;
}

// ─── Bias weight incremental update ──────────────────────────────────────────

function _updateBiasWeights(bw: IBiasWeights, event: ITradeEvent, lr: number): IBiasWeights {
  const r      = event.outcome === 'win' ? event.rr_ratio : event.outcome === 'breakeven' ? 0 : -1;
  const target = Math.tanh(r) * 15;   // same scale as batch system (±15 conf pts)
  const updated = { ...bw };

  if (event.higher_timeframe_bias === 'neutral') {
    updated.neutral_edge = _clampPts(bw.neutral_edge + lr * (target - bw.neutral_edge));
  } else if (event.bias_aligned) {
    updated.aligned_edge = _clampPts(bw.aligned_edge + lr * (target - bw.aligned_edge));
  } else {
    updated.opposed_edge = _clampPts(bw.opposed_edge + lr * (target - bw.opposed_edge));
  }

  updated.bias_edge_diff = parseFloat((updated.aligned_edge - updated.opposed_edge).toFixed(2));
  updated.verdict = `Online (n=${event.outcome}). Aligned=${updated.aligned_edge.toFixed(1)}pts, ` +
    `Opposed=${updated.opposed_edge.toFixed(1)}pts, Diff=${updated.bias_edge_diff.toFixed(1)}pts`;
  return updated;
}

// ─── Structure weight incremental update ─────────────────────────────────────

function _updateStructureWeights(
  sw:           IStructureWeights,
  event:        ITradeEvent,
  lr:           number,
  signalTarget: number,
): IStructureWeights {
  const obTarget   = event.ob_quality_score >= 67  ? signalTarget
    : event.ob_quality_score < 34  ? 2.0 - signalTarget  // inverse: low quality + win = anomaly
    : null;
  const fvgTarget  = event.fvg_quality_score >= 67  ? signalTarget
    : event.fvg_quality_score < 34  ? 2.0 - signalTarget
    : null;
  const dispTarget = event.displacement_strength >= 67 ? signalTarget
    : event.displacement_strength < 34  ? 2.0 - signalTarget
    : null;

  return {
    ob_multiplier:           obTarget   !== null ? _clamp(sw.ob_multiplier   + lr * (obTarget   - sw.ob_multiplier))   : sw.ob_multiplier,
    fvg_multiplier:          fvgTarget  !== null ? _clamp(sw.fvg_multiplier  + lr * (fvgTarget  - sw.fvg_multiplier))  : sw.fvg_multiplier,
    displacement_multiplier: dispTarget !== null ? _clamp(sw.displacement_multiplier + lr * (dispTarget - sw.displacement_multiplier)) : sw.displacement_multiplier,
  };
}

// ─── Exponential time-decay ───────────────────────────────────────────────────
// Decays the deviation from neutral (1.0) toward zero.
// Formula: effective_w = 1.0 + (w − 1.0) × exp(−λ × age_days)

function _applyDecay(profile: IRegimeSubProfile): IRegimeSubProfile {
  const lastUpdated = profile.last_updated instanceof Date
    ? profile.last_updated
    : new Date(profile.last_updated);

  const ageDays = (Date.now() - lastUpdated.getTime()) / 86_400_000;
  if (ageDays < 1) return profile;   // skip decay within 24h

  const f = Math.exp(-DECAY_LAMBDA * ageDays);  // decay factor: 1.0 → 0.0 over time
  const decayed = { ...profile };

  decayed.trigger_weights = Object.fromEntries(
    Object.entries(profile.trigger_weights).map(([k, w]) => [k, _decayW(w, f)]),
  );
  decayed.session_weights = Object.fromEntries(
    Object.entries(profile.session_weights).map(([k, w]) => [k, _decayW(w, f)]),
  );

  const bw = profile.bias_weights;
  decayed.bias_weights = {
    ...bw,
    aligned_edge:   parseFloat((bw.aligned_edge   * f).toFixed(2)),
    opposed_edge:   parseFloat((bw.opposed_edge   * f).toFixed(2)),
    neutral_edge:   parseFloat((bw.neutral_edge   * f).toFixed(2)),
    bias_edge_diff: parseFloat(((bw.aligned_edge - bw.opposed_edge) * f).toFixed(2)),
    verdict: bw.verdict,
  };

  const sw = profile.structure_weights;
  decayed.structure_weights = {
    ob_multiplier:           _decayW(sw.ob_multiplier, f),
    fvg_multiplier:          _decayW(sw.fvg_multiplier, f),
    displacement_multiplier: _decayW(sw.displacement_multiplier, f),
  };

  return decayed;
}

function _decayW(w: number, factor: number): number {
  return _clamp(1.0 + (w - 1.0) * factor);
}

// ─── Hysteresis update ────────────────────────────────────────────────────────

function _updateHysteresis(state: IHysteresisState, detected: string): IHysteresisState {
  // Same regime detected — reset candidate, keep confirmed
  if (detected === state.confirmed_regime) {
    return { ...state, candidate_regime: null, candidate_count: 0, last_updated: new Date() };
  }

  // Already tracking this candidate — increment count
  if (detected === state.candidate_regime) {
    const newCount = state.candidate_count + 1;
    if (newCount >= REGIME_CHANGE_THRESHOLD) {
      // Confirmed switch
      return {
        confirmed_regime:  detected,
        candidate_regime:  null,
        candidate_count:   0,
        last_updated:      new Date(),
      };
    }
    return { ...state, candidate_count: newCount, last_updated: new Date() };
  }

  // New candidate, reset counter
  return { ...state, candidate_regime: detected, candidate_count: 1, last_updated: new Date() };
}

// ─── Stability controller ─────────────────────────────────────────────────────

function _runStabilityCheck(
  allSubs:          Record<RegimeKey, IRegimeSubProfile>,
  hysteresis:       IHysteresisState,
  regimeSwitched:   boolean,
  expectancyTrend:  number,
  current:          IStabilityState,
): IStabilityState {
  // Collect all non-neutral weight deviations from all sub-profiles
  const allWeights = (Object.values(allSubs) as IRegimeSubProfile[]).flatMap((sub) => [
    ...Object.values(sub.trigger_weights),
    ...Object.values(sub.session_weights),
    sub.structure_weights.ob_multiplier,
    sub.structure_weights.fvg_multiplier,
    sub.structure_weights.displacement_multiplier,
  ]);

  let weightStdDev = 0;
  if (allWeights.length > 0) {
    const mean = allWeights.reduce((s, w) => s + w, 0) / allWeights.length;
    const variance = allWeights.reduce((s, w) => s + (w - mean) ** 2, 0) / allWeights.length;
    weightStdDev = Math.sqrt(variance);
  }

  const switchCount = regimeSwitched
    ? current.consecutive_regime_switches + 1
    : Math.max(0, current.consecutive_regime_switches - 1);

  const highVariance       = weightStdDev     > WEIGHT_VARIANCE_TRIGGER;
  const tooManySwitches    = switchCount       >= REGIME_SWITCH_TRIGGER;
  const decliningExpectancy = expectancyTrend  < EXPECTANCY_DECLINE_TRIGGER;

  const updated: IStabilityState = {
    ...current,
    consecutive_regime_switches: switchCount,
    expectancy_trend:            parseFloat(expectancyTrend.toFixed(4)),
  };

  if ((highVariance || tooManySwitches || decliningExpectancy) && current.mode === 'normal') {
    const reason = highVariance       ? `High weight variance (σ=${weightStdDev.toFixed(3)})`
      : tooManySwitches               ? `Excessive regime switches (${switchCount})`
      : `Declining expectancy (trend=${expectancyTrend.toFixed(3)})`;

    return {
      ...updated,
      mode:                 'stabilizing',
      triggered_at:         new Date(),
      trigger_reason:       reason,
      learning_rate_factor: STABILIZING_LR_FACTOR,
      freeze_threshold:     STABILIZING_FREEZE_THRESHOLD,
    };
  }

  // Exit stabilizing when all conditions clear
  if (current.mode === 'stabilizing' && !highVariance && !tooManySwitches && !decliningExpectancy) {
    return {
      ...updated,
      mode:                 'normal',
      learning_rate_factor: 1.0,
      freeze_threshold:     0.0,
    };
  }

  return updated;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _normalizeRegime(regime: string): RegimeKey {
  return (ALL_REGIMES as string[]).includes(regime) ? (regime as RegimeKey) : 'range';
}

function _dynamicLR(n: number): number {
  if (n < 50)  return LR_HIGH;
  if (n < 200) return LR_MEDIUM;
  return LR_LOW;
}

function _clamp(w: number): number {
  return parseFloat(Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, w)).toFixed(3));
}

function _clampPts(v: number): number {
  return parseFloat(Math.max(-15, Math.min(15, v)).toFixed(2));
}

function _buildAllSubs(
  doc:          IRegimeWeightProfile | null,
  updatedKey:   RegimeKey,
  updatedSub:   IRegimeSubProfile,
): Record<RegimeKey, IRegimeSubProfile> {
  const get = (k: RegimeKey): IRegimeSubProfile =>
    k === updatedKey ? updatedSub : ((doc?.[k] as IRegimeSubProfile | undefined) ?? neutralSubProfile());

  return {
    trend:       get('trend'),
    range:       get('range'),
    compression: get('compression'),
    expansion:   get('expansion'),
    news:        get('news'),
  };
}
