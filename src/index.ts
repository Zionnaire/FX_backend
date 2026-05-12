// src/index.ts

import dotenv from 'dotenv';
dotenv.config();

import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import axios from 'axios';

import { connectDB } from './config/db';
import env from './config/env';
import {errorHandler}  from './middlewares/errorHandler';

import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import tradeRoutes from './routes/trade.routes';
import signalRoutes from './routes/signal.routes';
import chartRoutes from './routes/chart.routes';
import newsRoutes from './routes/news.routes';
import ragRoutes from './routes/rag.routes';
import alertRoutes from './routes/alert.routes';
import analyticsRoutes from './routes/analytics.routes';

import { checkAlerts } from './services/alert.service';
import { evaluatePendingSignals } from './services/signalAccuracy.service';
import { monitorOpenTrades } from './services/tradeMonitor.service';

// ─── App Setup ────────────────────────────────────────────────────────────────

const app: Application = express();

// ─── Security Middleware ──────────────────────────────────────────────────────

app.use(helmet());

app.use(
  cors({
    origin: env.clientUrl,
    credentials: true,                    // required for httpOnly refresh-token cookie
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ─── Request Parsing ──────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());                  // must be before any route reads cookies

// ─── Logging ──────────────────────────────────────────────────────────────────

app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/signal', signalRoutes);
app.use('/api/chart', chartRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/rag', ragRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/analytics', analyticsRoutes);

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    environment: env.nodeEnv,
    timestamp: new Date().toISOString(),  // ISO string, not Date object
  });
});

// ─── 404 Handler (must be after all routes) ───────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ─── Global Error Handler (must be last) ──────────────────────────────────────

app.use(errorHandler);

// ─── Interval Handles (kept for graceful shutdown cleanup) ────────────────────

let alertInterval:        ReturnType<typeof setInterval> | null = null;
let accuracyInterval:     ReturnType<typeof setInterval> | null = null;
let keepAliveInterval:    ReturnType<typeof setInterval> | null = null;
let tradeMonitorInterval: ReturnType<typeof setInterval> | null = null;

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = (signal: string) => {
  console.log(`\n${signal} received — shutting down gracefully`);

  if (alertInterval)        clearInterval(alertInterval);
  if (accuracyInterval)     clearInterval(accuracyInterval);
  if (keepAliveInterval)    clearInterval(keepAliveInterval);
  if (tradeMonitorInterval) clearInterval(tradeMonitorInterval);

  // Give in-flight requests 10s to finish, then force close
  const forceExit = setTimeout(() => {
    console.error('Could not close connections in time — forcing exit');
    process.exit(1);
  }, 10_000);

  forceExit.unref(); // don't let this timer keep the process alive on its own

  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Unhandled Error Guards ───────────────────────────────────────────────────

process.on('unhandledRejection', (reason: unknown) => {
  console.error('Unhandled Promise Rejection:', reason);
  // Don't crash in production — log and continue
  // In development you may want: process.exit(1)
});

process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error.message);
  // Uncaught exceptions leave the process in an undefined state — always exit
  shutdown('uncaughtException');
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const bootstrap = async (): Promise<void> => {
  try {
    await connectDB();

    const PORT = Number(env.port) || 5000;

    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT} [${env.nodeEnv}]`);
    });

    // Trade monitor — checks open trades against SL/TP every 60s
    tradeMonitorInterval = setInterval(async () => {
      try {
        await monitorOpenTrades();
      } catch (err) {
        console.error('Trade monitor failed:', err);
      }
    }, 60_000);

    // Run once immediately at startup to catch any already-breached trades
    setImmediate(async () => {
      try { await monitorOpenTrades(); } catch { /* silent */ }
    });

    // Alert checker — runs every 60s (or env-configured interval)
    alertInterval = setInterval(async () => {
      try {
        await checkAlerts();
      } catch (err) {
        console.error('Alert check failed:', err);
      }
    }, env.alertCheckIntervalMs || 60_000);

    // Signal accuracy evaluator — runs every 30 minutes
    // Checks past signals whose timeHorizon has elapsed and records correctness
    accuracyInterval = setInterval(async () => {
      try {
        await evaluatePendingSignals();
      } catch (err) {
        console.error('Accuracy evaluation failed:', err);
      }
    }, 30 * 60 * 1000);

    // Run once at startup to catch any signals from a previous session
    setImmediate(async () => {
      try { await evaluatePendingSignals(); } catch { /* silent */ }
    });

    // Render free tier keep-alive ping — every 14 minutes
    // Uses AbortController so stale requests don't accumulate
    if (env.backendUrl) {
      keepAliveInterval = setInterval(() => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000); // 10s timeout

        axios
          .get(`${env.backendUrl}/api/health`, {
            signal: controller.signal,
          })
          .catch(() => {
            // Silently ignore — this is best-effort only
          })
          .finally(() => clearTimeout(timeout));
      }, 14 * 60 * 1000);
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);               // fatal — DB failed, nothing works without it
  }
};

bootstrap();