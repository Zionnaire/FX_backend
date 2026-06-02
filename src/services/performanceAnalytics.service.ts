// src/services/performanceAnalytics.service.ts
// Self-auditing performance analytics engine.
// Operates exclusively on TradeEvent records — never touches the signal flow.
//
// Architecture:
//   generatePerformanceReport()  → full PerformanceReport (dashboard)
//   getSignatureConfidence()     → historical confidence for a specific setup
//   getBiasImpactReport()        → isolated bias alignment analysis
//   getExpectancyMatrix()        → cross-tabulated session × regime × bias
//
// Overfitting protection:
//   wilsonLowerBound()           → penalised win rate for small samples
//   _reliability()               → sample size reliability label
//   MINIMUM_SAMPLE = 30          → stats flagged LOW_DATA below this

import { Types } from 'mongoose';
import TradeEvent, { ITradeEvent, DataReliability } from '../models/TradeEvent.model';
import { IAdaptiveWeightProfile } from '../models/AdaptiveWeightProfile.model';
import { IRegimeSubProfile, IStabilityState } from '../models/RegimeWeightProfile.model';
import { getAdaptiveWeights } from './adaptiveWeights.service';
import { discoverSetupClusters, SetupCluster } from './setupClusters.service';
import { wilsonLowerBound as _wilsonLB } from '../utils/statistics.utils';
import { generateRegimeComparisonReport, RegimeComparisonReport } from './regimeComparison.service';
import { getRegimeWeightDocument } from './onlineLearning.service';

// ─── Constants ────────────────────────────────────────────────────────────────

const MINIMUM_SAMPLE    = 30;   // below this: INSUFFICIENT / LOW
const MEDIUM_SAMPLE     = 60;
const HIGH_SAMPLE       = 100;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SetupStats {
  label:        string;
  signals:      number;
  wins:         number;
  losses:       number;
  breakeven:    number;
  winRate:      number;     // 0–100, closed trades only
  expectancy:   number;     // R-multiple: (WR × avgWin) − (LR × avgLoss)
  avgWin:       number;     // average R for winning trades
  avgLoss:      number;     // average R for losing trades (positive)
  profitFactor: number;
  reliability:  DataReliability;
  wilsonLB:     number;     // overfitting-penalised win rate (0–100)
}

export interface BiasImpactReport {
  aligned:  SetupStats;
  opposed:  SetupStats;
  neutral:  SetupStats;
  verdict:  string;   // e.g. "Aligned bias improves win rate by +12.3pp"
}

export interface ExpectancyCell {
  session:    string;
  regime:     string;
  bias:       string;
  expectancy: number;
  winRate:    number;
  signals:    number;
  reliability: DataReliability;
}

export interface RiskAnalysis {
  maxDrawdownR:      number;   // worst peak-to-trough in R
  avgMFE:            number;   // average max favorable excursion (R)
  avgMAE:            number;   // average max adverse excursion (R)
  mfeToMaeRatio:     number;   // > 1 = more upside than drawdown on average
  avgTimeToExitMin:  number;
  drawdownCurve:     number[]; // cumulative R curve (one point per closed trade)
}

export interface SignatureInput {
  triggerTypes: string[];
  session:      string;
  regime:       string;
  obBucket:     'low' | 'medium' | 'high';
  fvgBucket:    'low' | 'medium' | 'high';
  bias:         'bullish' | 'bearish' | 'neutral';
}

export interface SignatureResult {
  signatureKey:  string;
  winRate:       number;
  avgR:          number;
  sampleSize:    number;
  reliability:   DataReliability;
  wilsonLB:      number;
  lowDataWarning: boolean;
}

export interface EdgeStabilityEntry {
  label:           string;
  type:            'session' | 'regime' | 'trigger';
  expectancy:      number;
  std_dev:         number;
  stability_score: number;
  sample_size:     number;
  reliability:     DataReliability;
  is_high_edge:    boolean;
}

export interface PerformanceReport {
  generatedAt:             string;
  userId:                  string;
  lookbackDays:            number;
  totalEvents:             number;
  closedTrades:            number;
  openTrades:              number;
  overall_stats:           SetupStats;
  session_breakdown:       Array<SetupStats & { session: string }>;
  regime_breakdown:        Array<SetupStats & { regime: string }>;
  trigger_rankings:        Array<SetupStats & { trigger: string }>;
  bias_impact_analysis:    BiasImpactReport;
  bias_learning_report:    BiasImpactReport;
  top_setups:              SetupStats[];
  worst_setups:            SetupStats[];
  expectancy_matrix:       ExpectancyCell[];
  risk_analysis:           RiskAnalysis;
  overfitting_warnings:    string[];
  signal_starvation:       boolean;
  signal_starvation_note:  string;
  // Adaptive intelligence fields (Phase 4)
  adaptive_weights:        IAdaptiveWeightProfile | null;
  setup_clusters:          SetupCluster[];
  edge_stability_matrix:   EdgeStabilityEntry[];
  top_high_edge_clusters:  SetupCluster[];
  unstable_clusters:       SetupCluster[];
  // Regime-partitioned online learning fields (Phase 5)
  adaptive_weights_by_regime: Record<string, IRegimeSubProfile | null>;
  setup_clusters_by_regime:   Record<string, SetupCluster[]>;
  regime_comparison:          RegimeComparisonReport | null;
  stability_controller_status: IStabilityState | null;
  top_regime_clusters:        SetupCluster[];
  unstable_regime_clusters:   SetupCluster[];
}

// ─── Main report generator ────────────────────────────────────────────────────

export async function generatePerformanceReport(
  userId:        string,
  lookbackDays:  number = 90,
): Promise<PerformanceReport> {
  const since  = new Date(Date.now() - lookbackDays * 86_400_000);
  const userOid = new Types.ObjectId(userId);

  const events = await TradeEvent.find({
    user_id:   userOid,
    timestamp: { $gte: since },
  }).sort({ timestamp: 1 }).lean() as ITradeEvent[];

  const closed    = events.filter((e) => e.outcome !== 'open');
  const open      = events.filter((e) => e.outcome === 'open');
  const warnings: string[] = [];

  // ── Overall stats ──────────────────────────────────────────────────────────
  const overall = _computeStats('All Trades', closed);
  if (overall.signals < MINIMUM_SAMPLE) {
    warnings.push(`Only ${overall.signals} closed events in ${lookbackDays}-day window — statistics are LOW RELIABILITY. Need ≥ ${MINIMUM_SAMPLE} for meaningful analysis.`);
  }

  // ── Session breakdown ──────────────────────────────────────────────────────
  const sessionGroups = _groupBy(closed, 'session');
  const sessionBreakdown = Object.entries(sessionGroups).map(([session, evts]) => ({
    session,
    ..._computeStats(session, evts),
  })).sort((a, b) => b.expectancy - a.expectancy);

  // ── Regime breakdown ───────────────────────────────────────────────────────
  const regimeGroups = _groupBy(closed, 'market_regime');
  const regimeBreakdown = Object.entries(regimeGroups).map(([regime, evts]) => ({
    regime,
    ..._computeStats(regime, evts),
  })).sort((a, b) => b.expectancy - a.expectancy);

  // ── Trigger rankings ───────────────────────────────────────────────────────
  // Each event may have multiple triggers — we credit each trigger for the outcome.
  const triggerMap = new Map<string, ITradeEvent[]>();
  for (const e of closed) {
    for (const t of e.trigger_types_fired) {
      if (!triggerMap.has(t)) triggerMap.set(t, []);
      triggerMap.get(t)!.push(e);
    }
  }
  const triggerRankings = Array.from(triggerMap.entries()).map(([trigger, evts]) => ({
    trigger,
    ..._computeStats(trigger, evts),
  })).sort((a, b) => b.expectancy - a.expectancy);

  // ── Bias impact analysis ───────────────────────────────────────────────────
  const biasImpact = _computeBiasImpact(closed);

  // ── Top / worst setups ─────────────────────────────────────────────────────
  // Rank by Wilson lower bound expectancy (penalises small sample rates)
  const allSetups: SetupStats[] = [
    ...sessionBreakdown,
    ...regimeBreakdown,
    ...triggerRankings,
  ].filter((s) => s.signals >= MINIMUM_SAMPLE);

  const topSetups   = [...allSetups].sort((a, b) => b.wilsonLB - a.wilsonLB).slice(0, 5);
  const worstSetups = [...allSetups].sort((a, b) => a.wilsonLB - b.wilsonLB).slice(0, 5);

  // ── Expectancy matrix ──────────────────────────────────────────────────────
  const expectancyMatrix = _computeExpectancyMatrix(closed);

  // ── Risk analysis ──────────────────────────────────────────────────────────
  const riskAnalysis = _computeRiskAnalysis(closed);

  // ── Overfitting warnings ───────────────────────────────────────────────────
  _checkOverfitting(allSetups, warnings);

  // ── Signal starvation detection ────────────────────────────────────────────
  const starvationWindowMs = 7 * 86_400_000; // 7 days
  const recentEvents = events.filter((e) =>
    e.timestamp.getTime() > Date.now() - starvationWindowMs,
  );
  const starvation = recentEvents.length < 3;
  const starvationNote = starvation
    ? `Only ${recentEvents.length} signals in the last 7 days — check filter thresholds for over-filtering`
    : '';

  // ── Adaptive intelligence (Phase 4) ───────────────────────────────────────
  const adaptiveWeights = await getAdaptiveWeights(userId).catch(() => null);
  const clusters        = discoverSetupClusters(closed);

  const topHighEdgeClusters = clusters.filter((c) => c.edge_label.startsWith('HIGH EDGE'));
  const unstableClusters    = clusters.filter(
    (c) => c.frequency >= 30 && c.edge_label.includes('LOW STABILITY'),
  );

  // ── Edge stability matrix ──────────────────────────────────────────────────
  const edgeStabilityMatrix: EdgeStabilityEntry[] = [];

  for (const [session, evts] of Object.entries(sessionGroups)) {
    edgeStabilityMatrix.push(_edgeStabilityEntry(session, 'session', evts));
  }
  for (const [regime, evts] of Object.entries(regimeGroups)) {
    edgeStabilityMatrix.push(_edgeStabilityEntry(regime, 'regime', evts));
  }
  for (const [trigger, evts] of triggerMap.entries()) {
    edgeStabilityMatrix.push(_edgeStabilityEntry(trigger, 'trigger', evts));
  }
  edgeStabilityMatrix.sort((a, b) => b.stability_score - a.stability_score);

  // ── Phase 5: Regime-partitioned online learning ────────────────────────────
  const [regimeComparisonResult, regimeDocResult] = await Promise.allSettled([
    generateRegimeComparisonReport(userId, lookbackDays),
    getRegimeWeightDocument(userId),
  ]);

  const regimeComparison  = regimeComparisonResult.status  === 'fulfilled' ? regimeComparisonResult.value  : null;
  const regimeDoc         = regimeDocResult.status         === 'fulfilled' ? regimeDocResult.value         : null;
  const stabilityStatus   = regimeDoc?.stability_state     ?? null;

  // Build per-regime weight lookup (null = no trades in that regime yet)
  const regimeKeys: string[] = ['trend', 'range', 'compression', 'expansion', 'news'];
  const adaptiveWeightsByRegime: Record<string, IRegimeSubProfile | null> = {};
  for (const k of regimeKeys) {
    const sub = regimeDoc?.[k as keyof typeof regimeDoc] as IRegimeSubProfile | undefined;
    adaptiveWeightsByRegime[k] = (sub && sub.sample_size > 0) ? sub : null;
  }

  // Clusters grouped by regime (reuse from regime comparison if available)
  const clustersByRegime: Record<string, SetupCluster[]> = regimeComparison?.regime_clusters ?? {};
  const topRegimeClusters    = regimeComparison?.top_regime_clusters    ?? topHighEdgeClusters;
  const unstableRegimeClusters = regimeComparison?.unstable_clusters    ?? unstableClusters;

  return {
    generatedAt:            new Date().toISOString(),
    userId,
    lookbackDays,
    totalEvents:            events.length,
    closedTrades:           closed.length,
    openTrades:             open.length,
    overall_stats:          overall,
    session_breakdown:      sessionBreakdown,
    regime_breakdown:       regimeBreakdown,
    trigger_rankings:       triggerRankings,
    bias_impact_analysis:   biasImpact,
    bias_learning_report:   biasImpact,
    top_setups:             topSetups,
    worst_setups:           worstSetups,
    expectancy_matrix:      expectancyMatrix,
    risk_analysis:          riskAnalysis,
    overfitting_warnings:   warnings,
    signal_starvation:      starvation,
    signal_starvation_note: starvationNote,
    // Phase 4
    adaptive_weights:         adaptiveWeights,
    setup_clusters:           clusters,
    edge_stability_matrix:    edgeStabilityMatrix,
    top_high_edge_clusters:   topHighEdgeClusters,
    unstable_clusters:        unstableClusters,
    // Phase 5
    adaptive_weights_by_regime:  adaptiveWeightsByRegime,
    setup_clusters_by_regime:    clustersByRegime,
    regime_comparison:           regimeComparison,
    stability_controller_status: stabilityStatus,
    top_regime_clusters:         topRegimeClusters,
    unstable_regime_clusters:    unstableRegimeClusters,
  };
}

// ─── Setup clusters (standalone endpoint) ────────────────────────────────────

export async function getSetupClustersForUser(
  userId:        string,
  lookbackDays:  number = 90,
): Promise<SetupCluster[]> {
  const since   = new Date(Date.now() - lookbackDays * 86_400_000);
  const userOid = new Types.ObjectId(userId);
  const events  = await TradeEvent.find({
    user_id:   userOid,
    timestamp: { $gte: since },
    outcome:   { $in: ['win', 'loss', 'breakeven'] },
  }).lean() as ITradeEvent[];
  return discoverSetupClusters(events);
}

// ─── Setup signature confidence ───────────────────────────────────────────────
// Looks up the historical win rate for an EXACT setup combination.
// Returns LOW_DATA if sample < MINIMUM_SAMPLE.

export async function getSignatureConfidence(
  userId: string,
  input:  SignatureInput,
): Promise<SignatureResult> {
  const key = _buildSignatureKey(input);
  const userOid = new Types.ObjectId(userId);

  const matches = await TradeEvent.find({
    user_id: userOid,
    outcome: { $in: ['win', 'loss', 'breakeven'] },
    session: input.session,
    market_regime: input.regime,
    higher_timeframe_bias: input.bias,
  }).lean() as ITradeEvent[];

  // Further filter by trigger combination and quality buckets in memory
  const filtered = matches.filter((e) => {
    const triggersMatch = input.triggerTypes.every((t) => e.trigger_types_fired.includes(t));
    const obBucketMatch = _scoreToBucket(e.ob_quality_score)  === input.obBucket;
    const fvgBucketMatch = _scoreToBucket(e.fvg_quality_score) === input.fvgBucket;
    return triggersMatch && obBucketMatch && fvgBucketMatch;
  });

  const wins = filtered.filter((e) => e.outcome === 'win').length;
  const n    = filtered.length;

  if (n === 0) {
    return {
      signatureKey: key, winRate: 0, avgR: 0,
      sampleSize: 0, reliability: 'INSUFFICIENT',
      wilsonLB: 0, lowDataWarning: true,
    };
  }

  const avgR = _computeAvgR(filtered);
  const wRate = (wins / n) * 100;

  return {
    signatureKey:   key,
    winRate:        parseFloat(wRate.toFixed(1)),
    avgR:           parseFloat(avgR.toFixed(2)),
    sampleSize:     n,
    reliability:    _reliability(n),
    wilsonLB:       parseFloat(_wilsonLB(wins, n).toFixed(1)),
    lowDataWarning: n < MINIMUM_SAMPLE,
  };
}

// ─── Isolated bias impact report ─────────────────────────────────────────────

export async function getBiasImpactReport(userId: string, lookbackDays = 90): Promise<BiasImpactReport> {
  const since   = new Date(Date.now() - lookbackDays * 86_400_000);
  const userOid = new Types.ObjectId(userId);
  const closed  = await TradeEvent.find({
    user_id:   userOid,
    timestamp: { $gte: since },
    outcome:   { $in: ['win', 'loss', 'breakeven'] },
  }).lean() as ITradeEvent[];

  return _computeBiasImpact(closed);
}

// ─── Expectancy matrix (standalone) ──────────────────────────────────────────

export async function getExpectancyMatrix(userId: string, lookbackDays = 90): Promise<ExpectancyCell[]> {
  const since   = new Date(Date.now() - lookbackDays * 86_400_000);
  const userOid = new Types.ObjectId(userId);
  const closed  = await TradeEvent.find({
    user_id:   userOid,
    timestamp: { $gte: since },
    outcome:   { $in: ['win', 'loss', 'breakeven'] },
  }).lean() as ITradeEvent[];

  return _computeExpectancyMatrix(closed);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _computeStats(label: string, events: ITradeEvent[]): SetupStats {
  if (events.length === 0) {
    return { label, signals: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0, expectancy: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, reliability: 'INSUFFICIENT', wilsonLB: 0 };
  }

  const wins      = events.filter((e) => e.outcome === 'win');
  const losses    = events.filter((e) => e.outcome === 'loss');
  const breakeven = events.filter((e) => e.outcome === 'breakeven');
  const n         = events.length;

  const winRate   = n > 0 ? (wins.length / n) * 100 : 0;
  const lossRate  = 100 - winRate;

  const avgWin  = wins.length  > 0 ? wins.reduce((s, e) => s + e.rr_ratio, 0)  / wins.length  : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, e) => s + 1, 0) / losses.length : 0; // 1R per loss

  const expectancy    = (winRate / 100) * avgWin - (lossRate / 100) * avgLoss;
  const grossWin      = wins.reduce((s, e) => s + e.rr_ratio, 0);
  const grossLoss     = losses.length;  // 1R per loss
  const profitFactor  = grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss;
  const wlb           = _wilsonLB(wins.length, n) * 100;

  return {
    label,
    signals:      n,
    wins:         wins.length,
    losses:       losses.length,
    breakeven:    breakeven.length,
    winRate:      parseFloat(winRate.toFixed(1)),
    expectancy:   parseFloat(expectancy.toFixed(3)),
    avgWin:       parseFloat(avgWin.toFixed(2)),
    avgLoss:      parseFloat(avgLoss.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    reliability:  _reliability(n),
    wilsonLB:     parseFloat(wlb.toFixed(1)),
  };
}

function _computeBiasImpact(closed: ITradeEvent[]): BiasImpactReport {
  const aligned = _computeStats('Bias Aligned',  closed.filter((e) => e.bias_aligned));
  const opposed = _computeStats('Bias Opposed',  closed.filter((e) => !e.bias_aligned && e.higher_timeframe_bias !== 'neutral'));
  const neutral = _computeStats('Bias Neutral',  closed.filter((e) => e.higher_timeframe_bias === 'neutral'));

  let verdict = 'Insufficient data to determine bias impact.';
  if (aligned.signals >= 10 && opposed.signals >= 10) {
    const diff = parseFloat((aligned.winRate - opposed.winRate).toFixed(1));
    const sign = diff >= 0 ? '+' : '';
    verdict = `Bias-aligned trades: ${aligned.winRate}% WR vs opposed: ${opposed.winRate}% WR (${sign}${diff}pp). ` +
      `Expectancy: aligned ${aligned.expectancy}R vs opposed ${opposed.expectancy}R. ` +
      (diff > 5 ? 'Bias alignment adds measurable edge — confidence boost applied correctly.' :
       diff < -3 ? 'Bias alignment shows negative correlation — review weighting formula.' :
       'Bias alignment shows minimal impact — statistical noise.');
  }

  return { aligned, opposed, neutral, verdict };
}

function _computeExpectancyMatrix(closed: ITradeEvent[]): ExpectancyCell[] {
  const key = (e: ITradeEvent) => `${e.session}|${e.market_regime}|${e.higher_timeframe_bias}`;
  const groups = new Map<string, ITradeEvent[]>();

  for (const e of closed) {
    const k = key(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }

  return Array.from(groups.entries()).map(([k, evts]) => {
    const [session, regime, bias] = k.split('|');
    const stats = _computeStats(k, evts);
    return {
      session, regime, bias,
      expectancy:  stats.expectancy,
      winRate:     stats.winRate,
      signals:     stats.signals,
      reliability: stats.reliability,
    };
  }).sort((a, b) => b.expectancy - a.expectancy);
}

function _computeRiskAnalysis(closed: ITradeEvent[]): RiskAnalysis {
  // Drawdown curve: cumulative R from trade outcomes
  const curve: number[] = [];
  let cumR     = 0;
  let peakR    = 0;
  let maxDD    = 0;

  for (const e of closed) {
    const r = e.outcome === 'win' ? e.rr_ratio : e.outcome === 'breakeven' ? 0 : -1;
    cumR += r;
    curve.push(parseFloat(cumR.toFixed(2)));
    if (cumR > peakR) peakR = cumR;
    const dd = peakR - cumR;
    if (dd > maxDD) maxDD = dd;
  }

  // MFE / MAE — only available for events with outcome updates
  const withMFE = closed.filter((e) => e.mfe !== null);
  const withMAE = closed.filter((e) => e.mae !== null);
  const avgMFE  = withMFE.length > 0 ? withMFE.reduce((s, e) => s + (e.mfe ?? 0), 0) / withMFE.length : 0;
  const avgMAE  = withMAE.length > 0 ? withMAE.reduce((s, e) => s + (e.mae ?? 0), 0) / withMAE.length : 0;

  const withTime = closed.filter((e) => e.time_to_exit_minutes !== null);
  const avgTime  = withTime.length > 0
    ? withTime.reduce((s, e) => s + (e.time_to_exit_minutes ?? 0), 0) / withTime.length
    : 0;

  return {
    maxDrawdownR:     parseFloat(maxDD.toFixed(2)),
    avgMFE:           parseFloat(avgMFE.toFixed(2)),
    avgMAE:           parseFloat(avgMAE.toFixed(2)),
    mfeToMaeRatio:    avgMAE > 0 ? parseFloat((avgMFE / avgMAE).toFixed(2)) : 0,
    avgTimeToExitMin: parseFloat(avgTime.toFixed(0)),
    drawdownCurve:    curve,
  };
}

function _checkOverfitting(setups: SetupStats[], warnings: string[]): void {
  for (const s of setups) {
    if (s.signals < MINIMUM_SAMPLE && s.winRate > 70) {
      warnings.push(`Overfitting risk: "${s.label}" shows ${s.winRate}% WR from only ${s.signals} trades. Wilson LB: ${s.wilsonLB}%. Needs ≥ ${MINIMUM_SAMPLE} trades.`);
    }
  }
  // Detect unstable strategies: massive win rate swings
  const highWR  = setups.filter((s) => s.signals >= MINIMUM_SAMPLE && s.winRate > 70);
  const lowWR   = setups.filter((s) => s.signals >= MINIMUM_SAMPLE && s.winRate < 40);
  if (highWR.length > 0 && lowWR.length > 0) {
    warnings.push(`High variance detected: some setups show > 70% WR while others show < 40% WR on sufficient samples — review session/regime filters.`);
  }
}

function _groupBy(events: ITradeEvent[], field: keyof ITradeEvent): Record<string, ITradeEvent[]> {
  return events.reduce((acc, e) => {
    const k = String(e[field]);
    if (!acc[k]) acc[k] = [];
    acc[k].push(e);
    return acc;
  }, {} as Record<string, ITradeEvent[]>);
}

function _computeAvgR(events: ITradeEvent[]): number {
  if (events.length === 0) return 0;
  const total = events.reduce((s, e) => {
    return s + (e.outcome === 'win' ? e.rr_ratio : e.outcome === 'breakeven' ? 0 : -1);
  }, 0);
  return total / events.length;
}

function _buildSignatureKey(input: SignatureInput): string {
  const sortedTriggers = [...input.triggerTypes].sort().join('+');
  return `${sortedTriggers}|${input.session}|${input.regime}|ob:${input.obBucket}|fvg:${input.fvgBucket}|bias:${input.bias}`;
}

function _scoreToBucket(score: number): 'low' | 'medium' | 'high' {
  if (score >= 67) return 'high';
  if (score >= 34) return 'medium';
  return 'low';
}

function _reliability(n: number): DataReliability {
  if (n >= HIGH_SAMPLE)   return 'HIGH';
  if (n >= MEDIUM_SAMPLE) return 'MEDIUM';
  if (n >= MINIMUM_SAMPLE) return 'LOW';
  return 'INSUFFICIENT';
}

// ─── Wilson lower bound (re-export from shared utils) ────────────────────────
// Kept as a named export for backward compatibility with callers that import
// wilsonLowerBound directly from this module.
export { _wilsonLB as wilsonLowerBound };

// ─── Edge stability helper ────────────────────────────────────────────────────

function _edgeStabilityEntry(
  label:  string,
  type:   'session' | 'regime' | 'trigger',
  events: ITradeEvent[],
): EdgeStabilityEntry {
  const n = events.length;
  if (n === 0) {
    return { label, type, expectancy: 0, std_dev: 0, stability_score: 0, sample_size: 0, reliability: 'INSUFFICIENT', is_high_edge: false };
  }
  const rVals  = events.map((e) => e.outcome === 'win' ? e.rr_ratio : e.outcome === 'breakeven' ? 0 : -1);
  const mean   = rVals.reduce((s, v) => s + v, 0) / n;
  const variance = rVals.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdDev   = Math.sqrt(variance);
  const stability = stdDev > 0 ? Math.abs(mean) / stdDev : (mean !== 0 ? 99 : 0);
  return {
    label,
    type,
    expectancy:      parseFloat(mean.toFixed(3)),
    std_dev:         parseFloat(stdDev.toFixed(3)),
    stability_score: parseFloat(stability.toFixed(3)),
    sample_size:     n,
    reliability:     _reliability(n),
    is_high_edge:    mean >= 0.20,
  };
}
