// src/routes/analytics.routes.ts

import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getStatsController,
  getPnlCurveController,
  getByPairController,
  getBySessionController,
  getSignalAccuracyController,
  getCoachingController,
  runBacktestController,
  runMonteCarloController,
} from "../controllers/analytics.controller";

const analyticsRouter = Router();

analyticsRouter.use(authMiddleware);

analyticsRouter.get("/stats", getStatsController);
analyticsRouter.get("/pnl-curve", getPnlCurveController);
analyticsRouter.get("/by-pair", getByPairController);
analyticsRouter.get("/by-session", getBySessionController);
analyticsRouter.get("/signal-accuracy", getSignalAccuracyController);
analyticsRouter.get("/coaching", getCoachingController);
analyticsRouter.get("/backtest",     runBacktestController);
analyticsRouter.get("/montecarlo",   runMonteCarloController);

export default analyticsRouter;
