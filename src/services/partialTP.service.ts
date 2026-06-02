// src/services/partialTP.service.ts
// Partial take-profit and break-even automation.
//
// Called by tradeMonitor.service on each monitoring cycle.
// Checks open trades with tp1/tp2 set and updates the trade record when levels are hit.
//
// TP1 hit → mark tp1_hit, record tp1_hit_at
//           if breakeven_after_tp1 → update stopLoss to entry (break-even)
// TP2 hit → mark tp2_hit, record tp2_hit_at (final TP handled by standard monitor)
//
// This service writes to the Trade model only — does NOT push to MT5 directly.
// The MT5 EA polls and handles partial close execution independently.

import Trade from '../models/Trade.model';
import { ITrade } from '../types/trade.types';
import { broadcast } from '../websocket/wsServer';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PartialTPResult {
  tradeId:   string;
  pair:      string;
  direction: string;
  event:     'tp1_hit' | 'tp2_hit';
  level:     number;
  breakevenMoved: boolean;
}

// ─── Main monitor function ────────────────────────────────────────────────────

/**
 * Checks all open trades with partial TP configured.
 * Pass current prices as a map: { 'XAU/USD': 1985.50, … }
 */
export async function checkPartialTPs(
  currentPrices: Record<string, number>,
): Promise<PartialTPResult[]> {
  const trades = await Trade.find({
    status: 'open',
    $or: [
      { tp1: { $ne: null }, tp1_hit: false },
      { tp2: { $ne: null }, tp2_hit: false, tp1_hit: true },
    ],
  }).lean() as ITrade[];

  const results: PartialTPResult[] = [];

  for (const trade of trades) {
    const price = currentPrices[trade.pair];
    if (!price) continue;

    const updates: Partial<ITrade> & Record<string, unknown> = {};
    const result: Partial<PartialTPResult> = {
      tradeId:   String((trade as any)._id),
      pair:      trade.pair,
      direction: trade.type,
    };

    // TP1 check
    if ((trade as any).tp1 && !(trade as any).tp1_hit) {
      const tp1Hit = trade.type === 'BUY'
        ? price >= (trade as any).tp1
        : price <= (trade as any).tp1;

      if (tp1Hit) {
        updates.tp1_hit    = true;
        updates.tp1_hit_at = new Date();
        result.event = 'tp1_hit';
        result.level = (trade as any).tp1;
        result.breakevenMoved = false;

        // Move SL to break-even
        if ((trade as any).breakeven_after_tp1 && trade.entry) {
          updates.stopLoss      = trade.entry;
          result.breakevenMoved = true;
        }

        await Trade.findByIdAndUpdate((trade as any)._id, { $set: updates });

        // Broadcast to WebSocket clients
        broadcast(String((trade as any).userId), 'trade:tp1_hit', {
          tradeId:   result.tradeId,
          pair:      trade.pair,
          tp1:       (trade as any).tp1,
          breakeven: result.breakevenMoved,
        });

        results.push(result as PartialTPResult);
        continue;
      }
    }

    // TP2 check (only after TP1 was hit)
    if ((trade as any).tp2 && (trade as any).tp1_hit && !(trade as any).tp2_hit) {
      const tp2Hit = trade.type === 'BUY'
        ? price >= (trade as any).tp2
        : price <= (trade as any).tp2;

      if (tp2Hit) {
        await Trade.findByIdAndUpdate((trade as any)._id, {
          $set: { tp2_hit: true, tp2_hit_at: new Date() },
        });

        broadcast(String((trade as any).userId), 'trade:tp2_hit', {
          tradeId: result.tradeId,
          pair:    trade.pair,
          tp2:     (trade as any).tp2,
        });

        results.push({
          ...result,
          event:          'tp2_hit',
          level:          (trade as any).tp2,
          breakevenMoved: false,
        } as PartialTPResult);
      }
    }
  }

  return results;
}

// ─── Compute TP1 / TP2 from entry / SL / TP ──────────────────────────────────

/**
 * Given a trade's entry, SL, and full TP, compute suggested TP1 and TP2 levels.
 * TP1 = 1× risk reward (entry + 1R)
 * TP2 = 2× risk reward (entry + 2R)
 */
export function computePartialTPLevels(
  direction: 'BUY' | 'SELL',
  entry:     number,
  stopLoss:  number,
  takeProfit: number,
): { tp1: number; tp2: number } {
  const rUnit = Math.abs(entry - stopLoss);
  if (direction === 'BUY') {
    return {
      tp1: parseFloat(Math.min(entry + rUnit, takeProfit).toFixed(5)),
      tp2: parseFloat(Math.min(entry + rUnit * 2, takeProfit).toFixed(5)),
    };
  }
  return {
    tp1: parseFloat(Math.max(entry - rUnit, takeProfit).toFixed(5)),
    tp2: parseFloat(Math.max(entry - rUnit * 2, takeProfit).toFixed(5)),
  };
}
