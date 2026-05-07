// src/models/Trade.model.ts

import mongoose, { Schema } from 'mongoose';
import { ITrade } from '../types/trade.types';
import { VALID_PAIRS } from '../types/chart.types';

const tradeSchema = new Schema<ITrade>(
  {
    userId: {
      type:     Schema.Types.ObjectId,   // was String
      ref:      'User',
      required: true,
      index:    true,
    },
    pair: {
      type:     String,
      enum:     VALID_PAIRS,             // was unvalidated string
      required: true,
    },
    type: {
      type:     String,
      enum:     ['BUY', 'SELL'],
      required: true,
    },
    entry: {
      type:     Number,
      required: true,
      min:      0,
    },
    exit: {
      type: Number,
      min:  0,
    },
    stopLoss: {
      type: Number,
      min:  0,
    },
    takeProfit: {
      type: Number,
      min:  0,
    },
    size: {
      type:     Number,
      required: true,
      min:      0,
    },
    pnl:      Number,
    rr:       String,                    // was Number — stored as "1:2.4"
    status: {
      type:    String,
      enum:    ['open', 'win', 'loss'],
      default: 'open',
      index:   true,                     // analytics queries filter by status
    },
    duration: String,                    // was Number — stored as "2h 30m"
    notes:    String,
    aiSignalId: {
      type: Schema.Types.ObjectId,
      ref:  'Signal',
    },
    source: {
      type:    String,
      enum:    ['manual', 'ai_auto'],
      default: 'manual',
    },
    aiReview: {
      verdict: {
        type: String,
        enum: ['good', 'poor', 'acceptable'],
      },
      entryQuality:   Number,
      exitQuality:    Number,
      riskManagement: Number,
      lessonsLearned: [String],          // was String — Groq returns array
      suggestions:    String,
    },
  },
  { timestamps: true }
);

// Analytics queries — getStats filters by userId + status
tradeSchema.index({ userId: 1, status: 1 });

// Journal listing — sorted by date, filtered by pair
tradeSchema.index({ userId: 1, pair: 1, createdAt: -1 });

// P&L curve — sorted chronologically per user
tradeSchema.index({ userId: 1, createdAt: 1 });

export default mongoose.model<ITrade>('Trade', tradeSchema);