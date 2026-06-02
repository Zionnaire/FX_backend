// src/controllers/analytics.controller.ts

import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../middlewares/asyncHandler';
import { sendSuccess, sendBadRequest } from '../utils/response.utils';
import {
  getStats,
  getPnlCurve,
  getByPair,
  getBySession,
} from '../services/analytics.service';
import { runBacktest } from '../services/backtest.service';
import { VALID_PAIRS as CHART_PAIRS, VALID_TIMEFRAMES as CHART_TFS } from '../types/chart.types';
import type { ValidPair, ValidTimeframe } from '../types/chart.types';
import { getSignalAccuracyStats } from '../services/signalAccuracy.service';
import { buildTradingProfile } from '../services/trading-profile.service';
import { generateCoachingInsights } from '../services/groq.service';
import CoachingCache from '../models/CoachingCache.model';

// ─── Shared Query Filter Parser ───────────────────────────────────────────────
// Allows optional ?startDate=, ?endDate=, ?pair= query params
// so analytics can be scoped without always computing full history

interface AnalyticsFilters {
  startDate?: Date;
  endDate?: Date;
  pair?: string;
}

const VALID_PAIRS = ['XAU/USD', 'GBP/USD', 'EUR/USD', 'USD/JPY'];

function parseFilters(query: Record<string, unknown>): AnalyticsFilters | null {
  const filters: AnalyticsFilters = {};

  if (query.startDate) {
    const d = new Date(query.startDate as string);
    if (isNaN(d.getTime())) return null; // signal bad input
    filters.startDate = d;
  }

  if (query.endDate) {
    const d = new Date(query.endDate as string);
    if (isNaN(d.getTime())) return null;
    filters.endDate = d;
  }

  if (query.pair) {
    const pair = query.pair as string;
    if (!VALID_PAIRS.includes(pair)) return null;
    filters.pair = pair;
  }

  return filters;
}

// ─── Overall Stats ────────────────────────────────────────────────────────────

export const getStatsController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const filters = parseFilters(req.query as Record<string, unknown>);
    if (filters === null) {
      sendBadRequest(
        res,
        'Invalid query parameters. Check startDate, endDate (ISO format) and pair.'
      );
      return;
    }

    const stats = await getStats(userId, filters);
    sendSuccess(res, stats);
  }
);

// ─── P&L Curve ────────────────────────────────────────────────────────────────

export const getPnlCurveController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const filters = parseFilters(req.query as Record<string, unknown>);
    if (filters === null) {
      sendBadRequest(
        res,
        'Invalid query parameters. Check startDate and endDate (ISO format).'
      );
      return;
    }

    const pnlCurve = await getPnlCurve(userId, filters);
    sendSuccess(res, pnlCurve);
  }
);

// ─── By Pair Breakdown ────────────────────────────────────────────────────────
// Dedicated endpoint — does NOT call getStats and discard the result

export const getByPairController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const filters = parseFilters(req.query as Record<string, unknown>);
    if (filters === null) {
      sendBadRequest(
        res,
        'Invalid query parameters. Check startDate and endDate (ISO format).'
      );
      return;
    }

    const byPair = await getByPair(userId, filters);
    sendSuccess(res, byPair);
  }
);

// ─── By Session Breakdown ─────────────────────────────────────────────────────

export const getBySessionController = asyncHandler(
  async (req: Request, res: Response) => {
    const filters = parseFilters(req.query as Record<string, unknown>);
    if (filters === null) { sendBadRequest(res, 'Invalid query parameters.'); return; }
    const data = await getBySession(req.user!.id, filters);
    sendSuccess(res, data);
  }
);

// ─── Backtest ─────────────────────────────────────────────────────────────────

export const runBacktestController = asyncHandler(
  async (req: Request, res: Response) => {
    const { pair, timeframe, style } = req.query as Record<string, string>;

    if (!pair || !CHART_PAIRS.includes(pair as ValidPair)) {
      sendBadRequest(res, `Invalid pair. Must be one of: ${CHART_PAIRS.join(', ')}`);
      return;
    }
    if (!timeframe || !CHART_TFS.includes(timeframe as ValidTimeframe)) {
      sendBadRequest(res, `Invalid timeframe. Must be one of: ${CHART_TFS.join(', ')}`);
      return;
    }
    const tradingStyle = style === 'scalp' ? 'scalp' : 'swing';
    const result = await runBacktest(pair as ValidPair, timeframe as ValidTimeframe, tradingStyle);
    sendSuccess(res, result);
  }
);

// ─── Signal Accuracy ──────────────────────────────────────────────────────────

export const getSignalAccuracyController = asyncHandler(
  async (req: Request, res: Response) => {
    const stats = await getSignalAccuracyStats(req.user!.id);
    sendSuccess(res, stats);
  }
);

// ─── AI Coaching ──────────────────────────────────────────────────────────────
// Builds a trading profile from closed trades, generates AI coaching insights
// via Groq, and caches the result for 6 hours (or until 3+ new trades arrive).

export const getCoachingController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    // Build profile stats (fast MongoDB aggregation — always fresh)
    const profile = await buildTradingProfile(userId);

    if (profile.totalTrades < 5) {
      sendSuccess(res, {
        profile,
        insights:      ['Log at least 5 closed trades to unlock personalised AI coaching insights.'],
        topSuggestion: 'Build your trade history — AI coaching unlocks after 5 closed trades.',
        cached:        false,
      });
      return;
    }

    // Check existing cache
    const cached = await CoachingCache.findOne({ userId: new Types.ObjectId(userId) }).lean();
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const isStale   = !cached
      || Date.now() - new Date(cached.generatedAt).getTime() > SIX_HOURS
      || Math.abs((cached.tradeCountWhenGenerated ?? 0) - profile.totalTrades) >= 3;

    // Force-refresh flag from query param
    const forceRefresh = req.query.refresh === 'true';

    if (!isStale && !forceRefresh && cached) {
      sendSuccess(res, {
        profile,
        insights:      cached.insights,
        topSuggestion: cached.topSuggestion,
        cached:        true,
        generatedAt:   cached.generatedAt,
      });
      return;
    }

    // Generate fresh insights (Groq call ~3-5s)
    const { insights, topSuggestion } = await generateCoachingInsights(profile);

    await CoachingCache.findOneAndUpdate(
      { userId: new Types.ObjectId(userId) },
      { $set: { insights, topSuggestion, tradeCountWhenGenerated: profile.totalTrades, generatedAt: new Date() } },
      { upsert: true, new: true }
    );

    sendSuccess(res, {
      profile, insights, topSuggestion, cached: false, generatedAt: new Date(),
    });
  }
);

