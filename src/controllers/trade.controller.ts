// src/controllers/trade.controller.ts

import { Request, Response } from 'express';
import { Types } from 'mongoose';
import Trade from '../models/Trade.model';
import User from '../models/User.model';
import { asyncHandler } from '../middlewares/asyncHandler';
import {
  sendSuccess,
  sendCreated,
  sendNotFound,
  sendBadRequest,
} from '../utils/response.utils';
import { reviewTrade } from '../services/groq.service';
import { ingestTradeReview } from '../services/autoIngest.service';
import { VALID_PAIRS, ValidPair } from '../types/chart.types';

// ─── Whitelisted Fields ───────────────────────────────────────────────────────

const ALLOWED_CREATE_FIELDS = [
  'pair', 'type', 'entry', 'exit',
  'stopLoss', 'takeProfit',
  'size', 'pnl', 'rr', 'status',
  'duration', 'notes', 'aiSignalId', 'source',
] as const;

const ALLOWED_UPDATE_FIELDS = [
  'exit', 'stopLoss', 'takeProfit',
  'size', 'pnl', 'rr',
  'status', 'duration', 'notes',
] as const;

type CreateField = typeof ALLOWED_CREATE_FIELDS[number];
type UpdateField = typeof ALLOWED_UPDATE_FIELDS[number];

function pickCreate(body: Record<string, unknown>): Partial<Record<CreateField, unknown>> {
  const result: Partial<Record<CreateField, unknown>> = {};
  for (const key of ALLOWED_CREATE_FIELDS) {
    if (key in body) result[key] = body[key];
  }
  return result;
}

function pickUpdate(body: Record<string, unknown>): Partial<Record<UpdateField, unknown>> {
  const result: Partial<Record<UpdateField, unknown>> = {};
  for (const key of ALLOWED_UPDATE_FIELDS) {
    if (key in body) result[key] = body[key];
  }
  return result;
}

// ─── P&L Calculator ───────────────────────────────────────────────────────────
// Returns USD P&L for the given trade parameters.
// Uses a simplified pip-value model suitable for simulation:
//   - GBP/USD, EUR/USD  : quote is USD → PnL = direction * (exit-entry) * 100000 * size
//   - USD/JPY           : base is USD  → PnL = direction * (exit-entry) / exit * 100000 * size
//   - XAU/USD (GC=F)    : 1 lot = 100 oz → PnL = direction * (exit-entry) * 100 * size

function calcPnL(
  pair: ValidPair,
  type: 'BUY' | 'SELL',
  entry: number,
  exit: number,
  size: number
): number {
  const direction = type === 'BUY' ? 1 : -1;
  let pnl: number;

  if (pair === 'USD/JPY') {
    pnl = direction * (exit - entry) / exit * 100_000 * size;
  } else if (pair === 'XAU/USD') {
    pnl = direction * (exit - entry) * 100 * size;
  } else {
    // GBP/USD, EUR/USD
    pnl = direction * (exit - entry) * 100_000 * size;
  }

  return Math.round(pnl * 100) / 100;
}

// ─── R:R Calculator ───────────────────────────────────────────────────────────

function calcRR(
  type: 'BUY' | 'SELL',
  entry: number,
  stopLoss: number,
  takeProfit: number
): string | null {
  const risk   = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (risk === 0) return null;
  const ratio = reward / risk;
  return `1:${ratio.toFixed(2)}`;
}

// ─── Get All Trades ───────────────────────────────────────────────────────────

export const getAllTrades = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { pair, status } = req.query;

    const query: Record<string, unknown> = {
      userId: new Types.ObjectId(userId),
    };

    if (pair) {
      if (!VALID_PAIRS.includes(pair as typeof VALID_PAIRS[number])) {
        sendBadRequest(res, `Invalid pair. Must be one of: ${VALID_PAIRS.join(', ')}`);
        return;
      }
      query.pair = pair;
    }

    if (status) {
      if (!['open', 'win', 'loss'].includes(status as string)) {
        sendBadRequest(res, 'Invalid status. Must be one of: open, win, loss');
        return;
      }
      query.status = status;
    }

    const trades = await Trade.find(query)
      .sort({ createdAt: -1 })
      .lean();

    sendSuccess(res, trades);
  }
);

// ─── Get Trade By ID ──────────────────────────────────────────────────────────

export const getTradeById = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const trade = await Trade.findOne({
      _id:    req.params.id,
      userId: new Types.ObjectId(userId),
    }).lean();

    if (!trade) {
      sendNotFound(res, 'Trade not found');
      return;
    }

    sendSuccess(res, trade);
  }
);

// ─── Create Trade ─────────────────────────────────────────────────────────────

export const createTrade = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const data   = pickCreate(req.body);

    if (!data.pair || !data.type || !data.entry || !data.size) {
      sendBadRequest(res, 'pair, type, entry, and size are required');
      return;
    }

    if (!VALID_PAIRS.includes(data.pair as typeof VALID_PAIRS[number])) {
      sendBadRequest(res, `Invalid pair. Must be one of: ${VALID_PAIRS.join(', ')}`);
      return;
    }

    if (!['BUY', 'SELL'].includes(data.type as string)) {
      sendBadRequest(res, 'type must be BUY or SELL');
      return;
    }

    const pair  = data.pair as ValidPair;
    const type  = data.type as 'BUY' | 'SELL';
    const entry = Number(data.entry);
    const size  = Number(data.size);
    const sl    = data.stopLoss   != null ? Number(data.stopLoss)   : undefined;
    const tp    = data.takeProfit != null ? Number(data.takeProfit) : undefined;

    // Auto-compute R:R when SL + TP are provided
    if (!data.rr && sl != null && tp != null) {
      data.rr = calcRR(type, entry, sl, tp) ?? undefined;
    }

    // Auto-compute PnL when trade is opened with an exit already
    const exitVal = data.exit != null ? Number(data.exit) : undefined;
    if (exitVal != null && data.pnl == null) {
      data.pnl = calcPnL(pair, type, entry, exitVal, size);
      if (!data.status) {
        data.status = (data.pnl as number) >= 0 ? 'win' : 'loss';
      }
      // Update simulation balance immediately for instant-close trades
      User.updateOne(
        { _id: new Types.ObjectId(userId) },
        { $inc: { simulationBalance: data.pnl } }
      ).catch(() => {});
    }

    const trade = await Trade.create({
      userId: new Types.ObjectId(userId),
      ...data,
    });

    sendCreated(res, trade);
  }
);

// ─── Update Trade ─────────────────────────────────────────────────────────────

export const updateTrade = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const data   = pickUpdate(req.body);

    if (Object.keys(data).length === 0) {
      sendBadRequest(res, 'No valid fields provided for update');
      return;
    }

    if (data.status && !['open', 'win', 'loss'].includes(data.status as string)) {
      sendBadRequest(res, 'Invalid status. Must be one of: open, win, loss');
      return;
    }

    // When closing a trade (exit provided), auto-compute PnL if not supplied
    if (data.exit != null && data.pnl == null) {
      const existing = await Trade.findOne({
        _id:    req.params.id,
        userId: new Types.ObjectId(userId),
      }).lean();

      if (existing) {
        const pnl = calcPnL(
          existing.pair as ValidPair,
          existing.type as 'BUY' | 'SELL',
          existing.entry,
          Number(data.exit),
          existing.size,
        );
        data.pnl    = pnl as any;
        data.status = (pnl >= 0 ? 'win' : 'loss') as any;

        // Recompute R:R with actual exit as TP proxy
        if (!data.rr && existing.stopLoss != null) {
          data.rr = (calcRR(
            existing.type as 'BUY' | 'SELL',
            existing.entry,
            existing.stopLoss,
            Number(data.exit),
          ) ?? undefined) as any;
        }
      }
    }

    const trade = await Trade.findOneAndUpdate(
      { _id: req.params.id, userId: new Types.ObjectId(userId) },
      { $set: data },
      { new: true, runValidators: true }
    ).lean();

    if (!trade) {
      sendNotFound(res, 'Trade not found');
      return;
    }

    // Update simulation balance when trade closes
    const justClosed = data.exit != null && (trade.status === 'win' || trade.status === 'loss');
    if (justClosed && trade.pnl != null) {
      User.updateOne(
        { _id: new Types.ObjectId(userId) },
        { $inc: { simulationBalance: trade.pnl } }
      ).catch(() => {});
    }

    // Auto-review when trade is just closed and has no review yet
    if (justClosed && !trade.aiReview?.verdict) {
      // Fire-and-forget — don't block the response
      setImmediate(async () => {
        try {
          const aiReview = await reviewTrade(trade);
          const updated = await Trade.findByIdAndUpdate(
            trade._id, { $set: { aiReview } }, { new: true }
          ).lean();
          console.info(`[trade] Auto-reviewed trade ${trade._id} → ${aiReview.verdict}`);
          // Auto-ingest the review into the RAG knowledge base
          if (updated) {
            ingestTradeReview(userId, updated as any).catch((err) =>
              console.warn(`[rag] Auto-ingest failed for trade ${trade._id}:`, (err as Error).message)
            );
          }
        } catch (err) {
          console.warn(`[trade] Auto-review failed for ${trade._id}:`, (err as Error).message);
        }
      });
    }

    sendSuccess(res, trade);
  }
);

// ─── Delete Trade ─────────────────────────────────────────────────────────────

export const deleteTrade = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const trade = await Trade.findOneAndDelete({
      _id:    req.params.id,
      userId: new Types.ObjectId(userId),
    }).lean();

    if (!trade) {
      sendNotFound(res, 'Trade not found');
      return;
    }

    sendSuccess(res, null, 'Trade deleted successfully');
  }
);

// ─── Review Trade (AI) ────────────────────────────────────────────────────────

export const reviewTradeController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const trade = await Trade.findOne({
      _id:    req.params.id,
      userId: new Types.ObjectId(userId),
    });

    if (!trade) {
      sendNotFound(res, 'Trade not found');
      return;
    }

    // Only review closed trades — open trades have no exit or final P&L
    if (trade.status === 'open') {
      sendBadRequest(res, 'Cannot review an open trade. Close the trade first.');
      return;
    }

    // Return cached review if it already exists
    if (trade.aiReview?.verdict) {
      sendSuccess(res, trade);
      return;
    }

    const aiReview = await reviewTrade(trade);

    const updated = await Trade.findByIdAndUpdate(
      trade._id,
      { $set: { aiReview } },
      { new: true }
    ).lean();

    sendSuccess(res, updated);
  }
);
