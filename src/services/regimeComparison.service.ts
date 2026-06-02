// src/services/regimeComparison.service.ts
// Regime performance comparison engine.
//
// Compares trading performance across the 5 market regimes:
//   trend / range / compression / expansion / news
//
// For each regime, computes:
//   - Expectancy, win rate, std_dev, stability score
//   - Bias effectiveness (aligned WR − opposed WR)
//   - Average signal confidence
//   - Reliability label
//
// Also groups setup clusters by regime and identifies best/worst/most stable.

import { Types } from 'mongoose';
import TradeEvent, { ITradeEvent, DataReliability } from '../models/TradeEvent.model';
import { discoverSetupClusters, SetupCluster } from './setupClusters.service';
import { wilsonLowerBound } from '../utils/statistics.utils';
import { ALL_REGIMES, RegimeKey } from '../models/RegimeWeightProfile.model';

// ─── Output types ─────────────────────────────────────────────────────────────

export interface RegimeStats {
  regime:              string;
  sample_size:         number;
  win_rate:            number;         // 0–100
  expectancy:          number;         // mean R per trade
  avg_R:               number;         // alias of expectancy
  std_dev:             number;
  stability_score:     number;         // |expectancy| / std_dev
  bias_effectiveness:  number;         // aligned_WR − opposed_WR (pp)
  avg_confidence:      number;         // mean confidence_score of trades in this regime
  wilson_lb:           number;         // overfitting-adjusted lower bound (%)
  reliability:         DataReliability;
}

export interface RegimeComparisonReport {
  generated_at:        string;
  lookback_days:       number;
  trend_stats:         RegimeStats;
  range_stats:         RegimeStats;
  compression_stats:   RegimeStats;
  expansion_stats:     RegimeStats;
  news_stats:          RegimeStats;
  best_regime:         string;   // highest expectancy with sufficient data
  worst_regime:        string;   // lowest expectancy with sufficient data
  most_stable_regime:  string;   // highest stability_score
  regime_clusters:     Record<string, SetupCluster[]>;
  top_regime_clusters: SetupCluster[];
  unstable_clusters:   SetupCluster[];
}

// ─── Main generator ───────────────────────────────────────────────────────────

export async function generateRegimeComparisonReport(
  userId:       string,
  lookbackDays: number = 90,
): Promise<RegimeComparisonReport> {
  const since   = new Date(Date.now() - lookbackDays * 86_400_000);
  const userOid = new Types.ObjectId(userId);

  const events = await TradeEvent.find({
    user_id:   userOid,
    timestamp: { $gte: since },
    outcome:   { $in: ['win', 'loss', 'breakeven'] },
  }).sort({ timestamp: 1 }).lean() as ITradeEvent[];

  // Build per-regime stats
  const statsByRegime: Record<string, RegimeStats> = {};
  for (const regime of ALL_REGIMES) {
    const group = events.filter((e) => e.market_regime === regime);
    statsByRegime[regime] = _buildRegimeStats(regime, group);
  }

  // Identify best / worst / most stable (among regimes with ≥ 10 trades)
  const reliable = ALL_REGIMES.filter((r) => statsByRegime[r].sample_size >= 10);

  const best   = _pickBy(reliable, statsByRegime, (a, b) => b.expectancy - a.expectancy)   ?? 'Insufficient data';
  const worst  = _pickBy(reliable, statsByRegime, (a, b) => a.expectancy - b.expectancy)   ?? 'Insufficient data';
  const stable = _pickBy(reliable, statsByRegime, (a, b) => b.stability_score - a.stability_score) ?? 'Insufficient data';

  // Setup clusters grouped by regime
  const allClusters = discoverSetupClusters(events);
  const regimeClusters: Record<string, SetupCluster[]> = {};
  for (const regime of ALL_REGIMES) {
    regimeClusters[regime] = allClusters.filter((c) => c.regime === regime);
  }

  const topClusters      = allClusters.filter((c) => c.edge_label.startsWith('HIGH EDGE'));
  const unstableClusters = allClusters.filter(
    (c) => c.frequency >= 30 && c.edge_label.includes('LOW STABILITY'),
  );

  return {
    generated_at:       new Date().toISOString(),
    lookback_days:      lookbackDays,
    trend_stats:        statsByRegime['trend'],
    range_stats:        statsByRegime['range'],
    compression_stats:  statsByRegime['compression'],
    expansion_stats:    statsByRegime['expansion'],
    news_stats:         statsByRegime['news'],
    best_regime:        best,
    worst_regime:       worst,
    most_stable_regime: stable,
    regime_clusters:    regimeClusters,
    top_regime_clusters:  topClusters,
    unstable_clusters:    unstableClusters,
  };
}

// ─── Per-regime stats builder ─────────────────────────────────────────────────

function _buildRegimeStats(regime: string, events: ITradeEvent[]): RegimeStats {
  const n    = events.length;
  const empty: RegimeStats = {
    regime, sample_size: 0, win_rate: 0, expectancy: 0, avg_R: 0,
    std_dev: 0, stability_score: 0, bias_effectiveness: 0, avg_confidence: 0,
    wilson_lb: 0, reliability: 'INSUFFICIENT',
  };
  if (n === 0) return empty;

  const wins   = events.filter((e) => e.outcome === 'win');
  const winRate = (wins.length / n) * 100;

  const rVals   = events.map((e) => e.outcome === 'win' ? e.rr_ratio : e.outcome === 'breakeven' ? 0 : -1);
  const meanR   = rVals.reduce((s, v) => s + v, 0) / n;
  const variance = rVals.reduce((s, v) => s + (v - meanR) ** 2, 0) / n;
  const stdDev   = Math.sqrt(variance);
  const stability = stdDev > 0 ? Math.abs(meanR) / stdDev : (meanR !== 0 ? 99 : 0);

  // Bias effectiveness
  const aligned  = events.filter((e) =>  e.bias_aligned && e.higher_timeframe_bias !== 'neutral');
  const opposed  = events.filter((e) => !e.bias_aligned && e.higher_timeframe_bias !== 'neutral');
  const alignedWR = aligned.length > 0 ? (aligned.filter((e) => e.outcome === 'win').length / aligned.length) * 100 : 0;
  const opposedWR = opposed.length > 0 ? (opposed.filter((e) => e.outcome === 'win').length / opposed.length) * 100 : 0;
  const biasEff   = parseFloat((alignedWR - opposedWR).toFixed(1));

  // Average signal confidence
  const avgConf = events.reduce((s, e) => s + (e.confidence_score ?? 0), 0) / n;

  return {
    regime,
    sample_size:         n,
    win_rate:            parseFloat(winRate.toFixed(1)),
    expectancy:          parseFloat(meanR.toFixed(3)),
    avg_R:               parseFloat(meanR.toFixed(3)),
    std_dev:             parseFloat(stdDev.toFixed(3)),
    stability_score:     parseFloat(stability.toFixed(3)),
    bias_effectiveness:  biasEff,
    avg_confidence:      parseFloat(avgConf.toFixed(1)),
    wilson_lb:           parseFloat((wilsonLowerBound(wins.length, n) * 100).toFixed(1)),
    reliability:         _reliability(n),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _pickBy(
  regimes: RegimeKey[],
  stats:   Record<string, RegimeStats>,
  sorter:  (a: RegimeStats, b: RegimeStats) => number,
): string | null {
  if (regimes.length === 0) return null;
  return [...regimes].sort((a, b) => sorter(stats[a], stats[b]))[0];
}

function _reliability(n: number): DataReliability {
  if (n >= 100) return 'HIGH';
  if (n >= 60)  return 'MEDIUM';
  if (n >= 30)  return 'LOW';
  return 'INSUFFICIENT';
}
