// src/models/Signal.model.ts

import mongoose, { Schema } from 'mongoose';
import { ISignal } from '../types/signal.types';
import { VALID_PAIRS, VALID_TIMEFRAMES } from '../types/chart.types';

const signalSchema = new Schema<ISignal>(
  {
    userId: {
      type:     Schema.Types.ObjectId,  // was String
      ref:      'User',
      required: true,
      index:    true,
    },
    pair: {
      type:     String,
      enum:     VALID_PAIRS,            // was unvalidated string
      required: true,
    },
    timeframe: {
      type:     String,
      enum:     VALID_TIMEFRAMES,       // was unvalidated string
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
  },
  { timestamps: true }
);

// TTL — documents auto-deleted after 5 minutes
signalSchema.index({ createdAt: 1 }, { expireAfterSeconds: 300 });

// Cache lookup index — used by signal.service on every request
signalSchema.index({ userId: 1, pair: 1, timeframe: 1, createdAt: -1 });

// History endpoint index
signalSchema.index({ userId: 1, pair: 1, createdAt: -1 });

export default mongoose.model<ISignal>('Signal', signalSchema);