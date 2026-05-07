// src/controllers/news.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import {
  sendSuccess,
  sendBadRequest,
  sendError,
} from '../utils/response.utils';
import { getNewsByPair, getEconomicCalendar } from '../services/news.service';
import { VALID_PAIRS, ValidPair } from '../types/chart.types';

// ─── News By Pair ─────────────────────────────────────────────────────────────

export const getNewsByPairController = asyncHandler(
  async (req: Request, res: Response) => {
    const pair = req.params.pair as ValidPair;

    // Validate pair before hitting the service or external API
    if (!VALID_PAIRS.includes(pair)) {
      sendBadRequest(
        res,
        `Invalid pair. Must be one of: ${VALID_PAIRS.join(', ')}`
      );
      return;
    }

    try {
      const news = await getNewsByPair(pair);
      sendSuccess(res, news);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch news';

      // NewsAPI free tier only works on localhost — surface this clearly
      const status = message.includes('rate limit') || message.includes('426')
        ? 503
        : 500;

      sendError(res, message, status);
    }
  }
);

// ─── Economic Calendar ────────────────────────────────────────────────────────

export const getEconomicCalendarController = asyncHandler(
  async (_req: Request, res: Response) => {
    const calendar = await getEconomicCalendar();
    sendSuccess(res, calendar);
  }
);