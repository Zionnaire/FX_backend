// src/services/rag.service.ts

import { Types } from "mongoose";
import { extractText } from "../utils/textExtractor.utils";
import {
  generateEmbedding,
  generateBatchEmbeddings,
} from "./embedding.service";
import { answerWithContext } from "./groq.service";
import RagDocument from "../models/RagDocument.model";
import RagEmbedding from "../models/RagEmbedding.model";
import Trade from "../models/Trade.model";
import {
  uploadDocumentToCloudinary,
  deleteFromCloudinary,
} from "../utils/cloudinary.utils";
import { IRagDocument } from "../types/rag.types";

// ─── chunkText ────────────────────────────────────────────────────────────────

export function chunkText(
  text: string,
  chunkSize = 500,
  overlap = 50,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  const step = Math.max(1, chunkSize - overlap); // prevent infinite loop if overlap >= chunkSize

  for (let i = 0; i < words.length; i += step) {
    const chunk = words.slice(i, i + chunkSize).join(" ");
    if (chunk.split(/\s+/).length >= 20) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

// ─── uploadDocument ───────────────────────────────────────────────────────────

export async function uploadDocument(
  userId: string,
  buffer: Buffer,
  fileName: string,
  originalName: string,
  mimetype: string,
): Promise<IRagDocument> {
  // Upload to Cloudinary first — if this fails, nothing is saved to DB
  const { fileUrl, fileCldId } = await uploadDocumentToCloudinary(
    buffer,
    "aura-forex/rag-docs",
    mimetype,
  );

  // Extract text from file
  const text = await extractText(buffer, mimetype);

  if (!text || text.trim().length === 0) {
    // Clean up Cloudinary upload before throwing
    await deleteFromCloudinary(fileCldId).catch(() => {});
    throw new Error("No text could be extracted from the uploaded file");
  }

  const chunks = chunkText(text);

  if (chunks.length === 0) {
    await deleteFromCloudinary(fileCldId).catch(() => {});
    throw new Error("Document produced no indexable chunks after processing");
  }

  // Save document record with processing status
  const doc = await RagDocument.create({
    userId: new Types.ObjectId(userId),
    fileName: originalName,
    fileUrl,
    cloudinaryId: fileCldId,
    mimetype,
    chunkCount: chunks.length,
    status: "processing",
    type: "document",
  });

  try {
    const embeddings = await generateBatchEmbeddings(chunks);

    const embeddingDocs = chunks.map((chunk, idx) => ({
      userId: new Types.ObjectId(userId),
      documentId: doc._id,
      chunkText: chunk,
      chunkIndex: idx,
      embedding: embeddings[idx],
    }));

    await RagEmbedding.insertMany(embeddingDocs, { ordered: false });

    doc.status = "indexed";
    await doc.save();
  } catch (error) {
    // Mark as error so user knows indexing failed — don't delete,
    // they can retry or delete manually
    doc.status = "error";
    await doc.save();
    throw error;
  }

  return doc;
}

// ─── queryKnowledgeBase ───────────────────────────────────────────────────────

export async function queryKnowledgeBase(
  userId: string,
  question: string,
): Promise<{ answer: string; sourceChunks: string[] }> {
  if (!question || question.trim().length === 0) {
    throw new Error("Question cannot be empty");
  }

  const queryEmbedding = await generateEmbedding(question, true);

  // Atlas Vector Search — requires the vector_index to exist in MongoDB Atlas
  const results = await RagEmbedding.aggregate([
    {
      $vectorSearch: {
        index: "vector_index",
        path: "embedding",
        queryVector: queryEmbedding,
        numCandidates: 50,
        limit: 5,
        filter: { userId: new Types.ObjectId(userId) },
      },
    } as any,
    {
      $project: {
        chunkText: 1,
        _id: 0,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ]);

  const topChunks: string[] = results.map(
    (r: { chunkText: string }) => r.chunkText,
  );

  // Recent trades as context for the AI answer
  const trades = await Trade.find({ userId })
    .sort({ createdAt: -1 })
    .limit(10)
    .select("pair type entry exit pnl status rr createdAt")
    .lean();

  const tradingContext = JSON.stringify({ recentTrades: trades });

  const answer = await answerWithContext(question, topChunks, tradingContext);

  return { answer, sourceChunks: topChunks };
}

// ─── queryUserRules ───────────────────────────────────────────────────────────
// Used by signal.service to inject personal rules into the signal prompt

export async function queryUserRules(
  userId: string,
  pair: string,
): Promise<string> {
  // Escape special regex characters in pair string (e.g. XAU/USD has /)
  const escaped = pair.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const results = await RagEmbedding.find({
    userId: new Types.ObjectId(userId),
  })
    .where("chunkText")
    .regex(new RegExp(escaped, "i"))
    .limit(3)
    .select("chunkText")
    .lean();

  return results.map((r) => r.chunkText).join("\n\n");
}

// ─── addManualEntry ───────────────────────────────────────────────────────────

export async function addManualEntry(
  userId: string,
  text: string,
  type: "document" | "rule" | "observation",
  pair: string,
): Promise<IRagDocument> {
  if (!text || text.trim().length === 0) {
    throw new Error("Manual entry text cannot be empty");
  }

  const buffer = Buffer.from(text.trim(), "utf-8");
  const fileName = `manual-${type}-${Date.now()}.txt`;

  const doc = await uploadDocument(
    userId,
    buffer,
    fileName,
    fileName,
    "text/plain",
  );

  // Update the type and metadata after creation
  doc.type = type;
  if (pair) {
    doc.metadata = { pair };
  }
  await RagDocument.findByIdAndUpdate(doc._id, {
    type,
    ...(pair ? { metadata: { pair } } : {}),
  });

  return doc;
}

// ─── deleteDocument ───────────────────────────────────────────────────────────

export async function deleteDocument(
  userId: string,
  documentId: string,
): Promise<void> {
  const doc = await RagDocument.findOne({
    _id: documentId,
    userId: new Types.ObjectId(userId), // ownership check
  });

  if (!doc) {
    throw new Error("Document not found"); // controller catches and returns 404
  }

  // Delete from Cloudinary — don't block DB cleanup if this fails
  await deleteFromCloudinary(doc.cloudinaryId).catch((err) => {
    console.error(`Cloudinary delete failed for ${doc.cloudinaryId}:`, err);
  });

  // Delete all embedding chunks for this document
  await RagEmbedding.deleteMany({ documentId: doc._id });

  // Delete the document record
  await RagDocument.deleteOne({ _id: doc._id });
}
