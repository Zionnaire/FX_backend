// MT5 controller — two sets of endpoints:
//
//  EA-facing  (authenticated by X-MT5-ApiKey header, no JWT):
//    GET  /api/mt5/pending          ← EA polls every 5s for next approved trade
//    POST /api/mt5/confirm          ← EA reports successful execution
//    POST /api/mt5/fail             ← EA reports failed execution
//    POST /api/mt5/heartbeat        ← EA keepalive (updates eaLastPollAt)
//
//  User-facing (JWT-authenticated):
//    GET  /api/mt5/executions       ← Frontend polls for pending/recent executions
//    POST /api/mt5/approve/:id      ← User approves a pending execution
//    POST /api/mt5/reject/:id       ← User rejects a pending execution
//    PATCH /api/mt5/executions/:id/lots  ← User adjusts lot size before approval

import { Request, Response, NextFunction } from 'express';
import Trade from '../models/Trade.model';
import PendingExecution from '../models/PendingExecution.model';
import User from '../models/User.model';
import { asyncHandler } from '../middlewares/asyncHandler';
import {
  sendSuccess, sendCreated, sendNotFound, sendBadRequest, sendError,
} from '../utils/response.utils';
import { Types } from 'mongoose';

// ─── EA Auth Middleware ───────────────────────────────────────────────────────
// Validates X-MT5-ApiKey header and attaches the matched userId to req

export async function eaAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const apiKey = req.headers['x-mt5-apikey'] as string | undefined;
  if (!apiKey) {
    res.status(401).json({ success: false, message: 'Missing X-MT5-ApiKey header' });
    return;
  }

  const user = await User.findOne({ 'autoTrade.mt5ApiKey': apiKey }).lean();
  if (!user) {
    res.status(401).json({ success: false, message: 'Invalid API key' });
    return;
  }

  (req as any).mt5UserId = user._id;
  next();
}

// ─── EA: GET /api/mt5/pending ─────────────────────────────────────────────────
// Returns the oldest APPROVED execution waiting for the EA to execute.
// Returns { data: null } when nothing is waiting.

export const eaGetPending = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).mt5UserId;

  // Update EA heartbeat
  await User.findByIdAndUpdate(userId, { 'autoTrade.eaLastPollAt': new Date() });

  const exec = await PendingExecution.findOne({
    userId,
    status: 'APPROVED',
  }).sort({ approvedAt: 1 }).lean();

  if (!exec) {
    sendSuccess(res, null);
    return;
  }

  // Mark as EXECUTING so the EA doesn't pick it up twice
  await PendingExecution.findByIdAndUpdate(exec._id, { status: 'EXECUTING' });

  // Map pair to MT5 symbol (e.g. GBP/USD → GBPUSD)
  const symbol = exec.pair.replace('/', '');

  sendSuccess(res, {
    id:         exec._id.toString(),
    symbol,
    direction:  exec.direction,
    entry:      exec.entry,
    stopLoss:   exec.stopLoss,
    takeProfit: exec.takeProfit,
    lots:       exec.lots,
    entryType:  exec.entryType,
    slippage:   3,
  });
});

// ─── EA: POST /api/mt5/confirm ────────────────────────────────────────────────
// EA reports successful trade placement. Creates a real Trade record.

export const eaConfirm = asyncHandler(async (req: Request, res: Response) => {
  const userId   = (req as any).mt5UserId;
  const { id, ticket, fillPrice, lots } = req.body;

  if (!id || !ticket) {
    sendBadRequest(res, 'id and ticket are required');
    return;
  }

  const exec = await PendingExecution.findOne({
    _id: new Types.ObjectId(id), userId,
  });
  if (!exec) { sendNotFound(res, 'Execution not found'); return; }

  const actualFill = fillPrice ?? exec.entry;
  const actualLots = lots ?? exec.lots;

  // Update execution record
  exec.status    = 'EXECUTED';
  exec.mt5Ticket = ticket;
  exec.fillPrice = actualFill;
  exec.fillTime  = new Date();
  exec.lots      = actualLots;
  await exec.save();

  // Create a Trade record so it appears in history / P&L
  await Trade.create({
    userId:     exec.userId,
    pair:       exec.pair,
    type:       exec.direction,
    entry:      actualFill,
    stopLoss:   exec.stopLoss,
    takeProfit: exec.takeProfit,
    size:       actualLots,
    rr:         exec.riskReward,
    status:     'open',
    source:     'ai_auto',
    aiSignalId: exec.signalId,
    notes:      `MT5 ticket #${ticket} — auto-executed by AURA Bridge EA`,
  });

  console.log(`[MT5] Trade confirmed: ${exec.pair} ${exec.direction} ticket=${ticket} fill=${actualFill}`);
  sendSuccess(res, { message: 'Trade recorded', ticket });
});

// ─── EA: POST /api/mt5/fail ───────────────────────────────────────────────────

export const eaFail = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).mt5UserId;
  const { id, reason } = req.body;

  const exec = await PendingExecution.findOne({
    _id: new Types.ObjectId(id), userId,
  });
  if (!exec) { sendNotFound(res, 'Execution not found'); return; }

  exec.status     = 'FAILED';
  exec.failReason = reason ?? 'Unknown error from EA';
  await exec.save();

  console.warn(`[MT5] Execution failed: ${exec.pair} ${exec.direction} — ${exec.failReason}`);
  sendSuccess(res, { message: 'Failure recorded' });
});

// ─── EA: POST /api/mt5/heartbeat ─────────────────────────────────────────────

export const eaHeartbeat = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).mt5UserId;
  await User.findByIdAndUpdate(userId, { 'autoTrade.eaLastPollAt': new Date() });
  sendSuccess(res, { ts: new Date().toISOString() });
});

// ─── User: GET /api/mt5/executions ────────────────────────────────────────────
// Returns executions for the logged-in user (recent 20, last 48h)

export const getUserExecutions = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const since  = new Date(Date.now() - 48 * 3600_000);

  const executions = await PendingExecution.find({
    userId:    new Types.ObjectId(userId),
    createdAt: { $gte: since },
  }).sort({ createdAt: -1 }).limit(20).lean();

  sendSuccess(res, executions);
});

// ─── User: POST /api/mt5/approve/:id ─────────────────────────────────────────

export const approveExecution = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const exec   = await PendingExecution.findOne({
    _id:    new Types.ObjectId(req.params.id),
    userId: new Types.ObjectId(userId),
    status: 'PENDING_APPROVAL',
  });

  if (!exec) { sendNotFound(res, 'Pending execution not found or already actioned'); return; }

  exec.status     = 'APPROVED';
  exec.approvedAt = new Date();
  await exec.save();

  sendSuccess(res, exec);
});

// ─── User: POST /api/mt5/reject/:id ──────────────────────────────────────────

export const rejectExecution = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const exec   = await PendingExecution.findOne({
    _id:    new Types.ObjectId(req.params.id),
    userId: new Types.ObjectId(userId),
    status: 'PENDING_APPROVAL',
  });

  if (!exec) { sendNotFound(res, 'Pending execution not found or already actioned'); return; }

  exec.status     = 'REJECTED';
  exec.rejectedAt = new Date();
  await exec.save();

  sendSuccess(res, exec);
});

// ─── User: PATCH /api/mt5/executions/:id/lots ────────────────────────────────

export const updateLots = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const lots   = parseFloat(req.body.lots);

  if (!lots || lots < 0.01) {
    sendBadRequest(res, 'lots must be ≥ 0.01');
    return;
  }

  const exec = await PendingExecution.findOneAndUpdate(
    { _id: new Types.ObjectId(req.params.id), userId: new Types.ObjectId(userId), status: 'PENDING_APPROVAL' },
    { $set: { lots } },
    { new: true },
  );

  if (!exec) { sendNotFound(res, 'Pending execution not found'); return; }
  sendSuccess(res, exec);
});
