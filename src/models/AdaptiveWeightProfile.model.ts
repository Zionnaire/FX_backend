// src/models/AdaptiveWeightProfile.model.ts
// Cached per-user adaptive weight profile.
// Computed from TradeEvent history via exponential smoothing over chronological batches.
// Expires after CACHE_TTL_MS — stale profiles fall back to neutral weights.

import { Schema, model, Document, Types } from 'mongoose';

export const CACHE_TTL_MS     = 6 * 60 * 60 * 1000;  // 6 hours
export const NEUTRAL_WEIGHT   = 1.0;                  // baseline — no edge
export const MIN_WEIGHT       = 0.3;
export const MAX_WEIGHT       = 2.5;

export interface IBiasWeights {
  aligned_edge:    number;  // confidence adjustment pts for aligned trades (learned)
  opposed_edge:    number;  // confidence adjustment pts for opposed trades (learned)
  neutral_edge:    number;  // adjustment for neutral-bias trades
  bias_edge_diff:  number;  // aligned_edge − opposed_edge (key metric)
  verdict:         string;  // human-readable summary
}

export interface IStructureWeights {
  ob_multiplier:            number;  // scales OB quality score contribution
  fvg_multiplier:           number;  // scales FVG quality score contribution
  displacement_multiplier:  number;  // scales displacement strength contribution
}

export interface IAdaptiveWeightProfile extends Document {
  user_id:                    Types.ObjectId;
  computed_at:                Date;
  sample_size:                number;
  lookback_days:              number;
  is_reliable:                boolean;   // sample_size >= 30
  // Learnable weights — centered around 1.0 (neutral)
  trigger_weights:            Record<string, number>;  // per trigger type
  session_weights:            Record<string, number>;  // per session
  regime_weights:             Record<string, number>;  // per market regime
  bias_weights:               IBiasWeights;
  structure_weights:          IStructureWeights;
  execution_condition_weights: Record<string, number>;
}

const AdaptiveWeightProfileSchema = new Schema<IAdaptiveWeightProfile>(
  {
    user_id:      { type: Schema.Types.ObjectId, required: true, unique: true },
    computed_at:  { type: Date, default: () => new Date() },
    sample_size:  { type: Number, default: 0 },
    lookback_days:{ type: Number, default: 90 },
    is_reliable:  { type: Boolean, default: false },

    trigger_weights:             { type: Schema.Types.Mixed, default: {} },
    session_weights:             { type: Schema.Types.Mixed, default: {} },
    regime_weights:              { type: Schema.Types.Mixed, default: {} },

    bias_weights: {
      aligned_edge:   { type: Number, default: 0 },
      opposed_edge:   { type: Number, default: 0 },
      neutral_edge:   { type: Number, default: 0 },
      bias_edge_diff: { type: Number, default: 0 },
      verdict:        { type: String, default: 'Insufficient data — using neutral bias weights.' },
    },

    structure_weights: {
      ob_multiplier:           { type: Number, default: 1.0 },
      fvg_multiplier:          { type: Number, default: 1.0 },
      displacement_multiplier: { type: Number, default: 1.0 },
    },

    execution_condition_weights: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: false },
);

AdaptiveWeightProfileSchema.index({ user_id: 1 });

export default model<IAdaptiveWeightProfile>('AdaptiveWeightProfile', AdaptiveWeightProfileSchema);
