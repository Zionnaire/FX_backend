import { Request, Response } from 'express';
import User from '../models/User.model';
import { asyncHandler } from '../middlewares/asyncHandler';
import { sendSuccess, sendError, sendBadRequest } from '../utils/response.utils';
import { generateApiKey } from '../services/autoTrader.service';

export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.user?.id).select('-password -refreshToken');
  if (!user) return sendError(res, 'User not found', 404);
  sendSuccess(res, user);
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const { name, preferences } = req.body;
  if (!name && !preferences) {
    return sendBadRequest(res, 'Nothing to update');
  }

  const user = await User.findById(req.user?.id);
  if (!user) return sendError(res, 'User not found', 404);

  if (name) user.name = name;
  if (preferences) {
    user.preferences = {
      ...user.preferences,
      ...preferences,
    };
  }

  await user.save();
  sendSuccess(res, user);
});

export const updatePreferences = asyncHandler(async (req: Request, res: Response) => {
  const { defaultPair, defaultTimeframe, riskPercent } = req.body;
  const user = await User.findById(req.user?.id);
  if (!user) return sendError(res, 'User not found', 404);

  if (defaultPair) user.preferences.defaultPair = defaultPair;
  if (defaultTimeframe) user.preferences.defaultTimeframe = defaultTimeframe;
  if (typeof riskPercent === 'number') user.preferences.riskPercent = riskPercent;

  await user.save();
  sendSuccess(res, user);
});

// ─── Update AutoTrade settings ────────────────────────────────────────────────

export const updateAutoTrade = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.user?.id);
  if (!user) return sendError(res, 'User not found', 404);

  const {
    enabled, defaultRiskPct, maxDailyLossPct,
    maxDailyTrades, minConfluence, minConfidence,
  } = req.body;

  if (!user.autoTrade) {
    (user as any).autoTrade = {};
  }

  if (typeof enabled          === 'boolean') user.autoTrade!.enabled          = enabled;
  if (typeof defaultRiskPct   === 'number')  user.autoTrade!.defaultRiskPct   = defaultRiskPct;
  if (typeof maxDailyLossPct  === 'number')  user.autoTrade!.maxDailyLossPct  = maxDailyLossPct;
  if (typeof maxDailyTrades   === 'number')  user.autoTrade!.maxDailyTrades   = maxDailyTrades;
  if (typeof minConfluence    === 'number')  user.autoTrade!.minConfluence     = minConfluence;
  if (typeof minConfidence    === 'number')  user.autoTrade!.minConfidence     = minConfidence;

  await user.save();
  sendSuccess(res, user);
});

// ─── Generate / Regenerate MT5 API Key ────────────────────────────────────────

export const regenerateApiKey = asyncHandler(async (req: Request, res: Response) => {
  const user = await User.findById(req.user?.id);
  if (!user) return sendError(res, 'User not found', 404);

  if (!user.autoTrade) (user as any).autoTrade = {};
  user.autoTrade!.mt5ApiKey = generateApiKey();
  await user.save();

  sendSuccess(res, { mt5ApiKey: user.autoTrade!.mt5ApiKey });
});
