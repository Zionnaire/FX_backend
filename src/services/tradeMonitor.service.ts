// src/services/tradeMonitor.service.ts
//
// Runs on a 60-second interval and auto-closes any open trade whose
// current market price has breached its stop-loss or take-profit level.
// Mirrors the behaviour of a real broker's SL/TP execution engine.

import Trade from '../models/Trade.model';
import User  from '../models/User.model';
import { getOHLCV } from './chart.service';
import { reviewTrade } from './groq.service';
import { ingestTradeReview } from './autoIngest.service';
import { ValidPair } from '../types/chart.types';

// ─── P&L (same logic as trade.controller) ────────────────────────────────────

function calcPnL(
  pair: ValidPair,
  type: 'BUY' | 'SELL',
  entry: number,
  exit: number,
  size: number,
): number {
  const dir = type === 'BUY' ? 1 : -1;
  let pnl: number;
  if (pair === 'USD/JPY') {
    pnl = dir * ((exit - entry) / exit) * 100_000 * size;
  } else if (pair === 'XAU/USD') {
    pnl = dir * (exit - entry) * 100 * size;
  } else {
    pnl = dir * (exit - entry) * 100_000 * size;
  }
  return Math.round(pnl * 100) / 100;
}

function calcDuration(createdAt: Date | string | undefined): string {
  const ms = Date.now() - new Date(createdAt ?? Date.now()).getTime();
  const h  = Math.floor(ms / 3_600_000);
  const m  = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── Main monitor function ────────────────────────────────────────────────────

export async function monitorOpenTrades(): Promise<void> {
  // Only consider trades that actually have SL or TP set
  const openTrades = await Trade.find({
    status: 'open',
    $or: [
      { stopLoss:   { $exists: true, $ne: null } },
      { takeProfit: { $exists: true, $ne: null } },
    ],
  }).lean();

  if (openTrades.length === 0) return;

  // Group by pair to fetch price once per pair, not once per trade
  const byPair = new Map<string, typeof openTrades>();
  for (const trade of openTrades) {
    const group = byPair.get(trade.pair) ?? [];
    group.push(trade);
    byPair.set(trade.pair, group);
  }

  for (const [pair, trades] of byPair) {
    let currentPrice: number;
    try {
      const candles = await getOHLCV(pair, '1m');
      if (candles.length === 0) continue;
      currentPrice = candles[candles.length - 1].close;
    } catch {
      console.warn(`[monitor] Could not fetch price for ${pair} — skipping`);
      continue;
    }

    for (const trade of trades) {
      const { type, entry, stopLoss, takeProfit, size } = trade;
      const isBuy = type === 'BUY';

      const slHit = stopLoss   != null && (isBuy ? currentPrice <= stopLoss   : currentPrice >= stopLoss);
      const tpHit = takeProfit != null && (isBuy ? currentPrice >= takeProfit : currentPrice <= takeProfit);

      if (!slHit && !tpHit) continue;

      // If both somehow triggered (gap / missed candle), TP takes priority
      const hitTP     = tpHit && !slHit;
      const exitPrice = hitTP ? takeProfit! : stopLoss!;
      const status    = hitTP ? 'win' : 'loss';
      const pnl       = calcPnL(pair as ValidPair, type as 'BUY' | 'SELL', entry, exitPrice, size);
      const duration  = calcDuration(trade.createdAt);

      try {
        const closed = await Trade.findByIdAndUpdate(
          trade._id,
          { $set: { exit: exitPrice, pnl, status, duration } },
          { new: true },
        ).lean();

        if (!closed) continue;

        console.info(
          `[monitor] Auto-closed trade ${trade._id} (${pair} ${type}) — ` +
          `${status.toUpperCase()} at ${exitPrice} | PnL: ${pnl > 0 ? '+' : ''}${pnl}`
        );

        // Update simulation balance
        User.updateOne(
          { _id: trade.userId },
          { $inc: { simulationBalance: pnl } },
        ).catch(() => {});

        // Fire-and-forget AI trade review + RAG ingestion
        setImmediate(async () => {
          try {
            const aiReview = await reviewTrade(closed as any);
            const withReview = await Trade.findByIdAndUpdate(
              trade._id,
              { $set: { aiReview } },
              { new: true },
            ).lean();
            if (withReview) {
              ingestTradeReview(String(trade.userId), withReview as any).catch(() => {});
            }
          } catch {
            // non-fatal — review can be triggered manually
          }
        });
      } catch (err) {
        console.error(`[monitor] Failed to close trade ${trade._id}:`, err);
      }
    }
  }
}
