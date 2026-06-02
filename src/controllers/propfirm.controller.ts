// src/controllers/propfirm.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import { sendSuccess, sendCreated, sendBadRequest, sendNotFound } from '../utils/response.utils';
import {
  createChallenge,
  getChallengeStatus,
  getChallengeHistory,
  ChallengeConfig,
} from '../services/propFirmTracker.service';

const VALID_FIRMS  = ['FTMO', 'MFF', 'TFT', 'MyFundedFX', 'custom'];
const VALID_PHASES = ['challenge', 'verification', 'funded'];

export const createChallengeHandler = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const {
    firm_name = 'custom',
    phase = 'challenge',
    account_size,
    daily_loss_limit_pct = 5,
    max_drawdown_pct = 10,
    profit_target_pct = 10,
    min_trading_days = 4,
    max_trading_days = 30,
  } = req.body as Partial<ChallengeConfig>;

  if (!account_size || account_size < 1000) {
    sendBadRequest(res, 'account_size must be ≥ 1000');
    return;
  }
  if (!VALID_PHASES.includes(phase)) {
    sendBadRequest(res, `phase must be one of: ${VALID_PHASES.join(', ')}`);
    return;
  }

  const challenge = await createChallenge(userId, {
    firm_name: VALID_FIRMS.includes(firm_name) ? firm_name : 'custom',
    phase:     phase as ChallengeConfig['phase'],
    account_size,
    daily_loss_limit_pct,
    max_drawdown_pct,
    profit_target_pct,
    min_trading_days,
    max_trading_days,
  });

  sendCreated(res, challenge);
});

export const getChallengeStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const status = await getChallengeStatus(req.user!.id);
  if (!status) {
    sendNotFound(res, 'No active challenge found');
    return;
  }
  sendSuccess(res, status);
});

export const getChallengeHistoryHandler = asyncHandler(async (req: Request, res: Response) => {
  const history = await getChallengeHistory(req.user!.id);
  sendSuccess(res, { count: history.length, challenges: history });
});
