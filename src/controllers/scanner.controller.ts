// src/controllers/scanner.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import { sendSuccess, sendBadRequest } from '../utils/response.utils';
import { scanAllPairs } from '../services/scanner.service';

export const runScanHandler = asyncHandler(async (req: Request, res: Response) => {
  const style = (req.query.style as string) ?? 'swing';

  if (style !== 'scalp' && style !== 'swing') {
    sendBadRequest(res, 'style must be "scalp" or "swing"');
    return;
  }

  const summary = await scanAllPairs(style as 'scalp' | 'swing');
  sendSuccess(res, summary);
});
