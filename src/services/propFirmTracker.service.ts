// src/services/propFirmTracker.service.ts
// Prop firm challenge lifecycle manager.
//
// Handles: challenge creation, live balance updates, rule-breach detection,
// daily limit resets, and the isTradeAllowed circuit breaker.
//
// isTradeAllowed() is called by autoTrader.service BEFORE queuing any execution.
// If the challenge limit is breached, the auto-trader is blocked and the user
// receives a Telegram alert.

import { Types } from 'mongoose';
import PropFirmChallenge, { IPropFirmChallenge } from '../models/PropFirmChallenge.model';
import Trade from '../models/Trade.model';
import { notifyTelegram, formatPropFirmWarning } from './telegram.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChallengeConfig {
  firm_name:            string;
  phase:                'challenge' | 'verification' | 'funded';
  account_size:         number;
  daily_loss_limit_pct: number;
  max_drawdown_pct:     number;
  profit_target_pct:    number;
  min_trading_days?:    number;
  max_trading_days?:    number;
}

export interface ChallengeStatus {
  challenge:               IPropFirmChallenge;
  daily_loss_used_pct:     number;
  daily_loss_remaining_pct:number;
  total_drawdown_pct:      number;
  profit_progress_pct:     number;
  trading_days_remaining:  number | null;
  is_near_daily_limit:     boolean;  // > 70% of daily limit used
  is_near_drawdown_limit:  boolean;  // > 80% of drawdown limit used
  is_passed:               boolean;
  is_failed:               boolean;
  can_trade:               boolean;
  block_reason:            string | null;
}

export interface TradeAllowedResult {
  allowed:     boolean;
  reason:      string | null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createChallenge(
  userId: string,
  config: ChallengeConfig,
): Promise<IPropFirmChallenge> {
  const userOid = new Types.ObjectId(userId);

  // Deactivate any existing active challenge
  await PropFirmChallenge.updateMany({ user_id: userOid, is_active: true }, { $set: { is_active: false } });

  return PropFirmChallenge.create({
    user_id:               userOid,
    firm_name:             config.firm_name,
    phase:                 config.phase,
    account_size:          config.account_size,
    daily_loss_limit_pct:  config.daily_loss_limit_pct,
    max_drawdown_pct:      config.max_drawdown_pct,
    profit_target_pct:     config.profit_target_pct,
    min_trading_days:      config.min_trading_days ?? 4,
    max_trading_days:      config.max_trading_days ?? 30,
    starting_balance:      config.account_size,
    current_balance:       config.account_size,
    daily_high_balance:    config.account_size,
    all_time_high_balance: config.account_size,
    trading_days_used:     0,
    status:                'active',
    is_active:             true,
  });
}

export async function getChallengeStatus(userId: string): Promise<ChallengeStatus | null> {
  const challenge = await _getActive(userId);
  if (!challenge) return null;
  return _buildStatus(challenge);
}

/** Returns all challenges for history view. */
export async function getChallengeHistory(userId: string): Promise<IPropFirmChallenge[]> {
  return PropFirmChallenge.find({ user_id: new Types.ObjectId(userId) })
    .sort({ createdAt: -1 })
    .lean() as Promise<IPropFirmChallenge[]>;
}

/**
 * Called when a trade closes. Updates the challenge balance and checks for
 * rule breaches. Returns true if the challenge was failed or passed.
 */
export async function onTradeClosed(
  userId:     string,
  tradePnl:   number,   // USD profit/loss
  pair:       string,
): Promise<void> {
  const challenge = await _getActive(userId);
  if (!challenge) return;

  const newBalance   = challenge.current_balance + tradePnl;
  const newATH       = Math.max(challenge.all_time_high_balance, newBalance);
  const dayBalance   = Math.max(challenge.daily_high_balance, newBalance);

  // Record trading day
  const todayKey = new Date().toISOString().slice(0, 10);
  const lastDay  = (challenge as any).updatedAt
    ? new Date((challenge as any).updatedAt as Date).toISOString().slice(0, 10)
    : '';
  const newDayCount = todayKey !== lastDay
    ? challenge.trading_days_used + 1
    : challenge.trading_days_used;

  await PropFirmChallenge.findByIdAndUpdate(challenge._id, {
    $set: {
      current_balance:       newBalance,
      all_time_high_balance: newATH,
      daily_high_balance:    dayBalance,
      trading_days_used:     newDayCount,
    },
  });

  // Reload for breach check
  const updated = await PropFirmChallenge.findById(challenge._id).lean() as IPropFirmChallenge;
  const status  = _buildStatus(updated);

  // Send Telegram warning if approaching daily limit
  if (status.is_near_daily_limit && !status.is_failed) {
    notifyTelegram(userId, 'on_circuit_breaker',
      formatPropFirmWarning(status.daily_loss_used_pct, updated.daily_loss_limit_pct, pair),
    ).catch(() => {});
  }

  // Check and apply failure / pass
  if (status.is_failed && updated.status === 'active') {
    await PropFirmChallenge.findByIdAndUpdate(challenge._id, {
      $set: { status: 'failed', failure_reason: status.block_reason, is_active: false },
    });
    notifyTelegram(userId, 'on_circuit_breaker',
      `❌ Prop firm challenge FAILED — ${status.block_reason}`,
    ).catch(() => {});
    return;
  }

  if (status.is_passed && updated.status === 'active') {
    await PropFirmChallenge.findByIdAndUpdate(challenge._id, {
      $set: { status: 'passed', passed_at: new Date() },
    });
    notifyTelegram(userId, 'on_circuit_breaker',
      `🎉 Prop firm challenge PASSED! Profit target reached on ${updated.firm_name}.`,
    ).catch(() => {});
  }
}

/**
 * Call once per day (at midnight UTC) to reset the daily high balance.
 * Wired into index.ts setInterval.
 */
export async function resetDailyHighBalances(): Promise<void> {
  await PropFirmChallenge.updateMany(
    { is_active: true, status: 'active' },
    [{ $set: { daily_high_balance: '$current_balance' } }],
  );
}

/**
 * Gate check for autoTrader.service — returns false + reason if trading is blocked
 * by prop firm rules.
 */
export async function isTradeAllowed(userId: string): Promise<TradeAllowedResult> {
  const challenge = await _getActive(userId);
  if (!challenge) return { allowed: true, reason: null };

  const status = _buildStatus(challenge);
  if (!status.can_trade) {
    return { allowed: false, reason: status.block_reason };
  }
  return { allowed: true, reason: null };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function _getActive(userId: string): Promise<IPropFirmChallenge | null> {
  return PropFirmChallenge.findOne({
    user_id:   new Types.ObjectId(userId),
    is_active: true,
    status:    'active',
  }).lean() as Promise<IPropFirmChallenge | null>;
}

function _buildStatus(c: IPropFirmChallenge): ChallengeStatus {
  const dailyLossUSD      = Math.max(0, c.daily_high_balance - c.current_balance);
  const dailyLossUsedPct  = (dailyLossUSD / c.account_size) * 100;
  const dailyLimitPct     = c.daily_loss_limit_pct;

  const totalDrawdownUSD  = Math.max(0, c.all_time_high_balance - c.current_balance);
  const totalDrawdownPct  = (totalDrawdownUSD / c.account_size) * 100;

  const profitUSD         = c.current_balance - c.starting_balance;
  const profitTargetUSD   = c.account_size * (c.profit_target_pct / 100);
  const profitProgressPct = profitTargetUSD > 0 ? (profitUSD / profitTargetUSD) * 100 : 0;

  const daysRemaining     = c.max_trading_days > 0
    ? Math.max(0, c.max_trading_days - (new Date().getTime() - c.start_date.getTime()) / 86_400_000)
    : null;

  const hitDailyLimit   = dailyLossUsedPct >= dailyLimitPct;
  const hitMaxDrawdown  = totalDrawdownPct >= c.max_drawdown_pct;
  const hitDeadline     = daysRemaining !== null && daysRemaining <= 0;

  const isFailed = hitDailyLimit || hitMaxDrawdown || hitDeadline;
  const isPassed = profitProgressPct >= 100 && c.trading_days_used >= c.min_trading_days;

  let blockReason: string | null = null;
  if (hitDailyLimit)  blockReason = `Daily loss limit reached (${dailyLossUsedPct.toFixed(1)}% / ${dailyLimitPct}%)`;
  else if (hitMaxDrawdown) blockReason = `Max drawdown breached (${totalDrawdownPct.toFixed(1)}% / ${c.max_drawdown_pct}%)`;
  else if (hitDeadline)    blockReason = 'Challenge deadline exceeded';

  return {
    challenge:               c,
    daily_loss_used_pct:     parseFloat(dailyLossUsedPct.toFixed(2)),
    daily_loss_remaining_pct:parseFloat(Math.max(0, dailyLimitPct - dailyLossUsedPct).toFixed(2)),
    total_drawdown_pct:      parseFloat(totalDrawdownPct.toFixed(2)),
    profit_progress_pct:     parseFloat(Math.min(100, profitProgressPct).toFixed(1)),
    trading_days_remaining:  daysRemaining !== null ? Math.floor(daysRemaining) : null,
    is_near_daily_limit:     dailyLossUsedPct >= dailyLimitPct * 0.70,
    is_near_drawdown_limit:  totalDrawdownPct >= c.max_drawdown_pct * 0.80,
    is_passed:               isPassed,
    is_failed:               isFailed,
    can_trade:               !isFailed && !isPassed,
    block_reason:            blockReason,
  };
}
