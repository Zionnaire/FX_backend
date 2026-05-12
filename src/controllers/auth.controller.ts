// src/controllers/auth.controller.ts

import { Request, Response } from 'express';
import User from '../models/User.model';
import { asyncHandler } from '../middlewares/asyncHandler';
import {
  sendBadRequest,
  sendCreated,
  sendConflict,
  sendSuccess,
  sendUnauthorized,
} from '../utils/response.utils';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/jwt.utils';
import env from '../config/env';

// ─── Cookie Config ────────────────────────────────────────────────────────────

const isProd = env.nodeEnv === 'production';

// SameSite=None is required when the frontend and backend are on different
// domains (cross-site). Strict/Lax both block the cookie in cross-origin
// AJAX requests, causing restore() to fail and logging the user out on refresh.
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProd,
  sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
};

// ─── Safe User Shape ──────────────────────────────────────────────────────────
// Never send password or refreshToken to client

function safeUser(user: InstanceType<typeof User>) {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    role: user.role,
    simulationBalance: user.simulationBalance,
    preferences: user.preferences,
  };
}

// ─── Register ─────────────────────────────────────────────────────────────────

export const register = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    sendBadRequest(res, 'Name, email and password are required');
    return;
  }

  if (typeof password === 'string' && password.length < 6) {
    sendBadRequest(res, 'Password must be at least 6 characters');
    return;
  }

  const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
  if (existingUser) {
    sendConflict(res, 'Email already registered');
    return;
  }

  const user = await User.create({ name, email, password });

  const accessToken = signAccessToken(
    user._id.toString(),
    user.email,
    user.role
  );
  const refreshToken = signRefreshToken(user._id.toString());

  user.refreshToken = refreshToken;
  await user.save();

  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

  sendCreated(res, { accessToken, user: safeUser(user) });
});

// ─── Login ────────────────────────────────────────────────────────────────────

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    sendBadRequest(res, 'Email and password are required');
    return;
  }

  // Single generic message — never reveal which field is wrong
  const INVALID_MSG = 'Invalid email or password';

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) {
    sendUnauthorized(res, INVALID_MSG);
    return;
  }

  const isValid = await user.comparePassword(password);
  if (!isValid) {
    sendUnauthorized(res, INVALID_MSG);
    return;
  }

  const accessToken = signAccessToken(
    user._id.toString(),
    user.email,
    user.role
  );
  const refreshToken = signRefreshToken(user._id.toString());

  user.refreshToken = refreshToken;
  await user.save();

  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

  sendSuccess(res, { accessToken, user: safeUser(user) });
});

// ─── Refresh ──────────────────────────────────────────────────────────────────

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.refreshToken as string | undefined;

  if (!token) {
    sendUnauthorized(res, 'Refresh token missing');
    return;
  }

  let decoded: ReturnType<typeof verifyRefreshToken>;
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    sendUnauthorized(res, 'Invalid or expired refresh token');
    return;
  }

  const user = await User.findById(decoded.userId);

  // Both checks in one response — don't reveal which check failed
  if (!user || user.refreshToken !== token) {
    sendUnauthorized(res, 'Invalid refresh token');
    return;
  }

  const accessToken = signAccessToken(
    user._id.toString(),
    user.email,
    user.role
  );

  sendSuccess(res, { accessToken });
});

// ─── Logout ───────────────────────────────────────────────────────────────────

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;

  await User.findByIdAndUpdate(userId, { refreshToken: null });

  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: isProd,
    sameSite: (isProd ? 'none' : 'lax') as 'none' | 'lax',
    path: '/',
  });

  sendSuccess(res, null, 'Logged out successfully');
});