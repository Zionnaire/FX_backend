// src/routes/scanner.routes.ts

import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { runScanHandler } from '../controllers/scanner.controller';

const scannerRouter = Router();
scannerRouter.use(authMiddleware);

// GET /api/scanner?style=swing   — scan all 4 pairs and return ranked setups
// GET /api/scanner?style=scalp   — scalp timeframes (1m/5m/15m)
scannerRouter.get('/', runScanHandler);

export default scannerRouter;
