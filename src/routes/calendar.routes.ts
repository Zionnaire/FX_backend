import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { getCalendarEvents } from '../controllers/calendar.controller';

const calendarRouter = Router();
calendarRouter.use(authMiddleware);
calendarRouter.get('/', getCalendarEvents);

export default calendarRouter;
