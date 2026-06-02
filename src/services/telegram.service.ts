// src/services/telegram.service.ts
// Outbound Telegram Bot notification service.
//
// Uses the Telegram Bot API over HTTPS — no extra library required.
// Bot token is read from TELEGRAM_BOT_TOKEN environment variable.
// Per-user chat_id is stored in User.telegram.chat_id.
//
// Designed to be non-blocking: all sends are fire-and-forget.
// Never throws — failures are logged and swallowed.
//
// Usage:
//   await notifyTelegram(userId, 'on_signal', '🔔 A+ BUY XAU/USD — 78% confidence');

import axios from 'axios';
import User from '../models/User.model';
import { Types } from 'mongoose';

type NotificationTopic =
  | 'on_signal'
  | 'on_auto_trade'
  | 'on_alert'
  | 'on_daily_briefing'
  | 'on_circuit_breaker';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a Telegram message to a user if their Telegram integration is enabled
 * and they have opted-in to this topic.
 * Non-blocking — always returns void without throwing.
 */
export async function notifyTelegram(
  userId:  string | Types.ObjectId,
  topic:   NotificationTopic,
  message: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  try {
    const user = await User.findById(userId).select('telegram').lean();
    const tg   = (user as any)?.telegram;
    if (!tg?.enabled || !tg?.chat_id) return;
    if (tg[topic] === false) return;  // user opted out of this topic

    await _sendMessage(token, tg.chat_id as string, message);
  } catch {
    /* non-fatal — Telegram unavailability must never break trading flow */
  }
}

/**
 * Convenience: send to a known chat_id directly (for system-level alerts).
 */
export async function sendTelegramDirect(chatId: string, message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await _sendMessage(token, chatId, message);
  } catch { /* non-fatal */ }
}

// ─── Message builders ─────────────────────────────────────────────────────────

export function formatSignalMessage(signal: {
  pair: string; direction: string; confidence: number; qualityTier: string;
  entry: number; stopLoss: number; takeProfit: number; riskReward?: string;
}): string {
  const dir = signal.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL';
  return [
    `${dir} ${signal.pair} — ${signal.qualityTier} Quality`,
    `📊 Confidence: ${signal.confidence}%`,
    `📍 Entry: ${signal.entry}`,
    `🛑 SL: ${signal.stopLoss}`,
    `🎯 TP: ${signal.takeProfit}`,
    signal.riskReward ? `⚖️ RR: ${signal.riskReward}` : '',
  ].filter(Boolean).join('\n');
}

export function formatAutoTradeMessage(execution: {
  pair: string; direction: string; lots: number; entry: number;
}): string {
  const dir = execution.direction === 'BUY' ? '🟢' : '🔴';
  return `${dir} Auto-trade queued: ${execution.pair} ${execution.direction}\n` +
    `📦 ${execution.lots} lots @ ${execution.entry}\n⏳ Confirm within 60 seconds`;
}

export function formatCircuitBreakerMessage(reason: string): string {
  return `⚠️ Auto-trade SUSPENDED\n${reason}`;
}

export function formatPropFirmWarning(
  dailyUsedPct: number, limitPct: number, pair: string,
): string {
  return `⚠️ Prop Firm Warning — ${pair}\n` +
    `Daily loss: ${dailyUsedPct.toFixed(1)}% / ${limitPct}% limit\n` +
    `Remaining: ${(limitPct - dailyUsedPct).toFixed(2)}%`;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function _sendMessage(token: string, chatId: string, text: string): Promise<void> {
  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'HTML' },
    { timeout: 8_000 },
  );
}
