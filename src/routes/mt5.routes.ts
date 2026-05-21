import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import {
  eaAuthMiddleware,
  eaGetPending,
  eaConfirm,
  eaFail,
  eaHeartbeat,
  getUserExecutions,
  approveExecution,
  rejectExecution,
  updateLots,
} from '../controllers/mt5.controller';

const mt5Router = Router();

// ── EA endpoints (X-MT5-ApiKey auth, no JWT) ──────────────────────────────────
mt5Router.get( '/pending',   eaAuthMiddleware, eaGetPending);
mt5Router.post('/confirm',   eaAuthMiddleware, eaConfirm);
mt5Router.post('/fail',      eaAuthMiddleware, eaFail);
mt5Router.post('/heartbeat', eaAuthMiddleware, eaHeartbeat);

// ── User-facing endpoints (JWT auth) ──────────────────────────────────────────
mt5Router.get( '/executions',              authMiddleware, getUserExecutions);
mt5Router.post('/approve/:id',             authMiddleware, approveExecution);
mt5Router.post('/reject/:id',              authMiddleware, rejectExecution);
mt5Router.patch('/executions/:id/lots',    authMiddleware, updateLots);

export default mt5Router;
