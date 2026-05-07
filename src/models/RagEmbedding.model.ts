// src/models/RagEmbedding.model.ts

import mongoose, { Schema } from "mongoose";
import { IRagEmbedding } from "../types/rag.types";

const ragEmbeddingSchema = new Schema<IRagEmbedding>(
  {
    userId: {
      type: Schema.Types.ObjectId, // was String
      ref: "User",
      required: true,
      index: true,
    },
    documentId: {
      type: Schema.Types.ObjectId, // was String
      ref: "RagDocument",
      required: true,
      index: true,
    },
    chunkText: {
      type: String,
      required: true,
    },
    chunkIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    embedding: {
      type: [Number],
      required: true,
      validate: {
        validator: (v: number[]) => v.length === 768 || v.length === 384,
        message: "Embedding must be 768 (Jina) or 384 (HuggingFace) dimensions",
      },
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
  },
  { timestamps: true },
);

// Compound index for vector search filter by userId
ragEmbeddingSchema.index({ userId: 1 });

// Bulk delete index — used when deleting all chunks for a document
ragEmbeddingSchema.index({ documentId: 1 });

// Atlas Vector Search index must be created manually in MongoDB Atlas dashboard:
// Collection: ragembeddings
// Index name: vector_index
// Config: { fields: [{ type: "vector", path: "embedding", numDimensions: 768, similarity: "cosine" }] }

export default mongoose.model<IRagEmbedding>(
  "RagEmbedding",
  ragEmbeddingSchema,
);
