// src/routes/signal.routes.ts

import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getSignalController,
  getSignalHistoryController,
} from "../controllers/signal.controller";

const signalRouter = Router();

signalRouter.use(authMiddleware);

// Static segment /history/:pair MUST come before dynamic /:pair
// Otherwise GET /history/XAU/USD matches /:pair with pair="history"
signalRouter.get("/history/:pair", getSignalHistoryController);
signalRouter.get("/:pair", getSignalController);

export default signalRouter;
