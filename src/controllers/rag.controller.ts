// src/controllers/rag.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler';
import {
  sendSuccess,
  sendCreated,
  sendNotFound,
  sendBadRequest,
} from '../utils/response.utils';
import {
  uploadDocument,
  deleteDocument,
  queryKnowledgeBase,
  addManualEntry,
} from '../services/rag.service';
import {
  ingestEconomicCalendar,
  getAutoFeedDocs,
  seedDefaultKnowledge,
  getSeededDocs,
} from '../services/autoIngest.service';
import RagDocument from '../models/RagDocument.model';
import { Types } from 'mongoose';

const VALID_ENTRY_TYPES = ['document', 'rule', 'observation'] as const;
type EntryType = typeof VALID_ENTRY_TYPES[number];

// ─── Upload Document ──────────────────────────────────────────────────────────

export const uploadDocumentController = asyncHandler(
  async (req: Request, res: Response) => {
    if (!req.file) {
      sendBadRequest(res, 'File is required');
      return;
    }

    const document = await uploadDocument(
      req.user!.id,
      req.file.buffer,
      req.file.filename || req.file.originalname,
      req.file.originalname,
      req.file.mimetype
    );

    sendCreated(res, document);
  }
);

// ─── Get Documents ────────────────────────────────────────────────────────────

export const getDocumentsController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const documents = await RagDocument.find({
      userId: new Types.ObjectId(userId),
    })
      .sort({ createdAt: -1 })
      .lean();

    sendSuccess(res, documents);
  }
);

// ─── Delete Document ──────────────────────────────────────────────────────────

export const deleteDocumentController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId     = req.user!.id;
    const documentId = req.params.id;

    try {
      await deleteDocument(userId, documentId);
      sendSuccess(res, null, 'Document deleted successfully');
    } catch (error) {
      if (error instanceof Error && error.message === 'Document not found') {
        sendNotFound(res, 'Document not found');
        return;
      }
      throw error;
    }
  }
);

// ─── Query Knowledge Base ─────────────────────────────────────────────────────

export const queryKnowledgeBaseController = asyncHandler(
  async (req: Request, res: Response) => {
    const { question } = req.body;

    if (!question || typeof question !== 'string' || !question.trim()) {
      sendBadRequest(res, 'Question is required and must be a non-empty string');
      return;
    }

    if (question.length > 1000) {
      sendBadRequest(res, 'Question must be 1000 characters or fewer');
      return;
    }

    const result = await queryKnowledgeBase(req.user!.id, question.trim());
    sendSuccess(res, result);
  }
);

// ─── Add Manual Entry ─────────────────────────────────────────────────────────

export const addManualEntryController = asyncHandler(
  async (req: Request, res: Response) => {
    const { text, type, pair } = req.body;

    if (!text || typeof text !== 'string' || !text.trim()) {
      sendBadRequest(res, 'Text is required and must be a non-empty string');
      return;
    }

    if (!type || !VALID_ENTRY_TYPES.includes(type as EntryType)) {
      sendBadRequest(
        res,
        `type is required and must be one of: ${VALID_ENTRY_TYPES.join(', ')}`
      );
      return;
    }

    if (text.length > 10_000) {
      sendBadRequest(res, 'Text must be 10,000 characters or fewer');
      return;
    }

    const document = await addManualEntry(
      req.user!.id,
      text.trim(),
      type as EntryType,
      pair || ''
    );

    sendCreated(res, document);
  }
);

// ─── Auto-Feed Status ─────────────────────────────────────────────────────────

export const getAutoFeedController = asyncHandler(
  async (req: Request, res: Response) => {
    const docs = await getAutoFeedDocs(req.user!.id);
    sendSuccess(res, docs);
  }
);

// ─── Trigger Economic Calendar Ingest ─────────────────────────────────────────

export const ingestCalendarController = asyncHandler(
  async (req: Request, res: Response) => {
    const count = await ingestEconomicCalendar(req.user!.id);
    sendSuccess(res, { eventsIngested: count });
  }
);

// ─── Seed Default Knowledge Library ──────────────────────────────────────────

export const seedKnowledgeController = asyncHandler(
  async (req: Request, res: Response) => {
    const result = await seedDefaultKnowledge(req.user!.id);
    sendSuccess(res, result);
  }
);

// ─── Get Seeded Knowledge Docs ────────────────────────────────────────────────

export const getSeededDocsController = asyncHandler(
  async (req: Request, res: Response) => {
    const docs = await getSeededDocs(req.user!.id);
    sendSuccess(res, docs);
  }
);