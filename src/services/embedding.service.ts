// src/services/embedding.service.ts

import axios, { AxiosError } from 'axios';
import env from '../config/env';

const JINA_API_URL  = 'https://api.jina.ai/v1/embeddings';
const JINA_MODEL    = 'jina-embeddings-v3';
const HF_API_URL    =
  'https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2';

export const JINA_DIMENSIONS = 768;
export const HF_DIMENSIONS   = 384;
export const EMBEDDING_DIMENSIONS = JINA_DIMENSIONS;  // default

// ─── Jina ─────────────────────────────────────────────────────────────────────

async function generateEmbeddingJina(
  text: string,
  task: 'retrieval.passage' | 'retrieval.query' = 'retrieval.passage'
): Promise<number[]> {
  const response = await axios.post(
    JINA_API_URL,
    {
      model: JINA_MODEL,
      input: [text.slice(0, 8000)],
      task,
    },
    {
      headers: {
        Authorization:  `Bearer ${env.jinaApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    }
  );

  const embedding = response.data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Jina returned empty or invalid embedding');
  }

  return embedding;
}

// ─── Jina Batch ───────────────────────────────────────────────────────────────

async function generateBatchEmbeddingsJina(texts: string[]): Promise<number[][]> {
  const response = await axios.post(
    JINA_API_URL,
    {
      model: JINA_MODEL,
      input: texts.map((t) => t.slice(0, 8000)),
      task:  'retrieval.passage',
    },
    {
      headers: {
        Authorization:  `Bearer ${env.jinaApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    }
  );

  const data = response.data?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error('Jina batch returned unexpected shape');
  }

  return data.map((item: { embedding: number[] }) => item.embedding);
}

// ─── HuggingFace ──────────────────────────────────────────────────────────────

async function generateEmbeddingHuggingFace(text: string): Promise<number[]> {
  if (!env.huggingfaceApiKey) {
    throw new Error('HuggingFace API key not configured');
  }

  const response = await axios.post(
    HF_API_URL,
    {
      inputs:  text.slice(0, 4000),
      options: { wait_for_model: true },
    },
    {
      headers: { Authorization: `Bearer ${env.huggingfaceApiKey}` },
      timeout: 20_000,
    }
  );

  const data = response.data;

  // HF returns either number[][] (token embeddings) or number[] (pooled)
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('HuggingFace returned empty response');
  }

  // Nested array — apply mean pooling across token dimension
  if (Array.isArray(data[0])) {
    const tokenEmbeddings = data as number[][];
    const dims = tokenEmbeddings[0].length;
    return Array.from({ length: dims }, (_, i) =>
      tokenEmbeddings.reduce((sum, row) => sum + row[i], 0) / tokenEmbeddings.length
    );
  }

  // Already pooled
  return data as number[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateEmbedding(
  text: string,
  isQuery = false
): Promise<number[]> {
  const task = isQuery ? 'retrieval.query' : 'retrieval.passage';

  try {
    return await generateEmbeddingJina(text, task);
  } catch (err) {
    const msg = err instanceof AxiosError ? err.message : String(err);
    console.warn(`Jina embedding failed (${msg}), falling back to HuggingFace`);

    return await generateEmbeddingHuggingFace(text);
    // If HF also fails it throws — caller handles it
  }
}

export async function generateBatchEmbeddings(
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];

  try {
    return await generateBatchEmbeddingsJina(texts);
  } catch (err) {
    const msg = err instanceof AxiosError ? err.message : String(err);
    console.warn(`Jina batch failed (${msg}), falling back to sequential HuggingFace`);

    const results: number[][] = [];

    for (const text of texts) {
      try {
        results.push(await generateEmbeddingHuggingFace(text));
      } catch {
        // Push zero vector so chunk count stays aligned with text array
        // Caller should check for zero vectors if accuracy is critical
        console.error(`Failed to embed chunk — inserting zero vector`);
        results.push(new Array(HF_DIMENSIONS).fill(0));
      }
    }

    return results;
  }
}