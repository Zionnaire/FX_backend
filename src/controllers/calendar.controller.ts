import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import { sendSuccess } from '../utils/response.utils';
import { getAllUpcomingEvents } from '../services/economicCalendar.service';

export const getCalendarEvents = asyncHandler(async (req: Request, res: Response) => {
  const pair  = typeof req.query.pair === 'string' ? req.query.pair : 'GBP/USD';
  const hours = Math.min(48, Math.max(1, parseInt(String(req.query.hours ?? '24')) || 24));

  const events = await getAllUpcomingEvents(pair, hours);
  sendSuccess(res, events);
});
