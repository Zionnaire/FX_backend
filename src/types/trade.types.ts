// src/types/trade.types.ts

import { Types } from "mongoose";
import { ValidPair } from "./chart.types";

export interface IAiReview {
  verdict: "good" | "poor" | "acceptable"; // was loose string
  entryQuality: number;
  exitQuality: number;
  riskManagement: number;
  lessonsLearned: string[]; // was string — Groq returns array
  suggestions: string;
}

export interface ITrade {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  pair: ValidPair;
  type: "BUY" | "SELL";
  entry: number;
  exit?: number;
  stopLoss?: number;
  takeProfit?: number;
  size: number;
  pnl?: number;
  rr?: string;
  status: "open" | "win" | "loss";
  duration?: string;
  notes?: string;
  aiSignalId?: Types.ObjectId;
  aiReview?: IAiReview;
  source?: 'manual' | 'ai_auto';
  // Partial TP
  tp1?: number | null;
  tp2?: number | null;
  tp1_hit?: boolean;
  tp2_hit?: boolean;
  tp1_hit_at?: Date | null;
  tp2_hit_at?: Date | null;
  partial_close_pct?: number;
  breakeven_after_tp1?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}
