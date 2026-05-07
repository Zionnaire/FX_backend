// src/routes/analytics.routes.ts

import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getStatsController,
  getPnlCurveController,
  getByPairController,
  getSignalAccuracyController,
  getCoachingController,
} from "../controllers/analytics.controller";

const analyticsRouter = Router();

analyticsRouter.use(authMiddleware);

analyticsRouter.get("/stats", getStatsController);
analyticsRouter.get("/pnl-curve", getPnlCurveController);
analyticsRouter.get("/by-pair", getByPairController);
analyticsRouter.get("/signal-accuracy", getSignalAccuracyController);
analyticsRouter.get("/coaching", getCoachingController);

export default analyticsRouter;
