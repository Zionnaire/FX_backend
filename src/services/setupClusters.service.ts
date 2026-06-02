// src/services/setupClusters.service.ts
// Setup cluster discovery engine.
//
// A cluster is a group of trades that share the same:
//   (sorted triggers) | session | regime | OB bucket | FVG bucket | volatility bucket
//
// Each cluster is evaluated for:
//   - Edge (expectancy in R)
//   - Stability (variance of returns, consistency of drawdown)
//   - Sample reliability (Wilson lower bound)
//
// Clusters with HIGH EDGE + sufficient sample → labelled "HIGH EDGE SETUP"
// This label can be used downstream by the confidence engine.

import { ITradeEvent, DataReliability } from '../models/TradeEvent.model';
import { wilsonLowerBound } from '../utils/statistics.utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EdgeLabel =
  | 'HIGH EDGE / HIGH STABILITY'
  | 'HIGH EDGE / LOW STABILITY'
  | 'LOW EDGE / HIGH STABILITY'
  | 'LOW EDGE / LOW STABILITY'
  | 'INSUFFICIENT DATA';

export interface SetupCluster {
  cluster_id:          string;   // SHA-like hash of cluster_key
  cluster_key:         string;   // human-readable composite key
  // Component breakdown
  triggers:            string[];
  session:             string;
  regime:              string;
  ob_bucket:           string;
  fvg_bucket:          string;
  volatility_bucket:   string;
  // Statistics
  frequency:           number;
  win_rate:            number;   // percentage (closed trades only)
  expectancy:          number;   // mean R per trade
  avg_R:               number;   // same as expectancy (alias for clarity)
  variance:            number;   // variance of per-trade R returns
  std_dev:             number;
  confidence_interval: [number, number];  // [wilson_lb, observed_wr] as percentages
  wilson_lb:           number;   // overfitting-adjusted lower bound (%)
  stability_score:     number;   // |expectancy| / std_dev (higher = more consistent)
  sample_reliable:     boolean;  // frequency >= 30
  reliability:         DataReliability;
  edge_label:          EdgeLabel;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const HIGH_EDGE_EXPECTANCY  = 0.20;  // R: cluster must beat this to be HIGH EDGE
const HIGH_STABILITY_SCORE  = 0.80;  // stability_score threshold
const MIN_CLUSTER_SIZE      = 5;     // minimum trades to include a cluster at all
const RELIABLE_CLUSTER_SIZE = 30;

// ─── Main discovery function ─────────────────────────────────────────────────

export function discoverSetupClusters(events: ITradeEvent[]): SetupCluster[] {
  const closed = events.filter((e) => e.outcome !== 'open');
  if (closed.length === 0) return [];

  // Group by cluster key
  const groups = new Map<string, ITradeEvent[]>();
  for (const e of closed) {
    const key = _buildClusterKey(e);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const clusters: SetupCluster[] = [];
  for (const [key, trades] of groups.entries()) {
    if (trades.length < MIN_CLUSTER_SIZE) continue;
    clusters.push(_buildCluster(key, trades));
  }

  // Sort: HIGH EDGE clusters first, then by expectancy descending
  return clusters.sort((a, b) => {
    const aHigh = a.edge_label.startsWith('HIGH EDGE') ? 1 : 0;
    const bHigh = b.edge_label.startsWith('HIGH EDGE') ? 1 : 0;
    if (aHigh !== bHigh) return bHigh - aHigh;
    return b.expectancy - a.expectancy;
  });
}

/** Find the cluster that best matches a live trade event (for confidence lookup). */
export function findMatchingCluster(
  event: Pick<ITradeEvent, 'trigger_types_fired' | 'session' | 'market_regime' | 'ob_quality_score' | 'fvg_quality_score' | 'atr_at_entry' | 'entry_price'>,
  clusters: SetupCluster[],
): SetupCluster | null {
  const key = _buildClusterKeyFromFields(
    event.trigger_types_fired,
    event.session,
    event.market_regime,
    event.ob_quality_score,
    event.fvg_quality_score,
    event.atr_at_entry,
    event.entry_price ?? 1,
  );
  return clusters.find((c) => c.cluster_key === key) ?? null;
}

// ─── Cluster construction ─────────────────────────────────────────────────────

function _buildCluster(key: string, trades: ITradeEvent[]): SetupCluster {
  const [triggers, session, regime, ob_bucket, fvg_bucket, volatility_bucket] =
    _parseClusterKey(key);

  const freq  = trades.length;
  const wins  = trades.filter((e) => e.outcome === 'win').length;
  const wr    = freq > 0 ? (wins / freq) * 100 : 0;
  const rArr  = trades.map((e) => e.outcome === 'win' ? e.rr_ratio : e.outcome === 'breakeven' ? 0 : -1);
  const meanR = rArr.reduce((s, r) => s + r, 0) / freq;
  const variance = rArr.reduce((s, r) => s + (r - meanR) ** 2, 0) / freq;
  const stdDev   = Math.sqrt(variance);
  const wlb      = wilsonLowerBound(wins, freq) * 100;
  const stability = stdDev > 0 ? Math.abs(meanR) / stdDev : (meanR !== 0 ? 99 : 0);

  const reliability: DataReliability =
    freq >= 100 ? 'HIGH' :
    freq >= 60  ? 'MEDIUM' :
    freq >= 30  ? 'LOW' :
    'INSUFFICIENT';

  const edge_label = _labelEdge(meanR, stability, freq);

  return {
    cluster_id:          _hashKey(key),
    cluster_key:         key,
    triggers:            triggers === 'NO_TRIGGER' ? [] : triggers.split('+'),
    session,
    regime,
    ob_bucket,
    fvg_bucket,
    volatility_bucket,
    frequency:           freq,
    win_rate:            parseFloat(wr.toFixed(1)),
    expectancy:          parseFloat(meanR.toFixed(3)),
    avg_R:               parseFloat(meanR.toFixed(3)),
    variance:            parseFloat(variance.toFixed(4)),
    std_dev:             parseFloat(stdDev.toFixed(3)),
    confidence_interval: [parseFloat(wlb.toFixed(1)), parseFloat(wr.toFixed(1))],
    wilson_lb:           parseFloat(wlb.toFixed(1)),
    stability_score:     parseFloat(stability.toFixed(3)),
    sample_reliable:     freq >= RELIABLE_CLUSTER_SIZE,
    reliability,
    edge_label,
  };
}

function _labelEdge(expectancy: number, stability: number, n: number): EdgeLabel {
  if (n < RELIABLE_CLUSTER_SIZE) return 'INSUFFICIENT DATA';
  const highEdge      = expectancy >= HIGH_EDGE_EXPECTANCY;
  const highStability = stability  >= HIGH_STABILITY_SCORE;
  if (highEdge  && highStability)  return 'HIGH EDGE / HIGH STABILITY';
  if (highEdge  && !highStability) return 'HIGH EDGE / LOW STABILITY';
  if (!highEdge && highStability)  return 'LOW EDGE / HIGH STABILITY';
  return 'LOW EDGE / LOW STABILITY';
}

// ─── Cluster key construction ─────────────────────────────────────────────────

function _buildClusterKey(e: ITradeEvent): string {
  return _buildClusterKeyFromFields(
    e.trigger_types_fired,
    e.session,
    e.market_regime,
    e.ob_quality_score,
    e.fvg_quality_score,
    e.atr_at_entry,
    e.entry_price,
  );
}

function _buildClusterKeyFromFields(
  triggers:    string[],
  session:     string,
  regime:      string,
  obScore:     number,
  fvgScore:    number,
  atr:         number,
  price:       number,
): string {
  const triggerStr  = [...triggers].sort().join('+') || 'NO_TRIGGER';
  const ob_bucket   = _scoreBucket(obScore);
  const fvg_bucket  = _scoreBucket(fvgScore);
  const vol_bucket  = _atrBucket(atr, price);
  return `${triggerStr}|${session}|${regime}|ob:${ob_bucket}|fvg:${fvg_bucket}|vol:${vol_bucket}`;
}

function _parseClusterKey(key: string): string[] {
  // Format: "TRIGGER1+TRIGGER2|session|regime|ob:bucket|fvg:bucket|vol:bucket"
  const parts = key.split('|');
  return [
    parts[0] ?? 'NO_TRIGGER',         // triggers
    parts[1] ?? 'Unknown',             // session
    parts[2] ?? 'Unknown',             // regime
    (parts[3] ?? 'ob:medium').replace('ob:', ''),   // ob_bucket
    (parts[4] ?? 'fvg:medium').replace('fvg:', ''), // fvg_bucket
    (parts[5] ?? 'vol:medium').replace('vol:', ''), // vol_bucket
  ];
}

function _scoreBucket(score: number): 'low' | 'medium' | 'high' {
  if (score >= 67) return 'high';
  if (score >= 34) return 'medium';
  return 'low';
}

function _atrBucket(atr: number, price: number): 'low' | 'medium' | 'high' {
  if (price <= 0) return 'medium';
  const pct = (atr / price) * 100;
  if (pct > 0.20) return 'high';
  if (pct > 0.08) return 'medium';
  return 'low';
}

/** Deterministic short hash of a string (no crypto dependency). */
function _hashKey(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h) ^ key.charCodeAt(i);
    h = h >>> 0;  // keep as 32-bit unsigned
  }
  return h.toString(16).padStart(8, '0');
}
