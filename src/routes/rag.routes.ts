// src/routes/rag.routes.ts

import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { uploadMiddleware } from "../middlewares/cloudinary.middleware";
import {
  uploadDocumentController,
  getDocumentsController,
  deleteDocumentController,
  queryKnowledgeBaseController,
  addManualEntryController,
  getAutoFeedController,
  ingestCalendarController,
} from "../controllers/rag.controller";

const ragRouter = Router();

ragRouter.use(authMiddleware);

ragRouter.post("/upload", uploadMiddleware, uploadDocumentController);
ragRouter.get("/documents", getDocumentsController);
ragRouter.delete("/documents/:id", deleteDocumentController);
ragRouter.post("/query", queryKnowledgeBaseController);
ragRouter.post("/manual", addManualEntryController);
ragRouter.get("/auto-feed", getAutoFeedController);
ragRouter.post("/auto-feed/calendar", ingestCalendarController);

export default ragRouter;
