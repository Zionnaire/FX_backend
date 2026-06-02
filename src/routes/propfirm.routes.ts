// src/routes/propfirm.routes.ts

import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import {
  createChallengeHandler,
  getChallengeStatusHandler,
  getChallengeHistoryHandler,
} from '../controllers/propfirm.controller';

const propFirmRouter = Router();
propFirmRouter.use(authMiddleware);

// POST /api/propfirm            — create or replace the active challenge
propFirmRouter.post('/',         createChallengeHandler);

// GET  /api/propfirm/status     — live status: daily loss used, progress, can_trade
propFirmRouter.get('/status',    getChallengeStatusHandler);

// GET  /api/propfirm/history    — all past challenges for this user
propFirmRouter.get('/history',   getChallengeHistoryHandler);

export default propFirmRouter;
