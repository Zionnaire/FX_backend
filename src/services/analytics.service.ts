// src/services/analytics.service.ts

import { Types } from 'mongoose';
import Trade from '../models/Trade.model';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnalyticsFilters {
  startDate?: Date;
  endDate?: Date;
  pair?: string;
}

interface PairStat {
  pair:        string;
  wins:        number;
  losses:      number;
  totalPnL:    number;
  winRate:     number;
  totalTrades: number;
  bestTrade:   number | null;
  worstTrade:  number | null;
}

interface MonthlyPerformance {
  month:       string;
  totalPnL:    number;
  totalTrades: number;
  winRate:     number;
}

interface AnalyticsResult {
  winRate:           number;
  totalPnl:          number;
  totalTrades:       number;
  wins:              number;
  losses:            number;
  openTrades:        number;
  bestTrade:         number;
  worstTrade:        number;
  avgRR:             number;
  maxDrawdown:       number;
  sharpeRatio:       number;
  profitFactor:      number;
  avgTradeDuration:  string;
  monthlyPerformance: MonthlyPerformance[];
  byPair:            PairStat[];
}

interface PnlPoint {
  date: string;
  cumulative: number;
  tradePnl: number;
  pair: string;
}

// ─── Query Builder ────────────────────────────────────────────────────────────
// Builds the MongoDB query object from filters
// Reused across all three service functions

function buildQuery(
  userId: string,
  filters: AnalyticsFilters,
  statusFilter: 'closed' | 'all' = 'closed'
): Record<string, unknown> {
  const query: Record<string, unknown> = {
    userId: new Types.ObjectId(userId),
  };

  // Only include closed trades for stats (open trades have no exit/pnl yet)
  if (statusFilter === 'closed') {
    query.status = { $in: ['win', 'loss'] };
  }

  if (filters.pair) {
    query.pair = filters.pair;
  }

  if (filters.startDate || filters.endDate) {
    const dateFilter: Record<string, Date> = {};
    if (filters.startDate) dateFilter.$gte = filters.startDate;
    if (filters.endDate)   dateFilter.$lte = filters.endDate;
    query.createdAt = dateFilter;
  }

  return query;
}

// ─── Math Helpers ─────────────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) /
    (values.length - 1); // sample std dev
  return Math.sqrt(variance);
}

function parseRR(rr: string | number): number {
  // Parses "1:2.4" → 2.4, returns numeric value or 0 if unparseable
  if (typeof rr === 'number') return rr;
  if (!rr || !rr.includes(':')) return 0;
  const parts = rr.split(':');
  const parsed = parseFloat(parts[1]);
  return isNaN(parsed) ? 0 : parsed;
}

function computeMaxDrawdown(pnlValues: number[]): number {
  // Returns max drawdown as a positive percentage
  // e.g. 15.3 means the worst peak-to-trough was -15.3%
  if (pnlValues.length === 0) return 0;

  let peak = 0;
  let runningPnl = 0;
  let maxDrawdown = 0;

  for (const pnl of pnlValues) {
    runningPnl += pnl;
    if (runningPnl > peak) peak = runningPnl;
    if (peak > 0) {
      const drawdown = ((peak - runningPnl) / peak) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  }

  return parseFloat(maxDrawdown.toFixed(2));
}

// ─── getStats ─────────────────────────────────────────────────────────────────

function parseDurationToMinutes(dur: string | undefined): number {
  if (!dur) return 0;
  const h = dur.match(/(\d+)h/);
  const m = dur.match(/(\d+)m/);
  return (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
}

export async function getStats(
  userId: string,
  filters: AnalyticsFilters = {}
): Promise<AnalyticsResult> {
  const query = buildQuery(userId, filters, 'closed');

  const trades = await Trade.find(query)
    .select('pnl rr status pair duration')
    .lean();

  const empty: AnalyticsResult = {
    winRate: 0, totalPnl: 0, totalTrades: 0,
    wins: 0, losses: 0, openTrades: 0,
    bestTrade: 0, worstTrade: 0,
    avgRR: 0, maxDrawdown: 0, sharpeRatio: 0,
    profitFactor: 0, avgTradeDuration: '—',
    monthlyPerformance: [], byPair: [],
  };

  if (trades.length === 0) return empty;

  const wins      = trades.filter(t => t.status === 'win');
  const losses    = trades.filter(t => t.status === 'loss');
  const pnlValues = trades.map(t => t.pnl ?? 0);

  const openQuery  = buildQuery(userId, filters, 'all');
  openQuery.status = 'open';
  const openTrades = await Trade.countDocuments(openQuery);

  const netPnl     = pnlValues.reduce((a, b) => a + b, 0);
  const winRate    = parseFloat(((wins.length / trades.length) * 100).toFixed(2));
  const bestTrade  = Math.max(...pnlValues);
  const worstTrade = Math.min(...pnlValues);
  const avgRR      = parseFloat(mean(trades.map(t => parseRR(t.rr ?? '0'))).toFixed(2));
  const maxDrawdown = computeMaxDrawdown(pnlValues);

  const avg = mean(pnlValues);
  const sd  = stdDev(pnlValues);
  const sharpeRatio = sd === 0 ? 0 : parseFloat(((avg / sd) * Math.sqrt(252)).toFixed(2));

  const grossProfit  = pnlValues.filter(v => v > 0).reduce((a, b) => a + b, 0);
  const grossLoss    = pnlValues.filter(v => v < 0).reduce((a, b) => a + Math.abs(b), 0);
  const profitFactor = grossLoss === 0
    ? (grossProfit > 0 ? 99 : 0)
    : parseFloat((grossProfit / grossLoss).toFixed(2));

  const durMins = trades.map(t => parseDurationToMinutes(t.duration)).filter(d => d > 0);
  const avgMin  = durMins.length > 0 ? mean(durMins) : 0;
  const avgTradeDuration = avgMin > 0
    ? `${Math.floor(avgMin / 60)}h ${Math.round(avgMin % 60)}m`
    : '—';

  // Monthly performance aggregation
  const monthlyRaw = await Trade.aggregate([
    { $match: query },
    {
      $group: {
        _id:         { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
        totalPnl:    { $sum: '$pnl' },
        totalTrades: { $sum: 1 },
        wins:        { $sum: { $cond: [{ $eq: ['$status', 'win'] }, 1, 0] } },
      },
    },
    { $sort: { _id: -1 } },
    { $limit: 6 },
  ]);

  const monthlyPerformance: MonthlyPerformance[] = monthlyRaw.map(m => ({
    month:       m._id as string,
    totalPnL:    parseFloat((m.totalPnl ?? 0).toFixed(2)),
    totalTrades: m.totalTrades as number,
    winRate:     parseFloat(((m.wins / m.totalTrades) * 100).toFixed(2)),
  }));

  const byPair = await getByPair(userId, filters);

  return {
    winRate,
    totalPnl:          parseFloat(netPnl.toFixed(2)),
    totalTrades:       trades.length,
    wins:              wins.length,
    losses:            losses.length,
    openTrades,
    bestTrade:         parseFloat(bestTrade.toFixed(2)),
    worstTrade:        parseFloat(worstTrade.toFixed(2)),
    avgRR,
    maxDrawdown,
    sharpeRatio,
    profitFactor,
    avgTradeDuration,
    monthlyPerformance,
    byPair,
  };
}

// ─── getPnlCurve ──────────────────────────────────────────────────────────────

export async function getPnlCurve(
  userId: string,
  filters: AnalyticsFilters = {}
): Promise<PnlPoint[]> {
  const query = buildQuery(userId, filters, 'closed');

  const trades = await Trade.find(query)
    .select('pnl pair createdAt')
    .sort({ createdAt: 1 })   // oldest first for cumulative calculation
    .lean();

  let cumulative = 0;

  return trades.map(trade => {
    cumulative += trade.pnl ?? 0;
    return {
      date: trade.createdAt
        ? new Date(trade.createdAt).toISOString()
        : new Date().toISOString(),
      cumulative: parseFloat(cumulative.toFixed(2)),
      tradePnl: parseFloat((trade.pnl ?? 0).toFixed(2)),
      pair: trade.pair,
    };
  });
}

// ─── getByPair ────────────────────────────────────────────────────────────────
// Dedicated function — not derived from getStats to avoid double computation

export async function getByPair(
  userId: string,
  filters: AnalyticsFilters = {}
): Promise<PairStat[]> {
  const query = buildQuery(userId, filters, 'closed');

  // Use MongoDB aggregation instead of fetching all trades and grouping in JS
  const result = await Trade.aggregate([
    { $match: query },
    {
      $group: {
        _id:         '$pair',
        wins:        { $sum: { $cond: [{ $eq: ['$status', 'win']  }, 1, 0] } },
        losses:      { $sum: { $cond: [{ $eq: ['$status', 'loss'] }, 1, 0] } },
        netPnl:      { $sum: '$pnl' },
        totalTrades: { $sum: 1 },
        bestTrade:   { $max: '$pnl' },
        worstTrade:  { $min: '$pnl' },
      },
    },
    { $sort: { netPnl: -1 } },
  ]);

  return result.map(r => ({
    pair:        r._id as string,
    wins:        r.wins        as number,
    losses:      r.losses      as number,
    totalPnL:    parseFloat((r.netPnl  ?? 0).toFixed(2)),
    totalTrades: r.totalTrades as number,
    winRate:     parseFloat(((r.wins / r.totalTrades) * 100).toFixed(2)),
    bestTrade:   r.bestTrade  != null ? parseFloat(r.bestTrade.toFixed(2))  : null,
    worstTrade:  r.worstTrade != null ? parseFloat(r.worstTrade.toFixed(2)) : null,
  }));
}