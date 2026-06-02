// src/controllers/portfolio.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import { sendSuccess } from '../utils/response.utils';
import { getPortfolioRisk } from '../services/portfolioRisk.service';
import { getBehaviorReport } from '../services/behaviorAnalytics.service';
import { getDailyBriefing } from '../services/dailyBriefing.service';

// GET /api/portfolio/risk
export const getPortfolioRiskHandler = asyncHandler(async (req: Request, res: Response) => {
  const snapshot = await getPortfolioRisk(req.user!.id);
  sendSuccess(res, snapshot);
});

// GET /api/portfolio/behavior?days=90
export const getBehaviorHandler = asyncHandler(async (req: Request, res: Response) => {
  const days = Math.min(365, Math.max(7, parseInt(req.query.days as string, 10) || 90));
  const report = await getBehaviorReport(req.user!.id, days);
  sendSuccess(res, report);
});

// GET /api/portfolio/briefing
export const getDailyBriefingHandler = asyncHandler(async (req: Request, res: Response) => {
  const briefing = await getDailyBriefing(req.user!.id);
  sendSuccess(res, briefing);
});
