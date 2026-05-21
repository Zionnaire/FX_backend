// Stores trades queued for MT5 execution.
// Status flow:
//   PENDING_APPROVAL → user confirms (or 60s elapses) → APPROVED
//                    → user cancels                   → REJECTED
//                    → 60s elapses, frontend not open → EXPIRED
//   APPROVED → EA picks up → EXECUTING → EA confirms → EXECUTED
//                                      → EA fails    → FAILED

import mongoose, { Schema, Document, Types } from 'mongoose';
import { VALID_PAIRS } from '../types/chart.types';

export interface IPendingExecution extends Document {
  userId:          Types.ObjectId;
  signalId:        Types.ObjectId;
  pair:            string;
  direction:       'BUY' | 'SELL';
  entry:           number;
  stopLoss:        number;
  takeProfit:      number;
  lots:            number;
  riskPct:         number;
  riskReward:      string;
  pipsToSL:        number;
  pipsToTP:        number;
  confluenceScore: number;
  confidence:      number;
  reasoning:       string;
  entryType:       'MARKET' | 'LIMIT';
  status:          'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXECUTING' | 'EXECUTED' | 'FAILED' | 'EXPIRED';
  mt5Ticket?:      number;
  fillPrice?:      number;
  fillTime?:       Date;
  failReason?:     string;
  approvalExpiresAt: Date;
  approvedAt?:     Date;
  rejectedAt?:     Date;
  createdAt?:      Date;
  updatedAt?:      Date;
}

const schema = new Schema<IPendingExecution>(
  {
    userId:          { type: Schema.Types.ObjectId, ref: 'User',   required: true, index: true },
    signalId:        { type: Schema.Types.ObjectId, ref: 'Signal', required: true },
    pair:            { type: String, enum: VALID_PAIRS, required: true },
    direction:       { type: String, enum: ['BUY', 'SELL'], required: true },
    entry:           { type: Number, required: true },
    stopLoss:        { type: Number, required: true },
    takeProfit:      { type: Number, required: true },
    lots:            { type: Number, required: true, min: 0.01 },
    riskPct:         { type: Number, required: true },
    riskReward:      { type: String, default: '1:1' },
    pipsToSL:        { type: Number, default: 0 },
    pipsToTP:        { type: Number, default: 0 },
    confluenceScore: { type: Number, default: 0 },
    confidence:      { type: Number, default: 0 },
    reasoning:       { type: String, default: '' },
    entryType:       { type: String, enum: ['MARKET', 'LIMIT'], default: 'MARKET' },
    status: {
      type:    String,
      enum:    ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'EXECUTED', 'FAILED', 'EXPIRED'],
      default: 'PENDING_APPROVAL',
      index:   true,
    },
    mt5Ticket:        { type: Number },
    fillPrice:        { type: Number },
    fillTime:         { type: Date },
    failReason:       { type: String },
    approvalExpiresAt: { type: Date, required: true },
    approvedAt:       { type: Date },
    rejectedAt:       { type: Date },
  },
  { timestamps: true },
);

// EA queries for APPROVED by apiKey (via userId lookup); frontend queries by userId
schema.index({ userId: 1, status: 1, createdAt: -1 });

export default mongoose.model<IPendingExecution>('PendingExecution', schema);
