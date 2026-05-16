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
  const n = candles.length;
  const last3 = candles.slice(-3);
  const [, prev, curr] = last3;

  // ── Two-candle / single-candle patterns ──────────────────────────────────

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

  // Shooting Star
  if (curr.close < curr.open && currUpperWick > 2 * currBody && currLowerWick < 0.3 * currBody) {
    patterns.push('Shooting Star');
  }

  // Doji
  if (Math.abs(curr.close - curr.open) < (curr.high - curr.low) * 0.1) {
    patterns.push('Doji');
  }

  // ── Caginalp & Laurent (1998) three-day patterns ─────────────────────────
  // Trend context: compare first half vs second half of the 6 candles before the pattern
  const trendWindow = candles.slice(Math.max(0, n - 9), n - 3);
  const downtrend = trendWindow.length >= 3 &&
    trendWindow[trendWindow.length - 1].close < trendWindow[0].close;
  const uptrend = trendWindow.length >= 3 &&
    trendWindow[trendWindow.length - 1].close > trendWindow[0].close;

  const [d1, d2, d3] = last3;
  const d1Bull = d1.close > d1.open;
  const d1Bear = d1.close < d1.open;
  const d2Bull = d2.close > d2.open;
  const d2Bear = d2.close < d2.open;
  const d3Bull = d3.close > d3.open;
  const d3Bear = d3.close < d3.open;
  const d1Body = Math.abs(d1.close - d1.open);
  const d2Body = Math.abs(d2.close - d2.open);
  const d1Mid  = (d1.open + d1.close) / 2;

  // Three White Soldiers: downtrend + 3 white candles, each opens inside prev body, closes higher
  if (downtrend && d1Bull && d2Bull && d3Bull &&
      d2.open > d1.open && d2.open < d1.close &&
      d3.open > d2.open && d3.open < d2.close &&
      d2.close > d1.close && d3.close > d2.close) {
    patterns.push('Three White Soldiers');
  }

  // Three Black Crows: uptrend + 3 black candles, each opens inside prev body, closes lower
  if (uptrend && d1Bear && d2Bear && d3Bear &&
      d2.open < d1.open && d2.open > d1.close &&
      d3.open < d2.open && d3.open > d2.close &&
      d2.close < d1.close && d3.close < d2.close) {
    patterns.push('Three Black Crows');
  }

  // Three Inside Up: black d1, white d2 contained inside d1 (harami), d3 white closes above d1 open
  if (d1Bear && d2Bull &&
      d2.open >= d1.close && d2.close <= d1.open &&
      d3Bull && d3.close > d1.open) {
    patterns.push('Three Inside Up');
  }

  // Three Inside Down: white d1, black d2 contained inside d1 (harami), d3 black closes below d1 open
  if (d1Bull && d2Bear &&
      d2.open <= d1.close && d2.close >= d1.open &&
      d3Bear && d3.close < d1.open) {
    patterns.push('Three Inside Down');
  }

  // Three Outside Up: black d1, white d2 engulfs d1, d3 white continues higher
  if (d1Bear && d2Bull &&
      d2.open <= d1.close && d2.close >= d1.open &&
      d3Bull && d3.close > d2.close) {
    patterns.push('Three Outside Up');
  }

  // Three Outside Down: white d1, black d2 engulfs d1, d3 black continues lower
  if (d1Bull && d2Bear &&
      d2.open >= d1.close && d2.close <= d1.open &&
      d3Bear && d3.close < d2.close) {
    patterns.push('Three Outside Down');
  }

  // Morning Star: black large d1, small-body d2 (star), white d3 closes past d1 midpoint
  if (d1Bear && d2Body < d1Body * 0.3 && d3Bull && d3.close > d1Mid) {
    patterns.push('Morning Star');
  }

  // Evening Star: white large d1, small-body d2 (star), black d3 closes past d1 midpoint
  if (d1Bull && d2Body < d1Body * 0.3 && d3Bear && d3.close < d1Mid) {
    patterns.push('Evening Star');
  }

  return patterns;
}
