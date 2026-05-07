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
  createdAt?: Date;
  updatedAt?: Date;
}
