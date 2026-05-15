// src/controllers/alert.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import {
  sendSuccess,
  sendCreated,
  sendNotFound,
  sendBadRequest,
} from '../utils/response.utils';
import Alert from '../models/Alert.model';

// ─── Whitelisted Field Types ──────────────────────────────────────────────────

interface AlertCreateBody {
  pair?: string;
  condition?: string;
  targetValue?: number;
  targetPattern?: string;
  timeframe?: string;
  type?: string;
}

interface AlertUpdateBody {
  pair?: string;
  condition?: string;
  targetValue?: number;
  targetPattern?: string;
  timeframe?: string;
  type?: string;
  enabled?: boolean;
}

// ─── Whitelist Pickers ────────────────────────────────────────────────────────

function pickCreateFields(body: Record<string, unknown>): AlertCreateBody {
  const result: AlertCreateBody = {};

  if (typeof body.pair === 'string')          result.pair          = body.pair;
  if (typeof body.condition === 'string')     result.condition     = body.condition;
  if (typeof body.targetValue === 'number')   result.targetValue   = body.targetValue;
  if (typeof body.targetPattern === 'string') result.targetPattern = body.targetPattern;
  if (typeof body.timeframe === 'string')     result.timeframe     = body.timeframe;
  if (typeof body.type === 'string')          result.type          = body.type;

  return result;
}

function pickUpdateFields(body: Record<string, unknown>): AlertUpdateBody {
  const result: AlertUpdateBody = {};

  if (typeof body.pair === 'string')          result.pair          = body.pair;
  if (typeof body.condition === 'string')     result.condition     = body.condition;
  if (typeof body.targetValue === 'number')   result.targetValue   = body.targetValue;
  if (typeof body.targetPattern === 'string') result.targetPattern = body.targetPattern;
  if (typeof body.timeframe === 'string')     result.timeframe     = body.timeframe;
  if (typeof body.type === 'string')          result.type          = body.type;
  if (typeof body.enabled === 'boolean')      result.enabled       = body.enabled;

  return result;
}

// ─── Get All Alerts ───────────────────────────────────────────────────────────

export const getAlerts = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const alerts = await Alert.find({ userId })
    .sort({ createdAt: -1 })
    .lean();

  sendSuccess(res, alerts);
});

// ─── Create Alert ─────────────────────────────────────────────────────────────

export const createAlert = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const data = pickCreateFields(req.body);

  if (!data.pair || !data.condition || !data.type) {
    sendBadRequest(res, 'pair, condition, and type are required');
    return;
  }

  const needsTargetValue = data.condition !== 'pattern_detected';
  if (needsTargetValue && data.targetValue === undefined) {
    sendBadRequest(res, 'targetValue is required for this condition');
    return;
  }

  if (data.condition === 'pattern_detected' && !data.targetPattern) {
    sendBadRequest(res, 'targetPattern is required for pattern_detected condition');
    return;
  }

  try {
    const alert = await Alert.create({ userId, ...data });
    sendCreated(res, alert);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.includes('Alert limit reached')
    ) {
      sendBadRequest(res, error.message);
      return;
    }
    throw error;
  }
});

// ─── Update Alert ─────────────────────────────────────────────────────────────

export const updateAlert = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const data = pickUpdateFields(req.body);

  if (Object.keys(data).length === 0) {
    sendBadRequest(res, 'No valid fields provided for update');
    return;
  }

  const alert = await Alert.findOneAndUpdate(
    { _id: req.params.id, userId },
    { $set: data },
    { new: true, runValidators: true }
  ).lean();

  if (!alert) {
    sendNotFound(res, 'Alert not found');
    return;
  }

  sendSuccess(res, alert);
});

// ─── Delete Alert ─────────────────────────────────────────────────────────────

export const deleteAlert = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const alert = await Alert.findOneAndDelete({
    _id: req.params.id,
    userId,
  }).lean();

  if (!alert) {
    sendNotFound(res, 'Alert not found');
    return;
  }

  sendSuccess(res, null, 'Alert deleted successfully');
});

// ─── Toggle Alert ─────────────────────────────────────────────────────────────

export const toggleAlert = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const alert = await Alert.findOneAndUpdate(
    { _id: req.params.id, userId },
    [{ $set: { enabled: { $not: '$enabled' } } }],
    { new: true }
  ).lean();

  if (!alert) {
    sendNotFound(res, 'Alert not found');
    return;
  }

  sendSuccess(
    res,
    alert,
    `Alert ${alert.enabled ? 'enabled' : 'disabled'}`
  );
});