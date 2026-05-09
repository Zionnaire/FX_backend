// src/types/signal.types.ts

import { Types } from 'mongoose';
import { ValidPair, ValidTimeframe } from './chart.types';

export type SessionRating = 'PRIME' | 'ACTIVE' | 'AVOID';
export type EntryType     = 'MARKET' | 'LIMIT';

export interface ISignal {
  _id?:                   Types.ObjectId;
  userId:                 Types.ObjectId;
  pair:                   ValidPair;
  timeframe:              ValidTimeframe;
  signal:                 'BUY' | 'SELL' | 'HOLD';
  confidence:             number;
  bullScore:              number;
  bearScore:              number;
  reasoning:              string;
  entry:                  number;
  takeProfit:             number;
  stopLoss:               number;
  riskReward:             string;
  keyRisks:               string[];
  timeHorizon:            string;
  indicators:             Record<string, unknown>;
  patterns:               string[];
  autoTradeRecommended?:  boolean;
  // ── New quality fields ────────────────────────────────────────────────────
  confluenceScore?:       number;      // 0–8: how many checks passed
  entryType?:             EntryType;   // MARKET or LIMIT
  sessionRating?:         SessionRating;
  pipsToSL?:              number;      // pip distance entry → SL
  pipsToTP?:              number;      // pip distance entry → TP
  invalidatesAt?:         Date;        // when this signal loses validity
  htfBias?:               string;      // "4H BEARISH | Daily BEARISH" summary
  createdAt?:             Date;
  updatedAt?:             Date;
}

export interface SignalPayload {
  pair:          ValidPair;
  timeframe:     ValidTimeframe;
  price:         number;
  rsi:           number;
  macd: {
    value:     number;
    signal:    number;
    histogram: number;
  };
  ema20:         number;
  ema50:         number;
  ema200:        number;
  bb: {
    upper: number;
    mid:   number;
    lower: number;
  };
  stoch: {
    k: number;
    d: number;
  };
  adx:             number;
  atr:             number;
  patterns:        string[];
  newsSentiment:   string;
  ragContext:       string;
  accuracyContext:  string;
  session:          string;
  sessionRating:    SessionRating;
  higherTfTrend:    string;   // 4H context
  dailyTrend:       string;   // Daily context
  tradingContext?:  string;
}

export interface SignalResult {
  signal:                'BUY' | 'SELL' | 'HOLD';
  confidence:            number;
  bullScore:             number;
  bearScore:             number;
  reasoning:             string;
  entry:                 number;
  takeProfit:            number;
  stopLoss:              number;
  riskReward:            string;
  keyRisks:              string[];
  timeHorizon:           string;
  autoTradeRecommended:  boolean;
  confluenceScore:       number;
  entryType:             EntryType;
}
