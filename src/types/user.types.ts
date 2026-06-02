// src/types/user.types.ts

import { Types } from 'mongoose';

export interface IAutoTradeSettings {
  enabled:         boolean;
  mt5ApiKey?:      string;      // UUID key the EA uses in X-MT5-ApiKey header
  defaultRiskPct:  number;      // % of balance risked per trade (default 1)
  maxDailyLossPct: number;      // stop trading if day loss > this % (default 5)
  maxDailyTrades:  number;      // max auto-executions per day (default 3)
  minConfluence:   number;      // minimum confluenceScore required (default 5)
  minConfidence:   number;      // minimum AI confidence required (default 65)
  eaLastPollAt?:   Date;        // updated each time EA contacts backend
}

export interface IUser {
  _id?: Types.ObjectId;
  email: string;
  password: string;
  name: string;
  role: 'user' | 'admin';
  refreshToken?: string | null;
  simulationBalance: number;
  preferences: {
    defaultPair: 'XAU/USD' | 'GBP/USD' | 'EUR/USD' | 'USD/JPY';
    defaultTimeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
    riskPercent: number;
  };
  autoTrade?: IAutoTradeSettings;
  telegram?: {
    chat_id:             string | null;
    enabled:             boolean;
    on_signal:           boolean;
    on_auto_trade:       boolean;
    on_alert:            boolean;
    on_daily_briefing:   boolean;
    on_circuit_breaker:  boolean;
  };
  createdAt?: Date;
  updatedAt?: Date;
}