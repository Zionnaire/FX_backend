import { Request, Response } from 'express';
import User from '../models/User.model';
import { asyncHandler } from '../middlewares/asyncHandler';
import { sendSuccess, sendError, sendBadRequest } from '../utils/response.utils';

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
