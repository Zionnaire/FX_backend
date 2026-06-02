// src/models/RegimeWeightProfile.model.ts
// Per-user, per-regime adaptive weight profiles with online learning state.
//
// Architecture:
//   One document per user holds 5 independent regime sub-profiles.
//   Each sub-profile is learned exclusively from trades that occurred in that regime.
//   Weights NEVER bleed across regimes — a weight learned in TREND has no effect
//   on the COMPRESSION profile.
//
// Lifecycle:
//   Created on first trade close via onlineLearning.service.ts (upsert).
//   Updated incrementally on every subsequent trade close.
//   Hysteresis prevents rapid regime flip-flopping in the online update path.
//   Stability controller reduces learning rate when behavior is erratic.

import { Schema, model, Document, Types } from 'mongoose';
import { IBiasWeights, IStructureWeights } from './AdaptiveWeightProfile.model';

// ─── Regime key ───────────────────────────────────────────────────────────────

export type RegimeKey = 'trend' | 'range' | 'compression' | 'expansion' | 'news';
export const ALL_REGIMES: RegimeKey[] = ['trend', 'range', 'compression', 'expansion', 'news'];

// ─── Decay / hysteresis constants ─────────────────────────────────────────────

export const DECAY_LAMBDA            = 0.008;  // exp decay per day; half-life ≈ 87 days
export const REGIME_CHANGE_THRESHOLD = 3;      // consecutive detections before confirming switch

// ─── Common weight profile interface ─────────────────────────────────────────
// Used by dynamicConfidence.service and getLearnedBiasAdjustment.
// Both IAdaptiveWeightProfile (global, batch) and IRegimeSubProfile satisfy this structurally.

export interface IWeightProfile {
  trigger_weights:   Record<string, number>;
  session_weights:   Record<string, number>;
  regime_weights:    Record<string, number>;
  bias_weights:      IBiasWeights;
  structure_weights: IStructureWeights;
  is_reliable:       boolean;
}

// ─── Sub-profile per regime ───────────────────────────────────────────────────

export interface IRegimeSubProfile extends IWeightProfile {
  execution_condition_weights: Record<string, number>;
  sample_size:                 number;
  last_updated:                Date;
  learning_rate:               number;  // 0.30 → 0.04 (dynamic, based on sample_size)
}

// ─── Stability controller state ───────────────────────────────────────────────

export interface IStabilityState {
  mode:                        'normal' | 'stabilizing';
  triggered_at:                Date | null;
  trigger_reason:              string;
  learning_rate_factor:        number;  // 1.0 = normal, 0.3 = stabilizing
  freeze_threshold:            number;  // |w - 1.0| < this → weight frozen during stabilization
  consecutive_regime_switches: number;
  expectancy_trend:            number;  // EMA of recent outcome signals, positive = improving
}

// ─── Hysteresis state ─────────────────────────────────────────────────────────

export interface IHysteresisState {
  confirmed_regime:  string;
  candidate_regime:  string | null;
  candidate_count:   number;
  last_updated:      Date;
}

// ─── Top-level document ───────────────────────────────────────────────────────

export interface IRegimeWeightProfile extends Document {
  user_id:          Types.ObjectId;
  computed_at:      Date;
  trend:            IRegimeSubProfile;
  range:            IRegimeSubProfile;
  compression:      IRegimeSubProfile;
  expansion:        IRegimeSubProfile;
  news:             IRegimeSubProfile;
  stability_state:  IStabilityState;
  hysteresis_state: IHysteresisState;
}

// ─── Default factories ────────────────────────────────────────────────────────

export function neutralSubProfile(): IRegimeSubProfile {
  return {
    trigger_weights:             {},
    session_weights:             {},
    regime_weights:              {},
    bias_weights:                {
      aligned_edge:   0,
      opposed_edge:   0,
      neutral_edge:   0,
      bias_edge_diff: 0,
      verdict:        'No data yet for this regime.',
    },
    structure_weights:           { ob_multiplier: 1.0, fvg_multiplier: 1.0, displacement_multiplier: 1.0 },
    execution_condition_weights: {},
    sample_size:                 0,
    is_reliable:                 false,
    last_updated:                new Date(0),
    learning_rate:               0.30,
  };
}

export function defaultStabilityState(): IStabilityState {
  return {
    mode:                        'normal',
    triggered_at:                null,
    trigger_reason:              '',
    learning_rate_factor:        1.0,
    freeze_threshold:            0.0,
    consecutive_regime_switches: 0,
    expectancy_trend:            0,
  };
}

export function defaultHysteresisState(): IHysteresisState {
  return {
    confirmed_regime:  'range',
    candidate_regime:  null,
    candidate_count:   0,
    last_updated:      new Date(),
  };
}

// ─── Mongoose schema ──────────────────────────────────────────────────────────

const RegimeWeightProfileSchema = new Schema<IRegimeWeightProfile>(
  {
    user_id:          { type: Schema.Types.ObjectId, required: true, unique: true },
    computed_at:      { type: Date, default: () => new Date() },
    trend:            { type: Schema.Types.Mixed, default: neutralSubProfile },
    range:            { type: Schema.Types.Mixed, default: neutralSubProfile },
    compression:      { type: Schema.Types.Mixed, default: neutralSubProfile },
    expansion:        { type: Schema.Types.Mixed, default: neutralSubProfile },
    news:             { type: Schema.Types.Mixed, default: neutralSubProfile },
    stability_state:  { type: Schema.Types.Mixed, default: defaultStabilityState },
    hysteresis_state: { type: Schema.Types.Mixed, default: defaultHysteresisState },
  },
  { timestamps: false },
);

RegimeWeightProfileSchema.index({ user_id: 1 });

export default model<IRegimeWeightProfile>('RegimeWeightProfile', RegimeWeightProfileSchema);
