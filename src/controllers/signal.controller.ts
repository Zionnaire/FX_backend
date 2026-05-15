// src/controllers/signal.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import {
  sendSuccess,
  sendBadRequest,
  sendError,
} from '../utils/response.utils';
import { getSignal, getSignalHistory } from '../services/signal.service';
import { VALID_PAIRS, VALID_TIMEFRAMES } from '../types/chart.types';

// ─── Get Signal ───────────────────────────────────────────────────────────────

export const getSignalController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId       = req.user!.id;
    const pair         = req.params.pair;
    const timeframe    = String(req.query.timeframe || '1h');
    const rawStyle     = String(req.query.style || 'swing');
    const tradingStyle = rawStyle === 'scalp' ? 'scalp' : 'swing';

    if (!VALID_PAIRS.includes(pair as typeof VALID_PAIRS[number])) {
      sendBadRequest(res, `Invalid pair. Must be one of: ${VALID_PAIRS.join(', ')}`);
      return;
    }

    if (!VALID_TIMEFRAMES.includes(timeframe as typeof VALID_TIMEFRAMES[number])) {
      sendBadRequest(res, `Invalid timeframe. Must be one of: ${VALID_TIMEFRAMES.join(', ')}`);
      return;
    }

    try {
      const signal = await getSignal(userId, pair, timeframe, tradingStyle);
      sendSuccess(res, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate signal';
      const status  = message.includes('rate limit') ? 503 : 500;
      sendError(res, message, status);
    }
  }
);

// ─── Get Signal History ───────────────────────────────────────────────────────

export const getSignalHistoryController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const pair   = req.params.pair;

    if (!VALID_PAIRS.includes(pair as typeof VALID_PAIRS[number])) {
      sendBadRequest(res, `Invalid pair. Must be one of: ${VALID_PAIRS.join(', ')}`);
      return;
    }

    try {
      const history = await getSignalHistory(userId, pair);
      sendSuccess(res, history);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch signal history';
      sendError(res, message, 500);
    }
  }
);