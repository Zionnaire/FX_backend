// src/controllers/telemetry.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import { sendSuccess, sendBadRequest } from '../utils/response.utils';
import {
  generatePerformanceReport,
  getSignatureConfidence,
  getBiasImpactReport,
  getExpectancyMatrix,
  getSetupClustersForUser,
  SignatureInput,
} from '../services/performanceAnalytics.service';
import { getAdaptiveWeights, computeAndCacheWeights } from '../services/adaptiveWeights.service';
import { generateRegimeComparisonReport } from '../services/regimeComparison.service';
import { getRegimeWeightDocument } from '../services/onlineLearning.service';
import { exportTradesCSV, exportPerformanceHTML } from '../services/exportReport.service';

const VALID_SESSIONS  = ['Asian', 'London Open', 'London-NY Overlap', 'New York'];
const VALID_REGIMES   = ['trend', 'range', 'compression', 'expansion', 'news'];
const VALID_BIASES    = ['bullish', 'bearish', 'neutral'];
const VALID_BUCKETS   = ['low', 'medium', 'high'];
const VALID_TRIGGERS  = [
  'LIQUIDITY_RECLAIM', 'BOS_CLOSE', 'OB_MITIGATION',
  'FVG_REJECTION', 'DISPLACEMENT_CLOSE', 'ENGULFING',
];

// ─── Full performance report ──────────────────────────────────────────────────

export const getPerformanceReport = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const lookback = parseInt(req.query.days as string, 10) || 90;

    if (lookback < 1 || lookback > 365) {
      sendBadRequest(res, 'days must be between 1 and 365');
      return;
    }

    const report = await generatePerformanceReport(userId, lookback);
    sendSuccess(res, report);
  }
);

// ─── Bias impact analysis ──────────────────────────────────────────────────────

export const getBiasImpact = asyncHandler(
  async (req: Request, res: Response) => {
    const userId  = req.user!.id;
    const lookback = parseInt(req.query.days as string, 10) || 90;
    const data    = await getBiasImpactReport(userId, lookback);
    sendSuccess(res, data);
  }
);

// ─── Expectancy matrix ────────────────────────────────────────────────────────

export const getExpectancy = asyncHandler(
  async (req: Request, res: Response) => {
    const userId  = req.user!.id;
    const lookback = parseInt(req.query.days as string, 10) || 90;
    const matrix  = await getExpectancyMatrix(userId, lookback);
    sendSuccess(res, matrix);
  }
);

// ─── Setup signature confidence ───────────────────────────────────────────────
// GET /api/telemetry/confidence?session=London+Open&regime=trend&bias=bullish
//   &triggers=BOS_CLOSE,OB_MITIGATION&ob=high&fvg=medium

export const getSignatureStats = asyncHandler(
  async (req: Request, res: Response) => {
    const userId   = req.user!.id;
    const { session, regime, bias, triggers, ob, fvg } = req.query as Record<string, string>;

    if (!session || !VALID_SESSIONS.includes(session)) {
      sendBadRequest(res, `session must be one of: ${VALID_SESSIONS.join(', ')}`);
      return;
    }
    if (!regime || !VALID_REGIMES.includes(regime)) {
      sendBadRequest(res, `regime must be one of: ${VALID_REGIMES.join(', ')}`);
      return;
    }
    if (!bias || !VALID_BIASES.includes(bias)) {
      sendBadRequest(res, `bias must be one of: ${VALID_BIASES.join(', ')}`);
      return;
    }
    if (!ob || !VALID_BUCKETS.includes(ob)) {
      sendBadRequest(res, `ob must be one of: ${VALID_BUCKETS.join(', ')}`);
      return;
    }
    if (!fvg || !VALID_BUCKETS.includes(fvg)) {
      sendBadRequest(res, `fvg must be one of: ${VALID_BUCKETS.join(', ')}`);
      return;
    }

    const triggerList = triggers
      ? triggers.split(',').map((t) => t.trim()).filter((t) => VALID_TRIGGERS.includes(t))
      : [];

    const input: SignatureInput = {
      triggerTypes: triggerList,
      session,
      regime,
      obBucket:  ob  as 'low' | 'medium' | 'high',
      fvgBucket: fvg as 'low' | 'medium' | 'high',
      bias:      bias as 'bullish' | 'bearish' | 'neutral',
    };

    const result = await getSignatureConfidence(userId, input);
    sendSuccess(res, result);
  }
);

// ─── Adaptive weight profile ──────────────────────────────────────────────────
// GET /api/telemetry/weights          — current cached profile
// GET /api/telemetry/weights?refresh  — force recompute

export const getWeightProfile = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    if ('refresh' in req.query) {
      const profile = await computeAndCacheWeights(userId);
      sendSuccess(res, profile);
      return;
    }

    const profile = await getAdaptiveWeights(userId);
    if (!profile) {
      sendSuccess(res, {
        message: 'No weight profile yet — minimum 30 closed trades required.',
        is_reliable: false,
        sample_size: 0,
      });
      return;
    }
    sendSuccess(res, profile);
  }
);

// ─── Setup clusters ───────────────────────────────────────────────────────────
// GET /api/telemetry/clusters?days=90  — all setup clusters with edge labels

export const getSetupClusters = asyncHandler(
  async (req: Request, res: Response) => {
    const userId  = req.user!.id;
    const lookback = parseInt(req.query.days as string, 10) || 90;

    if (lookback < 1 || lookback > 365) {
      sendBadRequest(res, 'days must be between 1 and 365');
      return;
    }

    const clusters = await getSetupClustersForUser(userId, lookback);
    sendSuccess(res, {
      total:               clusters.length,
      high_edge_count:     clusters.filter((c) => c.edge_label.startsWith('HIGH EDGE')).length,
      high_stability_count:clusters.filter((c) => c.edge_label.includes('HIGH STABILITY')).length,
      clusters,
    });
  }
);

// ─── Regime comparison report ─────────────────────────────────────────────────
// GET /api/telemetry/regime-comparison?days=90

export const getRegimeComparison = asyncHandler(
  async (req: Request, res: Response) => {
    const userId   = req.user!.id;
    const lookback = parseInt(req.query.days as string, 10) || 90;

    if (lookback < 1 || lookback > 365) {
      sendBadRequest(res, 'days must be between 1 and 365');
      return;
    }

    const report = await generateRegimeComparisonReport(userId, lookback);
    sendSuccess(res, report);
  }
);

// ─── Regime weight profile (online-learned, per-regime) ───────────────────────
// GET /api/telemetry/regime-weights

export const getRegimeWeightProfile = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const doc    = await getRegimeWeightDocument(userId);

    if (!doc) {
      sendSuccess(res, {
        message:       'No regime profiles yet — regime learning starts after the first trade closes.',
        regime_counts: { trend: 0, range: 0, compression: 0, expansion: 0, news: 0 },
      });
      return;
    }

    const regimes = ['trend', 'range', 'compression', 'expansion', 'news'] as const;
    const counts: Record<string, number> = {};
    for (const r of regimes) {
      counts[r] = (doc[r] as { sample_size?: number })?.sample_size ?? 0;
    }

    sendSuccess(res, {
      computed_at:      doc.computed_at,
      stability_state:  doc.stability_state,
      hysteresis_state: doc.hysteresis_state,
      regime_counts:    counts,
      profiles:         Object.fromEntries(regimes.map((r) => [r, doc[r]])),
    });
  }
);

// ─── Export: trades CSV ───────────────────────────────────────────────────────
// GET /api/telemetry/export/trades.csv

export const exportTradesCSVHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const csv = await exportTradesCSV(req.user!.id);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="trades.csv"');
    res.status(200).send(csv);
  }
);

// ─── Export: performance HTML report ─────────────────────────────────────────
// GET /api/telemetry/export/performance.html

export const exportPerformanceHTMLHandler = asyncHandler(
  async (req: Request, res: Response) => {
    const html = await exportPerformanceHTML(req.user!.id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  }
);
