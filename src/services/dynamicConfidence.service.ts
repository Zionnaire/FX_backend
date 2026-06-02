// src/services/dynamicConfidence.service.ts
// Dynamic confidence computation engine.
//
// Replaces static ±5/−10 hardcoded bias adjustments with learned weights.
//
// Formula:
//   score =  50 (base)
//          + Σ(trigger_weight_deviation × TRIGGER_SCALE)
//          + session_weight_deviation   × SESSION_SCALE
//          + regime_weight_deviation    × REGIME_SCALE
//          + learned_bias_adjustment                    ← replaces hardcoded values
//          + (ob_quality  / 100) × ob_multiplier  × OB_SCALE
//          + (fvg_quality / 100) × fvg_multiplier × FVG_SCALE
//          + (displacement/ 100) × disp_multiplier× DISP_SCALE
//          + cluster_edge × CLUSTER_SCALE
//          → clamped to [0, 100]
//
// When no weight profile is available (< 30 trades), returns a neutral fallback.

import { IBiasWeights } from '../models/AdaptiveWeightProfile.model';
import { IWeightProfile } from '../models/RegimeWeightProfile.model';

// ─── Scaling constants ────────────────────────────────────────────────────────
const TRIGGER_SCALE = 12;
const SESSION_SCALE =  8;
const REGIME_SCALE  =  8;
const OB_SCALE      =  8;
const FVG_SCALE     =  6;
const DISP_SCALE    =  4;
const CLUSTER_SCALE = 10;

// Neutral fallbacks used when no profile is available
const NEUTRAL_BIAS_ALIGNED   =  4;
const NEUTRAL_BIAS_OPPOSED   = -8;
const NEUTRAL_BIAS_NEUTRAL   =  0;

// ─── Input type ───────────────────────────────────────────────────────────────

export interface DynamicConfidenceInput {
  triggerTypes:        string[];
  session:             string;
  regime:              string;
  biasAligned:         boolean;
  biasIsNeutral:       boolean;
  obQualityScore:      number;
  fvgQualityScore:     number;
  displacementStrength:number;
  clusterExpectancy:   number | null;  // from findMatchingCluster; null = no cluster data
}

// ─── Learned bias adjustment ──────────────────────────────────────────────────
// Called from signal.service.ts to replace the hardcoded ±5/−10 adjustment.
// Returns a numeric confidence-point adjustment (positive or negative).

export function getLearnedBiasAdjustment(
  biasAligned:   boolean,
  biasIsNeutral: boolean,
  profile:       IWeightProfile | null,
): number {
  if (!profile || !profile.is_reliable) {
    // Fall back to neutral values when insufficient data
    if (biasIsNeutral)  return NEUTRAL_BIAS_NEUTRAL;
    if (biasAligned)    return NEUTRAL_BIAS_ALIGNED;
    return NEUTRAL_BIAS_OPPOSED;
  }

  const bw: IBiasWeights = profile.bias_weights;
  if (biasIsNeutral)  return bw.neutral_edge;
  if (biasAligned)    return bw.aligned_edge;
  return bw.opposed_edge;
}

// ─── Full dynamic confidence score ───────────────────────────────────────────
// Returns a 0–100 score derived from learned weights + cluster edge.
// This is a SUPPLEMENT to the Groq confidence, not a replacement.
// Callers may blend: finalConf = α × groqConf + (1−α) × dynamicConf

export function computeDynamicConfidence(
  input:   DynamicConfidenceInput,
  profile: IWeightProfile | null,
): number {
  let score = 50;  // neutral baseline

  if (!profile) {
    // No profile — apply only cluster edge if available
    if (input.clusterExpectancy !== null) {
      score += input.clusterExpectancy * CLUSTER_SCALE;
    }
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  const tw = profile.trigger_weights  ?? {};
  const sw = profile.session_weights  ?? {};
  const rw = profile.regime_weights   ?? {};
  const bw = profile.bias_weights;
  const stw = profile.structure_weights;

  // Trigger contributions (weight 1.0 = neutral, > 1.0 = positive edge)
  for (const trigger of input.triggerTypes) {
    const w = tw[trigger] ?? 1.0;
    score += (w - 1.0) * TRIGGER_SCALE;
  }

  // Session contribution
  const sessionW = sw[input.session] ?? 1.0;
  score += (sessionW - 1.0) * SESSION_SCALE;

  // Regime contribution
  const regimeW = rw[input.regime] ?? 1.0;
  score += (regimeW - 1.0) * REGIME_SCALE;

  // Bias adjustment (learned from historical data, not hardcoded)
  const biasAdj = input.biasIsNeutral ? bw.neutral_edge
    : input.biasAligned ? bw.aligned_edge
    : bw.opposed_edge;
  score += biasAdj;

  // Structure quality (quality score × multiplier → scaled contribution)
  score += (input.obQualityScore / 100)        * (stw.ob_multiplier ?? 1)           * OB_SCALE;
  score += (input.fvgQualityScore / 100)        * (stw.fvg_multiplier ?? 1)          * FVG_SCALE;
  score += (input.displacementStrength / 100)   * (stw.displacement_multiplier ?? 1) * DISP_SCALE;

  // Historical cluster edge (in R — positive = profitable cluster)
  if (input.clusterExpectancy !== null) {
    score += input.clusterExpectancy * CLUSTER_SCALE;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── Confidence blending ──────────────────────────────────────────────────────
// Blends Groq's model confidence with the dynamic confidence.
// When profile is unreliable, heavily favour Groq.

export function blendConfidence(
  groqScore:    number,
  dynamicScore: number,
  isReliable:   boolean,
): number {
  const groqWeight    = isReliable ? 0.55 : 0.85;
  const dynamicWeight = 1 - groqWeight;
  return Math.max(0, Math.min(100, Math.round(groqScore * groqWeight + dynamicScore * dynamicWeight)));
}
