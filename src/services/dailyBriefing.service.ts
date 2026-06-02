// src/services/dailyBriefing.service.ts
// Pre-session intelligence briefing generator.
//
// Aggregates 5 data sources into a single actionable summary for the trader:
//   1. Upcoming high-impact economic events
//   2. Best/worst regimes from Phase 5 regime comparison
//   3. Portfolio risk snapshot
//   4. Recent performance streak (win/loss)
//   5. Stability controller status from online learning
//
// Cached per user with a 30-minute TTL to avoid repeated DB queries.
// Non-blocking: always returns, even if individual sources fail.

import { Types } from 'mongoose';
import { getUpcomingHighImpactEvents } from './economicCalendar.service';
import { getRegimeWeightDocument } from './onlineLearning.service';
import { getPortfolioRisk } from './portfolioRisk.service';
import TradeEvent, { ITradeEvent } from '../models/TradeEvent.model';
import { VALID_PAIRS, ValidPair } from '../types/chart.types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PairPriority {
  pair:     ValidPair;
  priority: 'focus' | 'avoid' | 'neutral';
  reason:   string;
}

export interface BriefingStreak {
  type:  'win' | 'loss' | 'mixed';
  count: number;
}

export interface DailyBriefing {
  generated_at:          string;
  session:               string;
  // Market context
  high_impact_events_today: number;
  next_event:            string | null;
  avoid_trading_until:   string | null;  // ISO if event <30min away
  // Per-pair priority
  pair_priorities:       PairPriority[];
  // Account state
  current_streak:        BriefingStreak;
  weekly_expectancy_r:   number;
  open_risk_pct:         number;
  // Adaptive learning state
  best_regime_today:     string;
  learning_mode:         'normal' | 'stabilizing' | 'unknown';
  stability_note:        string;
  // Actionable output
  recommendations:       string[];
  cautions:              string[];
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, { data: DailyBriefing; expiresAt: number }>();
const TTL_MS = 30 * 60 * 1000;

// ─── Main generator ───────────────────────────────────────────────────────────

export async function getDailyBriefing(userId: string): Promise<DailyBriefing> {
  const cached = cache.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const utcHour = new Date().getUTCHours();
  const session = _sessionLabel(utcHour);

  const [events, regimeDoc, portfolioRisk, recentTrades] = await Promise.allSettled([
    getUpcomingHighImpactEvents(VALID_PAIRS[0] as ValidPair, 120),   // next 2h events for any USD pair
    getRegimeWeightDocument(userId),
    getPortfolioRisk(userId),
    _getRecentTrades(userId, 14),
  ]);

  const calendarEvents = events.status       === 'fulfilled' ? events.value       : [];
  const regDoc         = regimeDoc.status     === 'fulfilled' ? regimeDoc.value    : null;
  const riskSnapshot   = portfolioRisk.status === 'fulfilled' ? portfolioRisk.value : null;
  const trades         = recentTrades.status  === 'fulfilled' ? recentTrades.value  : [];

  // ── Events context ─────────────────────────────────────────────────────────
  const highImpact    = calendarEvents.filter((e: any) => e.impact === 'High');
  const nextEvent     = highImpact[0] ?? null;
  const nextEventMs   = nextEvent ? new Date(nextEvent.date).getTime() - Date.now() : Infinity;
  const tooClose      = nextEventMs < 30 * 60 * 1000 && nextEventMs > 0;

  // ── Regime intel ───────────────────────────────────────────────────────────
  let bestRegime  = 'unknown';
  let learningMode: 'normal' | 'stabilizing' | 'unknown' = 'unknown';
  let stabilityNote = 'No learning data yet.';

  if (regDoc) {
    const REGIME_KEYS = ['trend', 'range', 'compression', 'expansion'] as const;
    let bestExp = -Infinity;
    for (const k of REGIME_KEYS) {
      const sub = (regDoc as any)[k];
      if (sub && sub.sample_size >= 10 && sub.bias_weights?.bias_edge_diff > bestExp) {
        bestExp   = sub.bias_weights.bias_edge_diff;
        bestRegime = k;
      }
    }
    learningMode  = (regDoc.stability_state as any)?.mode ?? 'normal';
    stabilityNote = learningMode === 'stabilizing'
      ? `⚠️ Learning stabilizer active: ${(regDoc.stability_state as any)?.trigger_reason ?? 'reducing learning rate'}`
      : '✅ Adaptive weights operating normally.';
  }

  // ── Streak ────────────────────────────────────────────────────────────────
  const streak = _computeStreak(trades);

  // ── Weekly expectancy ─────────────────────────────────────────────────────
  const weekTrades = trades.filter((e) => new Date(e.timestamp).getTime() > Date.now() - 7 * 86_400_000);
  const weekR      = weekTrades.reduce((s, e) => s + (e.outcome === 'win' ? e.rr_ratio : e.outcome === 'breakeven' ? 0 : -1), 0);

  // ── Pair priorities ────────────────────────────────────────────────────────
  const pairPriorities = _buildPairPriorities(tooClose, riskSnapshot ?? null);

  // ── Recommendations ────────────────────────────────────────────────────────
  const recs: string[] = [];
  const cautions: string[] = [];

  if (tooClose && nextEvent) {
    cautions.push(`⏸ Hold trades — high-impact news in <30min: ${nextEvent.country} ${nextEvent.title}`);
  }
  if (riskSnapshot?.is_over_budget) {
    cautions.push(`🚫 Daily risk budget FULL (${riskSnapshot.total_risk_pct.toFixed(1)}%). No new positions.`);
  }
  if (riskSnapshot && riskSnapshot.risk_budget_used_pct > 70) {
    cautions.push(`⚠️ ${riskSnapshot.risk_budget_used_pct.toFixed(0)}% of daily risk used — reduce size or wait.`);
  }
  if (streak.type === 'loss' && streak.count >= 3) {
    cautions.push(`🛑 ${streak.count}-trade loss streak. Take a break before next entry.`);
  }
  if (session === 'London Open' || session === 'London-NY Overlap') {
    recs.push(`✅ ${session} — peak liquidity window. Prime conditions for XAU/USD and GBP/USD.`);
  }
  if (bestRegime !== 'unknown') {
    recs.push(`📈 Best performing regime this cycle: ${bestRegime.toUpperCase()}. Prioritise setups in ${bestRegime} conditions.`);
  }
  if (learningMode === 'normal' && recs.length < 2) {
    recs.push('🧠 Adaptive weights operating normally — confidence scores are historically calibrated.');
  }
  if (recs.length === 0) recs.push('📋 No specific bias for this session. Focus on A+ setups with strong structure.');

  const briefing: DailyBriefing = {
    generated_at:          new Date().toISOString(),
    session,
    high_impact_events_today: highImpact.length,
    next_event:            nextEvent ? `${nextEvent.country} ${nextEvent.title} @ ${new Date(nextEvent.date).toUTCString()}` : null,
    avoid_trading_until:   tooClose && nextEvent ? new Date(new Date(nextEvent.date).getTime() + 15 * 60 * 1000).toISOString() : null,
    pair_priorities:       pairPriorities,
    current_streak:        streak,
    weekly_expectancy_r:   parseFloat(weekR.toFixed(2)),
    open_risk_pct:         riskSnapshot?.total_risk_pct ?? 0,
    best_regime_today:     bestRegime,
    learning_mode:         learningMode,
    stability_note:        stabilityNote,
    recommendations:       recs,
    cautions,
  };

  cache.set(userId, { data: briefing, expiresAt: Date.now() + TTL_MS });
  return briefing;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function _getRecentTrades(userId: string, days: number): Promise<ITradeEvent[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  return TradeEvent.find({
    user_id:   new Types.ObjectId(userId),
    timestamp: { $gte: since },
    outcome:   { $in: ['win', 'loss', 'breakeven'] },
  }).sort({ timestamp: -1 }).limit(30).lean() as Promise<ITradeEvent[]>;
}

function _computeStreak(trades: ITradeEvent[]): BriefingStreak {
  if (trades.length === 0) return { type: 'mixed', count: 0 };
  const sorted = [...trades].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const first  = sorted[0].outcome;
  let count    = 0;
  for (const t of sorted) {
    if (t.outcome === first) count++;
    else break;
  }
  return { type: first === 'win' ? 'win' : first === 'loss' ? 'loss' : 'mixed', count };
}

function _buildPairPriorities(
  newsLockout: boolean,
  risk: { exposure_by_pair?: Record<string, { risk_pct: number }> } | null,
): PairPriority[] {
  return ([...VALID_PAIRS] as ValidPair[]).map((pair) => {
    if (newsLockout && (pair === 'EUR/USD' || pair === 'GBP/USD' || pair === 'USD/JPY')) {
      return { pair, priority: 'avoid', reason: 'High-impact USD news imminent' };
    }
    const existing = (risk as any)?.exposure_by_pair?.[pair];
    if (existing && existing.risk_pct > 2) {
      return { pair, priority: 'avoid', reason: `Already exposed: ${existing.risk_pct.toFixed(1)}% risk open` };
    }
    return { pair, priority: 'neutral', reason: 'No conflicts' };
  });
}

function _sessionLabel(h: number): string {
  if (h >= 22 || h < 7)  return 'Asian';
  if (h >= 7  && h < 12) return 'London Open';
  if (h >= 12 && h < 17) return 'London-NY Overlap';
  return 'New York';
}
