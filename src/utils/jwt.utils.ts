// src/utils/jwt.utils.ts

import jwt, { SignOptions, JwtPayload } from 'jsonwebtoken';
import env from '../config/env';

// ─── Typed Payload Interfaces ─────────────────────────────────────────────────

export interface AccessTokenPayload extends JwtPayload {
  userId: string;
  email: string;
  role: string;
  type: 'access';           // token type discriminator
}

export interface RefreshTokenPayload extends JwtPayload {
  userId: string;
  type: 'refresh';          // token type discriminator
}

// ─── Sign ─────────────────────────────────────────────────────────────────────

export function signAccessToken(
  userId: string,
  email: string,
  role: string
): string {
  const payload = { userId, email, role, type: 'access' };
  const options: SignOptions = {
    expiresIn: env.jwtAccessExpiresIn as SignOptions['expiresIn'],
  };
  return jwt.sign(payload, env.jwtAccessSecret, options);
}

export function signRefreshToken(userId: string): string {
  const payload = { userId, type: 'refresh' };
  const options: SignOptions = {
    expiresIn: env.jwtRefreshExpiresIn as SignOptions['expiresIn'],
  };
  return jwt.sign(payload, env.jwtRefreshSecret, options);
}

// ─── Verify ───────────────────────────────────────────────────────────────────

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.jwtAccessSecret) as AccessTokenPayload;

  // Reject refresh tokens passed to this function
  if (decoded.type !== 'access') {
    throw new Error('Invalid token type');
  }

  return decoded;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(
    token,
    env.jwtRefreshSecret
  ) as RefreshTokenPayload;

  // Reject access tokens passed to this function
  if (decoded.type !== 'refresh') {
    throw new Error('Invalid token type');
  }

  return decoded;
}