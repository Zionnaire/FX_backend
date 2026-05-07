// src/types/news.types.ts

import { Types } from "mongoose";
import { ValidPair } from "./chart.types";

export interface INewsItem {
  headline: string;
  sentiment: "bull" | "bear" | "neut";
  impact: "high" | "med" | "low";
  score: number; // -1.0 to 1.0
  reasoning: string;
  source: string;
  publishedAt: Date;
  pairs: ValidPair[]; // typed pair array, not loose string[]
}

export interface IEconomicEvent {
  time: string;
  title: string;
  country: string;
  impact: "high" | "med" | "low";
}

export interface INewsCache {
  _id?: Types.ObjectId; // was string
  key: string;
  data: INewsItem[] | unknown; // was any
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
