// Auto-trader orchestrator.
// When a signal is generated with autoTradeRecommended=true, this service:
//   1. Checks the user's autoTrade settings and daily limits
//   2. Computes lot size from balance × riskPct
//   3. Creates a PendingExecution (PENDING_APPROVAL)
//   4. Frontend picks it up and shows the 60-second confirmation modal

import { Types } from 'mongoose';
import crypto from 'crypto';
import User from '../models/User.model';
import PendingExecution from '../models/PendingExecution.model';
import Trade from '../models/Trade.model';
import { getAutoTradeHealth } from './signalAccuracy.service';
import { ISignal } from '../types/signal.types';
import { ValidPair } from '../types/chart.types';

// Pip size per pair (1 pip in price units)
function pipSize(pair: string): number {
  if (pair === 'USD/JPY') return 0.01;
  if (pair === 'XAU/USD') return 0.01;
  return 0.0001;
}

// Pip value per standard lot in USD
function pipValuePerLot(pair: string): number {
  if (pair === 'USD/JPY') return 9.3;
  if (pair === 'XAU/USD') return 1;   // 100 oz × $0.01/pip
  return 10;
}

export async function triggerAutoTrade(signal: ISignal): Promise<void> {
  if (!signal.autoTradeRecommended || signal.signal === 'HOLD') return;
  if (!signal._id) return;

  try {
    // ── Fetch user + settings ──────────────────────────────────────────────
    const user = await User.findById(signal.userId).lean();
    if (!user?.autoTrade?.enabled) return;

    // ── Only A+ quality signals trigger auto-trade ─────────────────────────
    if ((signal as any).qualityTier && (signal as any).qualityTier !== 'A+') {
      console.log(`[AutoTrader] Skipped ${signal.pair} ${signal.signal} — quality tier ${(signal as any).qualityTier} (A+ required)`);
      return;
    }

    const settings = user.autoTrade;

    // ── Check if already queued for this signal ────────────────────────────
    const alreadyQueued = await PendingExecution.exists({ signalId: signal._id });
    if (alreadyQueued) return;

    // ── Losing-streak circuit breaker ─────────────────────────────────────
    const health = await getAutoTradeHealth(String(signal.userId));
    if (health.suspended) {
      console.log(`[AutoTrader] Suspended for user ${signal.userId}: ${health.reason}`);
      return;
    }

    // ── Max 2 concurrent open auto-trades ────────────────────────────────
    const openAutoTrades = await Trade.countDocuments({
      userId: signal.userId,
      status: 'open',
      source: 'ai_auto',
    });
    if (openAutoTrades >= 2) {
      console.log(`[AutoTrader] Max concurrent trades reached (${openAutoTrades}/2) for user ${signal.userId}`);
      return;
    }

    // ── Daily trade limit ──────────────────────────────────────────────────
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayCount = await PendingExecution.countDocuments({
      userId:    signal.userId,
      status:    { $in: ['APPROVED', 'EXECUTING', 'EXECUTED'] },
      createdAt: { $gte: todayStart },
    });
    if (todayCount >= settings.maxDailyTrades) return;

    // ── Daily loss limit ───────────────────────────────────────────────────
    const todayPnl = await Trade.aggregate([
      { $match: {
        userId:    signal.userId,
        status:    { $in: ['win', 'loss'] },
        updatedAt: { $gte: todayStart },
        source:    'ai_auto',
      }},
      { $group: { _id: null, total: { $sum: '$pnl' } } },
    ]);
    const dayPnl = todayPnl[0]?.total ?? 0;
    const maxDailyLoss = -(user.simulationBalance * (settings.maxDailyLossPct / 100));
    if (dayPnl <= maxDailyLoss) {
      console.log(`[AutoTrader] Daily loss limit reached for user ${signal.userId}`);
      return;
    }

    // ── Lot size calculation ───────────────────────────────────────────────
    const riskPct   = settings.defaultRiskPct;
    const balance   = user.simulationBalance;
    const riskUSD   = balance * (riskPct / 100);
    const ps        = pipSize(signal.pair);
    const slPips    = signal.pipsToSL ?? Math.round(Math.abs(signal.entry - signal.stopLoss) / ps);
    const pipVal    = pipValuePerLot(signal.pair);
    const rawLots   = slPips > 0 ? riskUSD / (slPips * pipVal) : 0.01;

    // Hard cap: never more than 0.5 standard lots per trade, and never exceed 5% balance risk
    const MAX_LOTS        = 0.5;
    const maxLotsByRisk   = slPips > 0 ? (balance * 0.05) / (slPips * pipVal) : MAX_LOTS;
    const lots = Math.max(0.01, Math.min(
      Math.floor(rawLots * 100) / 100,
      Math.floor(maxLotsByRisk * 100) / 100,
      MAX_LOTS,
    ));

    // ── Create pending execution ───────────────────────────────────────────
    const approvalExpiresAt = new Date(Date.now() + 60_000); // 60-second window

    await PendingExecution.create({
      userId:          signal.userId,
      signalId:        signal._id,
      pair:            signal.pair,
      direction:       signal.signal,
      entry:           signal.entry,
      stopLoss:        signal.stopLoss,
      takeProfit:      signal.takeProfit,
      lots,
      riskPct,
      riskReward:      signal.riskReward,
      pipsToSL:        signal.pipsToSL   ?? slPips,
      pipsToTP:        signal.pipsToTP   ?? 0,
      confluenceScore: signal.confluenceScore ?? 0,
      confidence:      signal.confidence,
      reasoning:       signal.reasoning,
      entryType:       signal.entryType  ?? 'MARKET',
      status:          'PENDING_APPROVAL',
      approvalExpiresAt,
    });

    console.log(`[AutoTrader] Queued execution for ${signal.pair} ${signal.signal} — ${lots} lots`);
  } catch (err) {
    console.error('[AutoTrader] Failed to queue execution:', err);
  }
}

// Expire PENDING_APPROVAL executions whose window has passed
// Called periodically (every 30s) from index.ts
export async function expireStaleExecutions(): Promise<void> {
  try {
    const result = await PendingExecution.updateMany(
      { status: 'PENDING_APPROVAL', approvalExpiresAt: { $lt: new Date() } },
      { $set: { status: 'EXPIRED' } },
    );
    if (result.modifiedCount > 0) {
      console.log(`[AutoTrader] Expired ${result.modifiedCount} stale pending executions`);
    }
  } catch (err) {
    console.error('[AutoTrader] expireStaleExecutions error:', err);
  }
}

// Generate a new MT5 API key for a user
export function generateApiKey(): string {
  return crypto.randomBytes(24).toString('hex'); // 48-char hex key
}
