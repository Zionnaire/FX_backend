// src/routes/portfolio.routes.ts

import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import {
  getPortfolioRiskHandler,
  getBehaviorHandler,
  getDailyBriefingHandler,
} from '../controllers/portfolio.controller';

const portfolioRouter = Router();
portfolioRouter.use(authMiddleware);

// GET /api/portfolio/risk              — live risk exposure across all open trades
portfolioRouter.get('/risk',     getPortfolioRiskHandler);

// GET /api/portfolio/behavior?days=90  — behavioral pattern analysis
portfolioRouter.get('/behavior', getBehaviorHandler);

// GET /api/portfolio/briefing          — pre-session intelligence summary
portfolioRouter.get('/briefing', getDailyBriefingHandler);

export default portfolioRouter;
