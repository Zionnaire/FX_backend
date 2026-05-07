// src/types/alert.types.ts

import { Types } from 'mongoose';

export interface IAlert {
  _id?: Types.ObjectId;        // was string — _id is always ObjectId in Mongoose,
                               // string causes type mismatches in findById queries

  userId: Types.ObjectId;      // was string — must match Schema.Types.ObjectId
                               // in the model, otherwise userId comparisons in
                               // queries silently return no results

  pair: 'XAU/USD' | 'GBP/USD' | 'EUR/USD' | 'USD/JPY';
                               // was loose string — typos like "XAUUSD" now caught
                               // at compile time, not silently saved to DB

  condition:
    | 'price_above'
    | 'price_below'
    | 'rsi_above'
    | 'rsi_below'
    | 'ai_signal_buy'
    | 'ai_signal_sell'
    | 'pattern_detected';      // this was correct — kept as-is

  targetValue?: number;        // was required (no ?) — pattern_detected alerts
                               // don't use a target value so this must be optional
                               // Model enforces it conditionally via required fn

  targetPattern?: string;      // correct — kept as-is

  type: 'buy' | 'sell' | 'info';  // correct — kept as-is

  enabled: boolean;            // correct — kept as-is
  triggered: boolean;          // correct — kept as-is

  triggeredAt?: Date | null;   // added null — Mongoose sets this to null initially,
                               // Date | undefined alone causes a type error when
                               // reading a freshly created alert document

  createdAt?: Date;            // correct — kept as-is
  updatedAt?: Date;            // correct — kept as-is
}