// src/services/autoIngest.service.ts
// Automatically feeds trade reviews and economic calendar events into the RAG
// knowledge base so the AI learns without any manual user input.

import axios from 'axios';
import { Types } from 'mongoose';
import RagDocument from '../models/RagDocument.model';
import RagEmbedding from '../models/RagEmbedding.model';
import { generateBatchEmbeddings } from './embedding.service';
import { chunkText } from './rag.service';
import { ITrade } from '../types/trade.types';
import { TRADING_KNOWLEDGE_LIBRARY } from '../data/tradingKnowledge';

// ─── Ingest a closed trade review into the knowledge base ─────────────────────
// Called after auto-review completes so every closed trade with an AI verdict
// gets indexed — no user action needed.

export async function ingestTradeReview(
  userId: string,
  trade: ITrade & { _id: any },
): Promise<void> {
  if (!trade.aiReview?.verdict) return;

  const { pair, type, entry, exit, pnl, status, stopLoss, takeProfit, rr } = trade;
  const {
    verdict,
    entryQuality,
    exitQuality,
    riskManagement,
    lessonsLearned = [],
    suggestions = '',
  } = trade.aiReview;

  const avgScore = Math.round((entryQuality + exitQuality + riskManagement) / 3);

  const text = [
    `TRADE REVIEW — ${pair} ${type}`,
    `Date: ${new Date(trade.createdAt as any).toISOString().slice(0, 10)}`,
    `Entry: ${entry} | Exit: ${exit ?? 'open'} | SL: ${stopLoss ?? 'n/a'} | TP: ${takeProfit ?? 'n/a'}`,
    `P&L: ${pnl != null ? `$${pnl.toFixed(2)}` : 'n/a'} | R:R: ${rr ?? 'n/a'} | Outcome: ${status?.toUpperCase()}`,
    `AI Verdict: ${verdict} (avg score: ${avgScore}/10)`,
    `Entry quality: ${entryQuality}/10 | Exit quality: ${exitQuality}/10 | Risk management: ${riskManagement}/10`,
    lessonsLearned.length ? `Lessons learned: ${lessonsLearned.join('; ')}` : '',
    suggestions ? `Suggestions: ${suggestions}` : '',
  ].filter(Boolean).join('\n');

  await _indexText(userId, text, 'rule', pair, `trade-review-${trade._id}`);
}

// ─── Ingest economic calendar from ForexFactory public JSON ───────────────────
// ForexFactory exposes this endpoint openly — no key required.
// Returns current-week events. We re-run this daily; stale docs are auto-pruned.

export async function ingestEconomicCalendar(userId: string): Promise<number> {
  const url = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
  const res  = await axios.get<ForexFactoryEvent[]>(url, { timeout: 10_000 });
  const events: ForexFactoryEvent[] = res.data ?? [];

  // Only high-impact events are worth indexing
  const highImpact = events.filter((e) => e.impact === 'High');
  if (highImpact.length === 0) return 0;

  // Delete stale calendar docs for this user before re-indexing
  const old = await RagDocument.find({
    userId: new Types.ObjectId(userId),
    type: 'rule',
    'metadata.source': 'economic_calendar',
  }).select('_id').lean();

  if (old.length > 0) {
    const ids = old.map((d) => d._id);
    await Promise.all([
      RagEmbedding.deleteMany({ documentId: { $in: ids } }),
      RagDocument.deleteMany({ _id: { $in: ids } }),
    ]);
  }

  const lines = highImpact.map((e) =>
    `${e.date} ${e.time || ''} — ${e.currency} — ${e.title}` +
    (e.forecast ? ` | Forecast: ${e.forecast}` : '') +
    (e.previous ? ` | Previous: ${e.previous}` : ''),
  );

  const text = [
    `ECONOMIC CALENDAR — HIGH IMPACT EVENTS (week of ${new Date().toISOString().slice(0, 10)})`,
    ...lines,
    '',
    'Trading note: Avoid opening new positions within 15-30 minutes of high-impact events.',
    'Strongly volatile pairs around each event: watch for spread widening and stop hunts.',
  ].join('\n');

  await _indexText(userId, text, 'rule', 'ALL', 'economic-calendar-thisweek', {
    source: 'economic_calendar',
  });

  return highImpact.length;
}

// ─── Get auto-feed document list ──────────────────────────────────────────────

export async function getAutoFeedDocs(userId: string) {
  return RagDocument.find({
    userId: new Types.ObjectId(userId),
    'metadata.autoIngested': true,
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .select('fileName type metadata status chunkCount createdAt')
    .lean();
}

// ─── Internal helper ──────────────────────────────────────────────────────────

async function _indexText(
  userId: string,
  text: string,
  type: string,
  pair: string,
  tag: string,
  extraMeta: Record<string, unknown> = {},
): Promise<void> {
  const chunks = chunkText(text, 300, 30);
  if (chunks.length === 0) return;

  const fileName = `auto-${tag}-${Date.now()}.txt`;

  const doc = await RagDocument.create({
    userId:    new Types.ObjectId(userId),
    fileName,
    fileUrl:   `auto:${tag}`,
    cloudinaryId: `auto:${tag}`,
    mimetype:  'text/plain',
    chunkCount: chunks.length,
    status:    'processing',
    type,
    metadata:  { pair, autoIngested: true, tag, ...extraMeta },
  });

  try {
    const embeddings = await generateBatchEmbeddings(chunks);
    await RagEmbedding.insertMany(
      chunks.map((chunk, idx) => ({
        userId:     new Types.ObjectId(userId),
        documentId: doc._id,
        chunkText:  chunk,
        chunkIndex: idx,
        embedding:  embeddings[idx],
      })),
      { ordered: false },
    );
    doc.status = 'indexed';
  } catch {
    doc.status = 'error';
  }

  await doc.save();
}

// ─── Seed Default Knowledge Library ──────────────────────────────────────────
// Ingests the 12-document trading strategy library into a user's knowledge base.
// Idempotent: checks for existing seeded documents and skips already-indexed ones.

export interface SeedResult {
  seeded: number;
  skipped: number;
  errors: number;
}

export async function seedDefaultKnowledge(userId: string): Promise<SeedResult> {
  const result: SeedResult = { seeded: 0, skipped: 0, errors: 0 };

  // Find all already-seeded tags for this user in one query
  const existing = await RagDocument.find({
    userId: new Types.ObjectId(userId),
    'metadata.seeded': true,
  }).select('metadata').lean();

  const existingTags = new Set(
    existing.map((d: any) => d.metadata?.tag as string).filter(Boolean)
  );

  for (const doc of TRADING_KNOWLEDGE_LIBRARY) {
    if (existingTags.has(doc.tag)) {
      result.skipped++;
      continue;
    }
    try {
      await _indexText(userId, doc.text, 'rule', doc.pair, doc.tag, {
        seeded: true,
        title: doc.title,
      });
      result.seeded++;
    } catch {
      result.errors++;
    }
  }

  return result;
}

// ─── Get seeded knowledge docs ────────────────────────────────────────────────

export async function getSeededDocs(userId: string) {
  return RagDocument.find({
    userId: new Types.ObjectId(userId),
    'metadata.seeded': true,
  })
    .sort({ createdAt: 1 })
    .select('fileName type metadata status chunkCount createdAt')
    .lean();
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ForexFactoryEvent {
  title:    string;
  country:  string;
  date:     string;
  time?:    string;
  impact:   'High' | 'Medium' | 'Low' | 'Holiday' | 'Non-Economic';
  currency: string;
  forecast?: string;
  previous?: string;
  actual?:  string;
}
