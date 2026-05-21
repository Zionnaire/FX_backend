// Signal accuracy tracking — the learning loop.
//
// Flow:
//   1. evaluatePendingSignals() runs on a schedule (every 30 min).
//      It finds signals whose timeHorizon has elapsed and no accuracy record exists yet.
//      It fetches the current price and records whether the signal was correct.
//
//   2. getAccuracyContext(userId, pair, timeframe) returns a short natural-language
//      summary injected into every new signal prompt, so the AI can self-correct.

import Signal from '../models/Signal.model';
import SignalAccuracy from '../models/SignalAccuracy.model';
import { getOHLCV } from './chart.service';
import { VALID_PAIRS, VALID_TIMEFRAMES, ValidPair, ValidTimeframe } from '../types/chart.types';
import mongoose from 'mongoose';

// Maps timeHorizon strings like "2-6 hours", "1-4 hours", "Next 24h" to milliseconds
function parseHorizonMs(horizon: string): number {
  const lower = (horizon || '').toLowerCase();

  const rangeMatch = lower.match(/(\d+)\s*[-–]\s*(\d+)\s*(h|hour|m|min)/);
  if (rangeMatch) {
    const avg    = (parseInt(rangeMatch[1]) + parseInt(rangeMatch[2])) / 2;
    const isHour = rangeMatch[3].startsWith('h');
    return avg * (isHour ? 3_600_000 : 60_000);
  }

  const singleMatch = lower.match(/(\d+)\s*(h|hour|d|day)/);
  if (singleMatch) {
    const n      = parseInt(singleMatch[1]);
    const isDay  = singleMatch[2].startsWith('d');
    return n * (isDay ? 86_400_000 : 3_600_000);
  }

  return 4 * 3_600_000; // default: 4 hours
}

// Returns pip size for a pair (used to measure directional move)
function pipSize(pair: string): number {
  if (pair === 'XAU/USD') return 0.1;   // gold: 1 pip = $0.10
  if (pair === 'USD/JPY') return 0.01;  // yen: 2 decimal places
  return 0.0001;                        // standard 4-decimal pairs
}

// ─── Evaluate pending signals ─────────────────────────────────────────────────

export async function evaluatePendingSignals(): Promise<void> {
  const now = new Date();

  // Find signals older than 1 hour that have no accuracy record yet
  const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const signals = await Signal.find({ createdAt: { $lt: cutoff } }).lean();

  if (signals.length === 0) return;

  // Get signal IDs already evaluated
  const evaluated = new Set(
    (await SignalAccuracy.find({ signalId: { $in: signals.map((s) => s._id) } })
      .select('signalId')
      .lean()
    ).map((a) => String(a.signalId)),
  );

  const pending = signals.filter((s) => !evaluated.has(String(s._id)));
  if (pending.length === 0) return;

  console.info(`[accuracy] Evaluating ${pending.length} pending signals`);

  for (const sig of pending) {
    try {
      const horizonMs  = parseHorizonMs(sig.timeHorizon || '4 hours');
      const signalAge  = now.getTime() - new Date(sig.createdAt ?? now).getTime();
      if (signalAge < horizonMs) continue; // not enough time has passed yet

      const candles = await getOHLCV(sig.pair, sig.timeframe as ValidTimeframe);
      if (candles.length === 0) continue;

      const checkPrice  = candles[candles.length - 1].close;
      const ps          = pipSize(sig.pair);
      const rawMove     = checkPrice - sig.entry;
      const pipMove     = Math.round((rawMove / ps) * 10) / 10;

      const movedUp   = rawMove > ps;
      const movedDown = rawMove < -ps;

      let wasCorrect = false;
      let outcome: ISignalAccuracyOutcome = 'flat';

      if (sig.signal === 'BUY') {
        wasCorrect = movedUp;
        if (sig.takeProfit && checkPrice >= sig.takeProfit)     outcome = 'tp_hit';
        else if (sig.stopLoss && checkPrice <= sig.stopLoss)    outcome = 'sl_hit';
        else if (movedUp)                                       outcome = 'moved_correct';
        else if (movedDown)                                     outcome = 'moved_wrong';
        else                                                    outcome = 'flat';
      } else if (sig.signal === 'SELL') {
        wasCorrect = movedDown;
        if (sig.takeProfit && checkPrice <= sig.takeProfit)     outcome = 'tp_hit';
        else if (sig.stopLoss && checkPrice >= sig.stopLoss)    outcome = 'sl_hit';
        else if (movedDown)                                     outcome = 'moved_correct';
        else if (movedUp)                                       outcome = 'moved_wrong';
        else                                                    outcome = 'flat';
      } else {
        // HOLD — correct if move is less than 10 pips in either direction
        wasCorrect = Math.abs(pipMove) < 10;
        outcome    = wasCorrect ? 'flat' : (movedUp ? 'moved_wrong' : 'moved_wrong');
      }

      await SignalAccuracy.create({
        userId:          sig.userId,
        signalId:        sig._id,
        pair:            sig.pair,
        timeframe:       sig.timeframe,
        predictedSignal: sig.signal,
        confidence:      sig.confidence,
        entryPrice:      sig.entry,
        checkPrice,
        pipMove,
        wasCorrect,
        outcome,
        patterns:        Array.isArray(sig.patterns) ? sig.patterns : [],
        checkedAt:       now,
      });

    } catch (err) {
      console.warn(`[accuracy] Failed to evaluate signal ${sig._id}:`, (err as Error).message);
    }
  }
}

type ISignalAccuracyOutcome = 'tp_hit' | 'sl_hit' | 'moved_correct' | 'moved_wrong' | 'flat';

// ─── Accuracy context for prompt injection ────────────────────────────────────
// Returns a concise natural-language summary of past accuracy on this pair/TF.
// Injected into the signal generation prompt so the AI can self-calibrate.

export async function getAccuracyContext(
  userId: string,
  pair: string,
  timeframe: string,
): Promise<string> {
  const userObjId = new mongoose.Types.ObjectId(userId);

  // Last 20 evaluated signals for this pair + timeframe
  const records = await SignalAccuracy.find({
    userId:    userObjId,
    pair,
    timeframe,
  })
    .sort({ checkedAt: -1 })
    .limit(20)
    .lean();

  if (records.length < 3) return ''; // not enough data yet

  const total   = records.length;
  const correct = records.filter((r) => r.wasCorrect).length;
  const pct     = Math.round((correct / total) * 100);

  const byDir = { BUY: { n: 0, c: 0 }, SELL: { n: 0, c: 0 }, HOLD: { n: 0, c: 0 } };
  for (const r of records) {
    const dir = r.predictedSignal as 'BUY' | 'SELL' | 'HOLD';
    byDir[dir].n++;
    if (r.wasCorrect) byDir[dir].c++;
  }

  const dirLines = (['BUY', 'SELL', 'HOLD'] as const)
    .filter((d) => byDir[d].n >= 2)
    .map((d) => {
      const acc = Math.round((byDir[d].c / byDir[d].n) * 100);
      return `${d}: ${acc}% (${byDir[d].c}/${byDir[d].n})`;
    })
    .join(', ');

  const tpHits = records.filter((r) => r.outcome === 'tp_hit').length;
  const slHits = records.filter((r) => r.outcome === 'sl_hit').length;
  const avgPips = Math.round(
    records.reduce((s, r) => s + Math.abs(r.pipMove), 0) / total,
  );

  return [
    `PAST ACCURACY on ${pair} ${timeframe} (last ${total} signals):`,
    `  Overall: ${pct}% correct  |  ${dirLines}`,
    `  TP hit: ${tpHits}×  |  SL hit: ${slHits}×  |  Avg move: ${avgPips} pips`,
    `  Use this to calibrate confidence — if accuracy is low, widen uncertainty range.`,
  ].join('\n');
}

// ─── Auto-trade health check ──────────────────────────────────────────────────
// Returns the rolling win rate of the last N directional signals.
// If it drops below 45%, auto-trading is suspended to protect the account.

export async function getAutoTradeHealth(userId: string): Promise<{
  rolling20WinRate: number;
  suspended:        boolean;
  reason?:          string;
}> {
  const userObjId = new mongoose.Types.ObjectId(userId);

  const recent = await SignalAccuracy.find({
    userId:          userObjId,
    predictedSignal: { $in: ['BUY', 'SELL'] }, // HOLDs are not directional bets
  })
    .sort({ checkedAt: -1 })
    .limit(20)
    .lean();

  // Need at least 10 evaluated signals before enforcing the brake
  if (recent.length < 10) {
    return { rolling20WinRate: 100, suspended: false };
  }

  const wins    = recent.filter((r) => r.wasCorrect).length;
  const winRate = Math.round((wins / recent.length) * 100);

  if (winRate < 45) {
    return {
      rolling20WinRate: winRate,
      suspended:        true,
      reason: `Rolling ${recent.length}-signal win rate is ${winRate}% — below 45% safety threshold. Auto-trade suspended until accuracy recovers.`,
    };
  }

  return { rolling20WinRate: winRate, suspended: false };
}

// ─── Accuracy stats for analytics endpoint ────────────────────────────────────

export async function getSignalAccuracyStats(userId: string) {
  const userObjId = new mongoose.Types.ObjectId(userId);

  const all = await SignalAccuracy.find({ userId: userObjId })
    .sort({ checkedAt: -1 })
    .limit(100)
    .lean();

  if (all.length === 0) {
    return { total: 0, correct: 0, accuracy: 0, byPair: [], byTimeframe: [] };
  }

  const correct  = all.filter((r) => r.wasCorrect).length;
  const accuracy = Math.round((correct / all.length) * 100);

  // Group by pair
  const pairMap = new Map<string, { total: number; correct: number }>();
  for (const r of all) {
    const entry = pairMap.get(r.pair) ?? { total: 0, correct: 0 };
    entry.total++;
    if (r.wasCorrect) entry.correct++;
    pairMap.set(r.pair, entry);
  }

  // Group by timeframe
  const tfMap = new Map<string, { total: number; correct: number }>();
  for (const r of all) {
    const entry = tfMap.get(r.timeframe) ?? { total: 0, correct: 0 };
    entry.total++;
    if (r.wasCorrect) entry.correct++;
    tfMap.set(r.timeframe, entry);
  }

  // Group by pattern — each signal may have multiple patterns
  const patternMap = new Map<string, { total: number; correct: number }>();
  for (const r of all) {
    for (const p of (r.patterns ?? [])) {
      const entry = patternMap.get(p) ?? { total: 0, correct: 0 };
      entry.total++;
      if (r.wasCorrect) entry.correct++;
      patternMap.set(p, entry);
    }
  }

  return {
    total:   all.length,
    correct,
    accuracy,
    byPair: Array.from(pairMap.entries()).map(([pair, v]) => ({
      pair,
      total:    v.total,
      correct:  v.correct,
      accuracy: Math.round((v.correct / v.total) * 100),
    })),
    byTimeframe: Array.from(tfMap.entries()).map(([timeframe, v]) => ({
      timeframe,
      total:    v.total,
      correct:  v.correct,
      accuracy: Math.round((v.correct / v.total) * 100),
    })),
    byPattern: Array.from(patternMap.entries())
      .filter(([, v]) => v.total >= 2)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([pattern, v]) => ({
        pattern,
        total:    v.total,
        correct:  v.correct,
        accuracy: Math.round((v.correct / v.total) * 100),
      })),
    recentRecords: all.slice(0, 20).map((r) => ({
      pair:            r.pair,
      timeframe:       r.timeframe,
      predictedSignal: r.predictedSignal,
      confidence:      r.confidence,
      wasCorrect:      r.wasCorrect,
      outcome:         r.outcome,
      pipMove:         r.pipMove,
      patterns:        r.patterns ?? [],
      checkedAt:       r.checkedAt,
    })),
  };
}
