// src/types/chart.types.ts

export interface IOHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ISupportLevel {
  price: number;
  type: 'support' | 'resistance';
  strength: number;
}

export interface IFibLevel {
  label: string;
  value: number;
  percent: number;
}

export const VALID_PAIRS = ['XAU/USD', 'GBP/USD', 'EUR/USD', 'USD/JPY'] as const;
export type ValidPair = typeof VALID_PAIRS[number];

export const VALID_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type ValidTimeframe = typeof VALID_TIMEFRAMES[number];