// src/utils/response.utils.ts

import { Response } from 'express';

// ─── Success ──────────────────────────────────────────────────────────────────

export function sendSuccess(
  res: Response,
  data: unknown,
  message = 'Success',
  statusCode = 200
): void {
  res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

export function sendCreated(
  res: Response,
  data: unknown,
  message = 'Created successfully'
): void {
  res.status(201).json({
    success: true,
    message,
    data,
  });
}

// ─── Error ────────────────────────────────────────────────────────────────────

export function sendError(
  res: Response,
  message: string,
  statusCode = 500,
  errors: Record<string, unknown> | string[] | null = null
): void {
  const body: Record<string, unknown> = {
    success: false,
    message,
  };

  // Only include errors field when there's something useful to show
  if (errors !== null) {
    body.errors = errors;
  }

  // Stack traces go to server logs only — never to the client
  res.status(statusCode).json(body);
}

// ─── Specific Error Helpers ───────────────────────────────────────────────────

export function sendUnauthorized(res: Response, message = 'Unauthorized'): void {
  sendError(res, message, 401);
}

// 403 = authenticated but not permitted — different from 401
export function sendForbidden(res: Response, message = 'Forbidden'): void {
  sendError(res, message, 403);
}

export function sendNotFound(res: Response, message = 'Not found'): void {
  sendError(res, message, 404);
}

export function sendBadRequest(
  res: Response,
  message = 'Bad request',
  errors: Record<string, unknown> | string[] | null = null
): void {
  sendError(res, message, 400, errors);
}

export function sendConflict(res: Response, message = 'Conflict'): void {
  sendError(res, message, 409);
}