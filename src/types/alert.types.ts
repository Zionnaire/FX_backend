// src/types/alert.types.ts

import { Types } from 'mongoose';
import { ValidTimeframe } from './chart.types';

export interface IAlert {
  _id?: Types.ObjectId;
  userId: Types.ObjectId;
  pair: 'XAU/USD' | 'GBP/USD' | 'EUR/USD' | 'USD/JPY';
  condition:
    | 'price_above'
    | 'price_below'
    | 'rsi_above'
    | 'rsi_below'
    | 'ai_signal_buy'
    | 'ai_signal_sell'
    | 'pattern_detected';
  targetValue?: number;
  targetPattern?: string;
  timeframe?: ValidTimeframe;  // which candle chart to watch (pattern/RSI/signal alerts)
  type: 'buy' | 'sell' | 'info';
  enabled: boolean;
  triggered: boolean;
  triggeredAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}