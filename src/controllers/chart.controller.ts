// src/controllers/chart.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import { sendSuccess, sendBadRequest, sendError } from '../utils/response.utils';
import {
  getOHLCV,
  getSupportResistance,
  getFibonacciLevels,
} from '../services/chart.service';
import NewsCache from '../models/NewsCache.model';
import { VALID_PAIRS, VALID_TIMEFRAMES } from '../types/chart.types';

// ─── Shared validators ────────────────────────────────────────────────────────

function validatePair(pair: string, res: Response): boolean {
  if (!VALID_PAIRS.includes(pair as typeof VALID_PAIRS[number])) {
    sendBadRequest(res, `Invalid pair. Must be one of: ${VALID_PAIRS.join(', ')}`);
    return false;
  }
  return true;
}

function validateTimeframe(tf: string, res: Response): boolean {
  if (!VALID_TIMEFRAMES.includes(tf as typeof VALID_TIMEFRAMES[number])) {
    sendBadRequest(
      res,
      `Invalid timeframe. Must be one of: ${VALID_TIMEFRAMES.join(', ')}`
    );
    return false;
  }
  return true;
}

// ─── OHLCV ────────────────────────────────────────────────────────────────────

export const getOHLCVController = asyncHandler(
  async (req: Request, res: Response) => {
    const pair      = req.params.pair;
    const timeframe = String(req.query.timeframe || '1h');

    if (!validatePair(pair, res))      return;
    if (!validateTimeframe(timeframe, res)) return;

    try {
      const candles = await getOHLCV(pair, timeframe);
      sendSuccess(res, candles);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch chart data';

      // Rate limit is a known expected error — return 503 not 500
      const status = message.includes('rate limit') ? 503 : 500;
      sendError(res, message, status);
    }
  }
);

// ─── Support & Resistance ─────────────────────────────────────────────────────

export const getSupportResistanceController = asyncHandler(
  async (req: Request, res: Response) => {
    const pair      = req.params.pair;
    const timeframe = String(req.query.timeframe || '1h');

    if (!validatePair(pair, res))          return;
    if (!validateTimeframe(timeframe, res)) return;

    try {
      const candles = await getOHLCV(pair, timeframe);
      const levels  = getSupportResistance(candles);
      sendSuccess(res, levels);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to compute support/resistance';
      const status = message.includes('rate limit') ? 503 : 500;
      sendError(res, message, status);
    }
  }
);

// ─── Current Price ────────────────────────────────────────────────────────────
// Returns only the latest close price for a pair — used by the frontend
// to compute live unrealized P&L without fetching full OHLCV data.
// Reuses the cached 1m candles, so the overhead is minimal.

export const getCurrentPriceController = asyncHandler(
  async (req: Request, res: Response) => {
    const pair = req.params.pair;
    if (!validatePair(pair, res)) return;

    try {
      const candles = await getOHLCV(pair, '1m');
      if (!candles || candles.length === 0) {
        sendError(res, 'No price data available', 503);
        return;
      }
      const last = candles[candles.length - 1];
      sendSuccess(res, { pair, price: last.close, timestamp: last.time });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch price';
      sendError(res, message, message.includes('rate limit') ? 503 : 500);
    }
  }
);

// ─── Cache flush ──────────────────────────────────────────────────────────────
// Deletes all chart cache entries so the next request fetches fresh data.
// Call this after adding/changing the data API key, or when charts look stale.

export const flushChartCacheController = asyncHandler(
  async (_req: Request, res: Response) => {
    const result = await NewsCache.deleteMany({ key: /^chart:/ });
    sendSuccess(res, { deleted: result.deletedCount, message: 'Chart cache cleared — next request will fetch fresh data' });
  }
);

// ─── Fibonacci ────────────────────────────────────────────────────────────────

export const getFibonacciController = asyncHandler(
  async (req: Request, res: Response) => {
    const pair      = req.params.pair;
    const timeframe = String(req.query.timeframe || '1d');  // daily gives better fib range

    if (!validatePair(pair, res))          return;
    if (!validateTimeframe(timeframe, res)) return;

    try {
      const candles = await getOHLCV(pair, timeframe);
      const levels  = getFibonacciLevels(candles);
      sendSuccess(res, levels);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to compute Fibonacci levels';
      const status = message.includes('rate limit') ? 503 : 500;
      sendError(res, message, status);
    }
  }
);