import { IOHLCV } from '../types/chart.types';
import * as indicators from '../utils/indicators.utils';

export interface Indicators {
  sma20: number;
  sma50: number;
  ema20: number;
  ema50: number;
  ema200?: number;
  rsi: number;
  macd: {
    value: number;
    signal: number;
    histogram: number;
  };
  bb: {
    upper: number;
    mid: number;
    lower: number;
  };
  stoch: {
    k: number;
    d: number;
  };
  adx: number;
  atr: number;
  patterns: string[];
}

export function computeAll(candles: IOHLCV[]): Indicators {
  if (candles.length < 50) {
    return {
      sma20: 0,
      sma50: 0,
      ema20: 0,
      ema50: 0,
      rsi: 50,
      macd: { value: 0, signal: 0, histogram: 0 },
      bb: { upper: 0, mid: 0, lower: 0 },
      stoch: { k: 50, d: 50 },
      adx: 25,
      atr: 0,
      patterns: [],
    };
  }

  const closes = candles.map((c) => c.close);
  const patterns = detectPatterns(candles);

  return {
    sma20: indicators.sma(closes, 20),
    sma50: indicators.sma(closes, 50),
    ema20:  indicators.ema(closes, 20),
    ema50:  indicators.ema(closes, 50),
    ema200: candles.length >= 200 ? indicators.ema(closes, 200) : undefined,
    rsi: indicators.rsi(closes),
    macd: indicators.macd(closes),
    bb: indicators.bollingerBands(closes),
    stoch: indicators.stochastic(candles),
    adx: indicators.adx(candles),
    atr: indicators.atr(candles),
    patterns,
  };
}

export function detectPatterns(candles: IOHLCV[]): string[] {
  if (candles.length < 3) return [];

  const patterns: string[] = [];
  const last3 = candles.slice(-3);
  const [prev2, prev, curr] = last3;

  // Bullish Engulfing
  const prevBearish = prev.close < prev.open;
  const currBullish = curr.close > curr.open;
  if (prevBearish && currBullish && curr.close > prev.open && curr.open < prev.close) {
    patterns.push('Bullish Engulfing');
  }

  // Bearish Engulfing
  const prevBull = prev.close > prev.open;
  const currBear = curr.close < curr.open;
  if (prevBull && currBear && curr.close < prev.open && curr.open > prev.close) {
    patterns.push('Bearish Engulfing');
  }

  // Hammer
  const currBody = Math.abs(curr.close - curr.open);
  const currLowerWick = Math.min(curr.open, curr.close) - curr.low;
  const currUpperWick = curr.high - Math.max(curr.open, curr.close);
  if (currLowerWick > 2 * currBody && currUpperWick < 0.3 * currBody) {
    patterns.push('Hammer');
  }

  // Shooting Star (inverse hammer on bearish candle)
  if (curr.close < curr.open && currUpperWick > 2 * currBody && currLowerWick < 0.3 * currBody) {
    patterns.push('Shooting Star');
  }

  // Doji
  if (Math.abs(curr.close - curr.open) < (curr.high - curr.low) * 0.1) {
    patterns.push('Doji');
  }

  return patterns;
}
