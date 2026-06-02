// src/services/behaviorAnalytics.service.ts
// Behavioral pattern detection engine.
//
// Analyzes TradeEvent history to surface psychological risk patterns that most
// platforms ignore: revenge trading, overtrading, tilt sequences, and time biases.
//
// All computations are read-only and non-blocking.
// The "psychological_score" is a composite 0–100 metric — higher = more disciplined.

import { Types } from 'mongoose';
import TradeEvent, { ITradeEvent } from '../models/TradeEvent.model';

// ─── Constants ────────────────────────────────────────────────────────────────

const REVENGE_WINDOW_MS    = 10 * 60 * 1000;  // 10 minutes after a loss
const TILT_SEQUENCE_COUNT  = 3;               // 3+ losses in a row = tilt
const TILT_WINDOW_MS       = 2 * 60 * 60 * 1000; // within 2 hours
const OVERTRADE_PER_SESSION = 4;              // > 4 trades in one session = overtrading

// ─── Output types ─────────────────────────────────────────────────────────────

export type PatternType =
  | 'revenge_trading'
  | 'overtrading'
  | 'tilt'
  | 'time_bias'
  | 'session_bias'
  | 'day_of_week_bias';

export interface BehaviorPattern {
  type:                 PatternType;
  severity:             'low' | 'medium' | 'high';
  description:          string;
  occurrences:          number;
  estimated_r_cost:     number;   // approx R lost due to this pattern
  recommendation:       string;
}

export interface HourlyPerformance {
  utc_hour:    number;
  win_rate:    number;
  expectancy:  number;
  trade_count: number;
}

export interface DayPerformance {
  day:         string;   // 'Monday' … 'Friday'
  win_rate:    number;
  expectancy:  number;
  trade_count: number;
}

export interface BehaviorReport {
  generated_at:              string;
  lookback_days:             number;
  total_closed_trades:       number;
  revenge_trading_incidents: number;
  overtrade_sessions:        number;
  tilt_sequences:            number;
  psychological_score:       number;   // 0–100 (100 = fully disciplined)
  best_hour_utc:             number | null;
  worst_hour_utc:            number | null;
  best_day:                  string | null;
  worst_day:                 string | null;
  hourly_performance:        HourlyPerformance[];
  daily_performance:         DayPerformance[];
  patterns:                  BehaviorPattern[];
  summary:                   string;
}

// ─── Main generator ───────────────────────────────────────────────────────────

export async function getBehaviorReport(
  userId:       string,
  lookbackDays: number = 90,
): Promise<BehaviorReport> {
  const since   = new Date(Date.now() - lookbackDays * 86_400_000);
  const userOid = new Types.ObjectId(userId);

  const events = await TradeEvent.find({
    user_id:   userOid,
    timestamp: { $gte: since },
  }).sort({ timestamp: 1 }).lean() as ITradeEvent[];

  const closed = events.filter((e) => e.outcome !== 'open');
  const patterns: BehaviorPattern[] = [];

  // ── Revenge trading detection ──────────────────────────────────────────────
  const revengeIncidents = _detectRevengeTrades(closed);
  if (revengeIncidents > 0) {
    const rCost = _estimateRevengeRCost(closed);
    patterns.push({
      type:             'revenge_trading',
      severity:         revengeIncidents >= 5 ? 'high' : revengeIncidents >= 2 ? 'medium' : 'low',
      description:      `${revengeIncidents} trades entered within ${REVENGE_WINDOW_MS / 60000} minutes of a loss`,
      occurrences:      revengeIncidents,
      estimated_r_cost: rCost,
      recommendation:   'Enforce a mandatory 10-minute cooldown after any stop-out. Walk away from the screen.',
    });
  }

  // ── Overtrading detection ──────────────────────────────────────────────────
  const overtradeSessions = _detectOvertradeSessions(events);
  if (overtradeSessions > 0) {
    patterns.push({
      type:             'overtrading',
      severity:         overtradeSessions >= 4 ? 'high' : 'medium',
      description:      `${overtradeSessions} sessions with more than ${OVERTRADE_PER_SESSION} trades`,
      occurrences:      overtradeSessions,
      estimated_r_cost: overtradeSessions * 0.5,
      recommendation:   `Cap entries at ${OVERTRADE_PER_SESSION} per session. Quality over quantity.`,
    });
  }

  // ── Tilt detection (consecutive losses in short window) ───────────────────
  const tiltSequences = _detectTiltSequences(closed);
  if (tiltSequences > 0) {
    patterns.push({
      type:             'tilt',
      severity:         tiltSequences >= 3 ? 'high' : 'medium',
      description:      `${tiltSequences} sequences of ${TILT_SEQUENCE_COUNT}+ consecutive losses within 2 hours`,
      occurrences:      tiltSequences,
      estimated_r_cost: tiltSequences * 1.5,
      recommendation:   'After 3 consecutive losses, stop trading for the day. No exceptions.',
    });
  }

  // ── Hourly performance (time bias) ────────────────────────────────────────
  const hourlyPerf = _buildHourlyPerformance(closed);
  const worstHours = hourlyPerf.filter((h) => h.trade_count >= 3).sort((a, b) => a.expectancy - b.expectancy);
  const bestHours  = [...hourlyPerf].sort((a, b) => b.expectancy - a.expectancy);

  if (worstHours.length > 0 && worstHours[0].expectancy < -0.3) {
    patterns.push({
      type:             'time_bias',
      severity:         worstHours[0].expectancy < -0.8 ? 'high' : 'medium',
      description:      `Trades entered at ${worstHours[0].utc_hour}:00 UTC have ${worstHours[0].expectancy.toFixed(2)}R expectancy`,
      occurrences:      worstHours[0].trade_count,
      estimated_r_cost: Math.abs(worstHours[0].expectancy * worstHours[0].trade_count),
      recommendation:   `Avoid trading at ${worstHours[0].utc_hour}:00 UTC. Your historical edge disappears here.`,
    });
  }

  // ── Day-of-week performance ───────────────────────────────────────────────
  const dailyPerf  = _buildDailyPerformance(closed);
  const worstDay   = [...dailyPerf].sort((a, b) => a.expectancy - b.expectancy)[0];
  const bestDay    = [...dailyPerf].sort((a, b) => b.expectancy - a.expectancy)[0];

  if (worstDay && worstDay.trade_count >= 5 && worstDay.expectancy < -0.2) {
    patterns.push({
      type:             'day_of_week_bias',
      severity:         'low',
      description:      `${worstDay.day} shows ${worstDay.expectancy.toFixed(2)}R expectancy across ${worstDay.trade_count} trades`,
      occurrences:      worstDay.trade_count,
      estimated_r_cost: Math.abs(worstDay.expectancy * worstDay.trade_count),
      recommendation:   `Consider reducing position size or skipping ${worstDay.day} altogether.`,
    });
  }

  // ── Psychological score ───────────────────────────────────────────────────
  const pscore = _computePsychScore(revengeIncidents, overtradeSessions, tiltSequences, closed.length);

  return {
    generated_at:              new Date().toISOString(),
    lookback_days:             lookbackDays,
    total_closed_trades:       closed.length,
    revenge_trading_incidents: revengeIncidents,
    overtrade_sessions:        overtradeSessions,
    tilt_sequences:            tiltSequences,
    psychological_score:       pscore,
    best_hour_utc:             bestHours[0]?.trade_count >= 3 ? bestHours[0].utc_hour : null,
    worst_hour_utc:            worstHours[0]?.trade_count >= 3 ? worstHours[0].utc_hour : null,
    best_day:                  bestDay?.trade_count >= 5 ? bestDay.day : null,
    worst_day:                 worstDay?.trade_count >= 5 ? worstDay.day : null,
    hourly_performance:        hourlyPerf,
    daily_performance:         dailyPerf,
    patterns,
    summary:                   _buildSummary(pscore, patterns),
  };
}

// ─── Pattern detectors ────────────────────────────────────────────────────────

function _detectRevengeTrades(events: ITradeEvent[]): number {
  let count = 0;
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    if (prev.outcome !== 'loss') continue;
    const gap = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
    if (gap <= REVENGE_WINDOW_MS) count++;
  }
  return count;
}

function _estimateRevengeRCost(events: ITradeEvent[]): number {
  let cost = 0;
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    if (prev.outcome !== 'loss') continue;
    const gap = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
    if (gap <= REVENGE_WINDOW_MS && curr.outcome === 'loss') cost += 1;
  }
  return cost;
}

function _detectOvertradeSessions(events: ITradeEvent[]): number {
  const sessionMap = new Map<string, number>();
  for (const e of events) {
    const dayKey     = new Date(e.timestamp).toISOString().slice(0, 10);
    const sessionKey = `${dayKey}__${e.session}`;
    sessionMap.set(sessionKey, (sessionMap.get(sessionKey) ?? 0) + 1);
  }
  return [...sessionMap.values()].filter((n) => n > OVERTRADE_PER_SESSION).length;
}

function _detectTiltSequences(events: ITradeEvent[]): number {
  let sequences = 0;
  let i = 0;
  while (i < events.length) {
    const losses: ITradeEvent[] = [];
    let j = i;
    while (j < events.length && events[j].outcome === 'loss') {
      losses.push(events[j]);
      j++;
    }
    if (losses.length >= TILT_SEQUENCE_COUNT) {
      const span = new Date(losses[losses.length - 1].timestamp).getTime() -
                   new Date(losses[0].timestamp).getTime();
      if (span <= TILT_WINDOW_MS) sequences++;
    }
    i = j === i ? i + 1 : j;
  }
  return sequences;
}

// ─── Time performance builders ────────────────────────────────────────────────

function _buildHourlyPerformance(events: ITradeEvent[]): HourlyPerformance[] {
  const map = new Map<number, ITradeEvent[]>();
  for (const e of events) {
    const h = new Date(e.timestamp).getUTCHours();
    if (!map.has(h)) map.set(h, []);
    map.get(h)!.push(e);
  }

  return Array.from(map.entries())
    .map(([utc_hour, evts]) => {
      const wins = evts.filter((e) => e.outcome === 'win').length;
      const rArr = evts.map((e) => e.outcome === 'win' ? e.rr_ratio : e.outcome === 'breakeven' ? 0 : -1);
      const exp  = rArr.reduce((s, r) => s + r, 0) / evts.length;
      return {
        utc_hour,
        win_rate:    parseFloat(((wins / evts.length) * 100).toFixed(1)),
        expectancy:  parseFloat(exp.toFixed(3)),
        trade_count: evts.length,
      };
    })
    .sort((a, b) => a.utc_hour - b.utc_hour);
}

function _buildDailyPerformance(events: ITradeEvent[]): DayPerformance[] {
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const map  = new Map<number, ITradeEvent[]>();

  for (const e of events) {
    const d = new Date(e.timestamp).getUTCDay();
    if (!map.has(d)) map.set(d, []);
    map.get(d)!.push(e);
  }

  return Array.from(map.entries())
    .filter(([d]) => d >= 1 && d <= 5)  // Mon–Fri only
    .map(([d, evts]) => {
      const wins = evts.filter((e) => e.outcome === 'win').length;
      const rArr = evts.map((e) => e.outcome === 'win' ? e.rr_ratio : e.outcome === 'breakeven' ? 0 : -1);
      const exp  = rArr.reduce((s, r) => s + r, 0) / evts.length;
      return {
        day:         DAYS[d],
        win_rate:    parseFloat(((wins / evts.length) * 100).toFixed(1)),
        expectancy:  parseFloat(exp.toFixed(3)),
        trade_count: evts.length,
      };
    })
    .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day));
}

// ─── Psychological score ──────────────────────────────────────────────────────

function _computePsychScore(
  revenge: number, overtrade: number, tilt: number, total: number,
): number {
  if (total === 0) return 100;
  let score = 100;
  score -= Math.min(30, (revenge  / total) * 100 * 2);
  score -= Math.min(25, (overtrade / Math.max(total / 4, 1)) * 30);
  score -= Math.min(25, tilt * 8);
  return Math.max(0, Math.round(score));
}

function _buildSummary(score: number, patterns: BehaviorPattern[]): string {
  const high = patterns.filter((p) => p.severity === 'high');
  if (score >= 85) return 'Excellent discipline. Your psychological metrics are clean.';
  if (score >= 65) return `Good discipline overall. ${high.length > 0 ? `Address: ${high.map((p) => p.type.replace('_', ' ')).join(', ')}.` : ''}`;
  if (score >= 45) return `Moderate risk behavior detected. Priority fixes: ${patterns.slice(0, 2).map((p) => p.type.replace('_', ' ')).join(', ')}.`;
  return `High behavioral risk. ${patterns.length} patterns found — tilt, revenge trading, or overtrading is costing R.`;
}
