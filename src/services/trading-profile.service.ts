// src/services/trading-profile.service.ts
// Builds a comprehensive statistical profile from a user's closed trade history.
// Used by the AI coaching endpoint and signal personalization.

import { Types } from 'mongoose';
import Trade from '../models/Trade.model';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TradingProfileData {
  totalTrades:       number;
  winRate:           number;
  profitFactor:      number;
  avgRR:             number;

  byPair: {
    pair:         string;
    count:        number;
    winRate:      number;
    netPnL:       number;
    buyWinRate:   number;
    sellWinRate:  number;
  }[];

  bySession: {
    session: string;
    count:   number;
    winRate: number;
    netPnL:  number;
  }[];

  byDay: {
    day:     string;
    count:   number;
    winRate: number;
  }[];

  buyWinRate:         number;
  sellWinRate:        number;

  avgWinDurationMin:  number;
  avgLossDurationMin: number;
  holdingTendency:    string;

  recentStreak: { type: string; count: number };
  last10WinRate: number;

  bestPair:    string | null;
  worstPair:   string | null;
  bestSession: string | null;
  bestDay:     string | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sessionFromDate(d: Date): string {
  const h = d.getUTCHours();
  if (h >= 23 || h < 7)  return 'Asian';
  if (h >= 7  && h < 12) return 'London';
  if (h >= 12 && h < 17) return 'NY Overlap';
  return 'New York';
}

function parseDurMins(dur: string | undefined): number {
  if (!dur) return 0;
  const h = dur.match(/(\d+)h/);
  const m = dur.match(/(\d+)m/);
  return (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
}

function parseRR(rr: string | undefined): number {
  if (!rr || !rr.includes(':')) return 0;
  const parts = rr.split(':');
  const v = parseFloat(parts[1]);
  return isNaN(v) ? 0 : v;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── buildTradingProfile ───────────────────────────────────────────────────────

export async function buildTradingProfile(userId: string): Promise<TradingProfileData> {
  const trades = await Trade.find({
    userId: new Types.ObjectId(userId),
    status: { $in: ['win', 'loss'] },
  })
    .select('pair type status pnl rr duration createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const empty: TradingProfileData = {
    totalTrades: 0, winRate: 0, profitFactor: 0, avgRR: 0,
    byPair: [], bySession: [], byDay: [],
    buyWinRate: 0, sellWinRate: 0,
    avgWinDurationMin: 0, avgLossDurationMin: 0, holdingTendency: 'insufficient data',
    recentStreak: { type: 'none', count: 0 }, last10WinRate: 0,
    bestPair: null, worstPair: null, bestSession: null, bestDay: null,
  };

  if (trades.length === 0) return empty;

  const wins   = trades.filter((t) => t.status === 'win');
  const losses = trades.filter((t) => t.status === 'loss');

  const winRate      = parseFloat(((wins.length / trades.length) * 100).toFixed(1));
  const grossProfit  = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss    = losses.reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0);
  const profitFactor = grossLoss === 0
    ? (grossProfit > 0 ? 99 : 0)
    : parseFloat((grossProfit / grossLoss).toFixed(2));
  const avgRR = parseFloat(
    (trades.reduce((s, t) => s + parseRR(t.rr), 0) / trades.length).toFixed(2)
  );

  // ── By pair ────────────────────────────────────────────────────────────────
  const pairMap = new Map<string, { wins: number; losses: number; netPnL: number; buyWins: number; buyTotal: number; sellWins: number; sellTotal: number }>();
  for (const t of trades) {
    if (!pairMap.has(t.pair)) pairMap.set(t.pair, { wins: 0, losses: 0, netPnL: 0, buyWins: 0, buyTotal: 0, sellWins: 0, sellTotal: 0 });
    const p = pairMap.get(t.pair)!;
    if (t.status === 'win') p.wins++; else p.losses++;
    p.netPnL += t.pnl ?? 0;
    if (t.type === 'BUY') { p.buyTotal++; if (t.status === 'win') p.buyWins++; }
    else                  { p.sellTotal++; if (t.status === 'win') p.sellWins++; }
  }
  const byPair = [...pairMap.entries()].map(([pair, v]) => {
    const count = v.wins + v.losses;
    return {
      pair,
      count,
      winRate:     parseFloat(((v.wins / count) * 100).toFixed(1)),
      netPnL:      parseFloat(v.netPnL.toFixed(2)),
      buyWinRate:  v.buyTotal  > 0 ? parseFloat(((v.buyWins  / v.buyTotal)  * 100).toFixed(1)) : 0,
      sellWinRate: v.sellTotal > 0 ? parseFloat(((v.sellWins / v.sellTotal) * 100).toFixed(1)) : 0,
    };
  }).sort((a, b) => b.netPnL - a.netPnL);

  // ── By session ─────────────────────────────────────────────────────────────
  const sessMap = new Map<string, { wins: number; losses: number; netPnL: number }>();
  for (const t of trades) {
    const sess = t.createdAt ? sessionFromDate(new Date(t.createdAt)) : 'Unknown';
    if (!sessMap.has(sess)) sessMap.set(sess, { wins: 0, losses: 0, netPnL: 0 });
    const s = sessMap.get(sess)!;
    if (t.status === 'win') s.wins++; else s.losses++;
    s.netPnL += t.pnl ?? 0;
  }
  const bySession = [...sessMap.entries()].map(([session, v]) => {
    const count = v.wins + v.losses;
    return {
      session, count,
      winRate: parseFloat(((v.wins / count) * 100).toFixed(1)),
      netPnL:  parseFloat(v.netPnL.toFixed(2)),
    };
  }).sort((a, b) => b.winRate - a.winRate);

  // ── By day ─────────────────────────────────────────────────────────────────
  const dayMap = new Map<string, { wins: number; losses: number }>();
  for (const t of trades) {
    const day = t.createdAt ? DAYS[new Date(t.createdAt).getUTCDay()] : 'Unknown';
    if (!dayMap.has(day)) dayMap.set(day, { wins: 0, losses: 0 });
    const d = dayMap.get(day)!;
    if (t.status === 'win') d.wins++; else d.losses++;
  }
  const byDay = DAYS.filter((d) => dayMap.has(d)).map((day) => {
    const d = dayMap.get(day)!;
    const count = d.wins + d.losses;
    return { day, count, winRate: parseFloat(((d.wins / count) * 100).toFixed(1)) };
  });

  // ── BUY vs SELL ────────────────────────────────────────────────────────────
  const buys  = trades.filter((t) => t.type === 'BUY');
  const sells = trades.filter((t) => t.type === 'SELL');
  const buyWinRate  = buys.length  > 0 ? parseFloat(((buys.filter((t)  => t.status === 'win').length / buys.length)  * 100).toFixed(1)) : 0;
  const sellWinRate = sells.length > 0 ? parseFloat(((sells.filter((t) => t.status === 'win').length / sells.length) * 100).toFixed(1)) : 0;

  // ── Holding tendency ───────────────────────────────────────────────────────
  const winDurs  = wins.map((t)   => parseDurMins(t.duration)).filter((d) => d > 0);
  const lossDurs = losses.map((t) => parseDurMins(t.duration)).filter((d) => d > 0);
  const avgWinDurationMin  = winDurs.length  > 0 ? Math.round(winDurs.reduce((a, b)  => a + b, 0) / winDurs.length)  : 0;
  const avgLossDurationMin = lossDurs.length > 0 ? Math.round(lossDurs.reduce((a, b) => a + b, 0) / lossDurs.length) : 0;
  let holdingTendency = 'insufficient data';
  if (winDurs.length >= 3 && lossDurs.length >= 3) {
    const ratio = avgWinDurationMin / (avgLossDurationMin || 1);
    if (ratio < 0.6)      holdingTendency = 'cuts winners too early';
    else if (ratio > 1.8) holdingTendency = 'lets losers run too long';
    else                  holdingTendency = 'balanced hold time';
  }

  // ── Recent streak ──────────────────────────────────────────────────────────
  const streakType = trades[0]?.status ?? 'none';
  let streakCount = 0;
  for (const t of trades) {
    if (t.status === streakType) streakCount++;
    else break;
  }

  // ── Last 10 win rate ───────────────────────────────────────────────────────
  const last10       = trades.slice(0, 10);
  const last10WinRate = last10.length > 0
    ? parseFloat(((last10.filter((t) => t.status === 'win').length / last10.length) * 100).toFixed(1))
    : 0;

  // ── Best/worst identifiers ─────────────────────────────────────────────────
  const sortedPairs    = [...byPair].sort((a, b) => b.winRate - a.winRate);
  const bestPair       = sortedPairs[0]?.pair    ?? null;
  const worstPair      = sortedPairs.length > 1 ? sortedPairs[sortedPairs.length - 1].pair : null;
  const bestSession    = bySession[0]?.session   ?? null;
  const bestDay        = [...byDay].sort((a, b) => b.winRate - a.winRate)[0]?.day ?? null;

  return {
    totalTrades: trades.length, winRate, profitFactor, avgRR,
    byPair, bySession, byDay,
    buyWinRate, sellWinRate,
    avgWinDurationMin, avgLossDurationMin, holdingTendency,
    recentStreak: { type: streakType, count: streakCount },
    last10WinRate,
    bestPair, worstPair, bestSession, bestDay,
  };
}
