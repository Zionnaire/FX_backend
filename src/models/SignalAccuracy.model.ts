// Tracks whether each generated signal was correct after its time horizon passed.
// Populated by the accuracy checker that runs on a schedule.

import mongoose, { Schema, Document } from 'mongoose';
import { VALID_PAIRS, VALID_TIMEFRAMES } from '../types/chart.types';

export interface ISignalAccuracy extends Document {
  userId:          mongoose.Types.ObjectId;
  signalId:        mongoose.Types.ObjectId;
  pair:            string;
  timeframe:       string;
  predictedSignal: 'BUY' | 'SELL' | 'HOLD';
  confidence:      number;
  entryPrice:      number;
  checkPrice:      number;
  pipMove:         number;
  wasCorrect:      boolean;
  outcome:         'tp_hit' | 'sl_hit' | 'moved_correct' | 'moved_wrong' | 'flat';
  patterns:        string[];  // candlestick patterns active at signal time
  checkedAt:       Date;
}

const schema = new Schema<ISignalAccuracy>(
  {
    userId:          { type: Schema.Types.ObjectId, ref: 'User',   required: true, index: true },
    signalId:        { type: Schema.Types.ObjectId, ref: 'Signal', required: true },
    pair:            { type: String, enum: VALID_PAIRS,      required: true },
    timeframe:       { type: String, enum: VALID_TIMEFRAMES, required: true },
    predictedSignal: { type: String, enum: ['BUY', 'SELL', 'HOLD'], required: true },
    confidence:      { type: Number, min: 0, max: 100 },
    entryPrice:      { type: Number, required: true },
    checkPrice:      { type: Number, required: true },
    pipMove:         { type: Number, required: true },
    wasCorrect:      { type: Boolean, required: true },
    outcome:         { type: String, enum: ['tp_hit', 'sl_hit', 'moved_correct', 'moved_wrong', 'flat'] },
    patterns:        { type: [String], default: [] },
    checkedAt:       { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Fast lookups for accuracy stats per user/pair/timeframe
schema.index({ userId: 1, pair: 1, timeframe: 1, checkedAt: -1 });
schema.index({ userId: 1, checkedAt: -1 });

export default mongoose.model<ISignalAccuracy>('SignalAccuracy', schema);
