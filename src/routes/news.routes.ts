// src/routes/news.routes.ts

import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getNewsByPairController,
  getEconomicCalendarController,
} from "../controllers/news.controller";

const newsRouter = Router();

newsRouter.use(authMiddleware);

// Static route MUST come before dynamic /:pair
// Otherwise /calendar is swallowed by /:pair with pair="calendar"
newsRouter.get("/calendar", getEconomicCalendarController);
newsRouter.get("/:pair", getNewsByPairController);

export default newsRouter;
