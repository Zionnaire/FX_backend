// src/models/RagDocument.model.ts

import mongoose, { Schema } from 'mongoose';
import { IRagDocument } from '../types/rag.types';

const ragDocumentSchema = new Schema<IRagDocument>(
  {
    userId: {
      type:     Schema.Types.ObjectId,  // was String
      ref:      'User',
      required: true,
      index:    true,
    },
    fileName: {
      type:     String,
      required: true,
      trim:     true,
    },
    fileUrl: {
      type:     String,
      required: true,
    },
    cloudinaryId: {
      type:     String,
      required: true,
    },
    mimetype: {
      type:     String,
      required: true,
      enum:     [
        'application/pdf',
        'text/plain',
        'text/csv',
        'application/json',
      ],
    },
    chunkCount: {
      type:    Number,
      default: 0,
      min:     0,
    },
    status: {
      type:    String,
      enum:    ['processing', 'indexed', 'error'],
      default: 'processing',
      index:   true,
    },
    type: {
      type:    String,
      enum:    ['document', 'rule', 'observation'],
      default: 'document',
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
  },
  { timestamps: true }
);

// Per-user document listing
ragDocumentSchema.index({ userId: 1, createdAt: -1 });

// Used by queryUserRules to find rules per pair
ragDocumentSchema.index({ userId: 1, type: 1 });

export default mongoose.model<IRagDocument>('RagDocument', ragDocumentSchema);