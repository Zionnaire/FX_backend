// src/types/user.types.ts

import { Types } from 'mongoose';

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
  createdAt?: Date;
  updatedAt?: Date;
}