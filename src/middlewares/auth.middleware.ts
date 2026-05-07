// src/middlewares/auth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { sendUnauthorized } from '../utils/response.utils';
import { verifyAccessToken } from '../utils/jwt.utils';

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  // Check header exists and has correct format
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendUnauthorized(res, 'Missing or invalid Authorization header');
    return;           // explicit return after sending — never call next()
  }

  const token = authHeader.substring(7).trim();

  // Catch empty token after "Bearer "
  if (!token) {
    sendUnauthorized(res, 'Token is empty');
    return;
  }

  try {
    const decoded = verifyAccessToken(token);  // now fully typed

    req.user = {
      id: decoded.userId,     // decoded.userId is guaranteed string by type
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      sendUnauthorized(res, 'Token has expired');
      return;
    }

    if (error instanceof JsonWebTokenError) {
      sendUnauthorized(res, 'Invalid token');
      return;
    }

    // Unexpected error — don't leak internals
    sendUnauthorized(res, 'Authentication failed');
  }
}