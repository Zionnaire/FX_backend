// src/middlewares/errorHandler.ts
import env from '../config/env';

import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err:  Error & { status?: number; code?: number },
  _req: Request,
  res:  Response,
  _next: NextFunction
): void {
  console.error(`[Error] ${err.message}`, err.stack);

  // Mongoose validation error → 400
  if (err.name === 'ValidationError') {
    res.status(400).json({ success: false, message: err.message });
    return;
  }

  // Mongoose cast error (bad ObjectId) → 400
  if (err.name === 'CastError') {
    res.status(400).json({ success: false, message: 'Invalid ID format' });
    return;
  }

  // MongoDB duplicate key → 409
  if (err.code === 11000) {
    res.status(409).json({ success: false, message: 'Duplicate entry' });
    return;
  }

  // Multer file size error → 413
  if (err.message?.includes('File too large')) {
    res.status(413).json({ success: false, message: 'File too large. Maximum size is 10MB' });
    return;
  }

  // Multer file type error → 415
  if (err.message?.includes('Unsupported file type')) {
    res.status(415).json({ success: false, message: err.message });
    return;
  }

  // JWT errors that slip past auth middleware → 401
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
    return;
  }

  // Default → 500
  const statusCode = err.status ?? 500;
  res.status(statusCode).json({
    success: false,
    message: env.nodeEnv === 'production'
      ? 'An unexpected error occurred'
      : err.message,
  });
}