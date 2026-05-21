// src/models/Signal.model.ts

import mongoose, { Schema } from 'mongoose';
import { ISignal } from '../types/signal.types';
import { VALID_PAIRS, VALID_TIMEFRAMES } from '../types/chart.types';

const signalSchema = new Schema<ISignal>(
  {
    userId: {
      type:     Schema.Types.ObjectId,
      ref:      'User',
      required: true,
      index:    true,
    },
    pair: {
      type:     String,
      enum:     VALID_PAIRS,
      required: true,
    },
    timeframe: {
      type:     String,
      enum:     VALID_TIMEFRAMES,
      required: true,
    },
    signal: {
      type:     String,
      enum:     ['BUY', 'SELL', 'HOLD'],
      required: true,
    },
    confidence:  { type: Number, min: 0, max: 100 },
    bullScore:   { type: Number, min: 0, max: 100 },
    bearScore:   { type: Number, min: 0, max: 100 },
    reasoning:   String,
    entry:       { type: Number, min: 0 },
    takeProfit:  { type: Number, min: 0 },
    stopLoss:    { type: Number, min: 0 },
    riskReward:  String,
    keyRisks:    [String],
    timeHorizon: String,
    indicators:             Schema.Types.Mixed,
    patterns:               [String],
    autoTradeRecommended:   { type: Boolean, default: false },
    // ── Quality fields ────────────────────────────────────────────────────────
    confluenceScore:  { type: Number, min: 0, max: 8 },
    entryType:        { type: String, enum: ['MARKET', 'LIMIT'] },
    sessionRating:    { type: String, enum: ['PRIME', 'ACTIVE', 'AVOID'] },
    pipsToSL:         { type: Number, min: 0 },
    pipsToTP:         { type: Number, min: 0 },
    invalidatesAt:    Date,
    htfBias:          String,
    weeklyTrend:      String,
    qualityTier:      { type: String, enum: ['A+', 'A', 'B', 'C'] },
  },
  { timestamps: true }
);

// TTL — 48 hours keeps signals for the history page and accuracy evaluation window
signalSchema.index({ createdAt: 1 }, { expireAfterSeconds: 172_800 });

// Cache lookup index
signalSchema.index({ userId: 1, pair: 1, timeframe: 1, createdAt: -1 });

// History endpoint index
signalSchema.index({ userId: 1, pair: 1, createdAt: -1 });

export default mongoose.model<ISignal>('Signal', signalSchema);
