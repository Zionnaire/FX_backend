// src/routes/chart.routes.ts

import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getOHLCVController,
  getSupportResistanceController,
  getFibonacciController,
  getCurrentPriceController,
  flushChartCacheController,
} from "../controllers/chart.controller";

const chartRouter = Router();

chartRouter.use(authMiddleware);

chartRouter.get("/ohlcv/:pair", getOHLCVController);
chartRouter.post("/cache/flush", flushChartCacheController);
chartRouter.get("/price/:pair", getCurrentPriceController);
chartRouter.get("/support/:pair", getSupportResistanceController);
chartRouter.get("/fibonacci/:pair", getFibonacciController);

export default chartRouter;
