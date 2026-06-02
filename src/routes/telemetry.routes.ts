// src/routes/telemetry.routes.ts

import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import {
  getPerformanceReport,
  getBiasImpact,
  getExpectancy,
  getSignatureStats,
  getWeightProfile,
  getSetupClusters,
  getRegimeComparison,
  getRegimeWeightProfile,
  exportTradesCSVHandler,
  exportPerformanceHTMLHandler,
} from '../controllers/telemetry.controller';

const telemetryRouter = Router();

telemetryRouter.use(authMiddleware);

// GET /api/telemetry/performance?days=90      — full PerformanceReport (includes Phase 4 fields)
telemetryRouter.get('/performance',  getPerformanceReport);

// GET /api/telemetry/bias?days=90             — bias alignment analysis only
telemetryRouter.get('/bias',         getBiasImpact);

// GET /api/telemetry/expectancy?days=90       — session × regime × bias matrix
telemetryRouter.get('/expectancy',   getExpectancy);

// GET /api/telemetry/confidence?session=...   — historical confidence for a specific setup signature
telemetryRouter.get('/confidence',   getSignatureStats);

// GET /api/telemetry/weights                  — adaptive weight profile (cached)
// GET /api/telemetry/weights?refresh          — force weight recomputation
telemetryRouter.get('/weights',      getWeightProfile);

// GET /api/telemetry/clusters?days=90              — setup clusters with edge/stability labels
telemetryRouter.get('/clusters',          getSetupClusters);

// GET /api/telemetry/regime-comparison?days=90     — per-regime performance comparison
telemetryRouter.get('/regime-comparison', getRegimeComparison);

// GET /api/telemetry/regime-weights                — online-learned regime weight profiles
telemetryRouter.get('/regime-weights',    getRegimeWeightProfile);

// GET /api/telemetry/export/trades.csv             — download all trades as CSV
telemetryRouter.get('/export/trades.csv',         exportTradesCSVHandler);

// GET /api/telemetry/export/performance.html       — print-ready HTML performance report
telemetryRouter.get('/export/performance.html',   exportPerformanceHTMLHandler);

export default telemetryRouter;
