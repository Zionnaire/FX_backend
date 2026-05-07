// All indicators use Wilder's smoothing where specified (standard for RSI/ATR/ADX).
// MACD signal line is a true EMA(9) of the MACD line values, not of closes.
// Stochastic %D is a proper SMA(3) of the last three %K values.
// ADX uses full two-pass Wilder smoothing: TR/DM smooth → DX → ADX smooth.

export function sma(values: number[], period: number): number {
  if (values.length < period) return 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number {
  if (values.length < period) return 0;
  const k = 2 / (period + 1);
  let val = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    val = values[i] * k + val * (1 - k);
  }
  return val;
}

export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

  let avgGain = 0;
  let avgLoss = 0;

  // Seed: SMA of first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing for remaining bars
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) {
    return { value: 0, signal: 0, histogram: 0 };
  }

  const kf = 2 / (fast + 1);
  const ks = 2 / (slow + 1);
  const kg = 2 / (signalPeriod + 1);

  // Seed fast EMA from first `fast` bars, then advance it to align with slow seed
  let emaFast = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  for (let i = fast; i < slow; i++) {
    emaFast = closes[i] * kf + emaFast * (1 - kf);
  }

  // Seed slow EMA from first `slow` bars
  let emaSlow = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;

  // Build MACD line — first value at index slow-1 (seeded values), then rolling
  const macdLine: number[] = [emaFast - emaSlow];
  for (let i = slow; i < closes.length; i++) {
    emaFast = closes[i] * kf + emaFast * (1 - kf);
    emaSlow = closes[i] * ks + emaSlow * (1 - ks);
    macdLine.push(emaFast - emaSlow);
  }

  if (macdLine.length < signalPeriod) {
    return { value: macdLine[macdLine.length - 1], signal: 0, histogram: 0 };
  }

  // Signal = EMA(signalPeriod) of MACD line — seeded from first `signalPeriod` values
  let sigEma = macdLine.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
  for (let i = signalPeriod; i < macdLine.length; i++) {
    sigEma = macdLine[i] * kg + sigEma * (1 - kg);
  }

  const lastMacd = macdLine[macdLine.length - 1];
  return {
    value:     Math.round(lastMacd * 1e6) / 1e6,
    signal:    Math.round(sigEma  * 1e6) / 1e6,
    histogram: Math.round((lastMacd - sigEma) * 1e6) / 1e6,
  };
}

export function bollingerBands(closes: number[], period = 20, mult = 2) {
  if (closes.length < period) return { upper: 0, mid: 0, lower: 0 };

  const mid = sma(closes, period);
  const slice = closes.slice(-period);
  const variance = slice.reduce((sum, v) => sum + (v - mid) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: Math.round((mid + mult * stdDev) * 1e5) / 1e5,
    mid:   Math.round(mid * 1e5) / 1e5,
    lower: Math.round((mid - mult * stdDev) * 1e5) / 1e5,
  };
}

export function stochastic(
  candles: Array<{ high: number; low: number; close: number }>,
  kPeriod = 14,
  dPeriod = 3,
) {
  if (candles.length < kPeriod + dPeriod - 1) return { k: 50, d: 50 };

  // Compute %K for each of the last `dPeriod` bars so we can SMA them into %D
  const kValues: number[] = [];
  for (let bar = candles.length - dPeriod; bar < candles.length; bar++) {
    const window = candles.slice(bar - kPeriod + 1, bar + 1);
    const highest = Math.max(...window.map((c) => c.high));
    const lowest  = Math.min(...window.map((c) => c.low));
    const range   = highest - lowest;
    kValues.push(range === 0 ? 50 : ((candles[bar].close - lowest) / range) * 100);
  }

  const k = kValues[kValues.length - 1];
  const d = kValues.reduce((a, b) => a + b, 0) / kValues.length; // SMA(dPeriod) of %K

  return {
    k: Math.round(k * 100) / 100,
    d: Math.round(d * 100) / 100,
  };
}

export function atr(
  candles: Array<{ high: number; low: number; close: number }>,
  period = 14,
): number {
  if (candles.length < period + 1) return 0;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }

  // Wilder's smoothing — same method used internally by ADX
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    val = (val * (period - 1) + trs[i]) / period;
  }

  return Math.round(val * 1e6) / 1e6;
}

export function adx(
  candles: Array<{ high: number; low: number; close: number }>,
  period = 14,
): number {
  // Need at least 2×period + 1 bars: period bars to seed TR/DM, then period more for ADX seed
  if (candles.length < period * 2 + 1) return 25;

  // Pass 1: raw TR, +DM, -DM per bar
  const trs:      number[] = [];
  const plusDMs:  number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const cur  = candles[i];
    const prev = candles[i - 1];

    const upMove   = cur.high - prev.high;
    const downMove = prev.low - cur.low;

    trs.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low  - prev.close),
    ));
    plusDMs.push(upMove   > downMove && upMove   > 0 ? upMove   : 0);
    minusDMs.push(downMove > upMove  && downMove > 0 ? downMove : 0);
  }

  // Pass 2: Wilder-smooth TR, +DM, -DM — seed with sum of first `period` values
  let sTR  = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

  // Collect DX values starting from first smoothed point
  const dxValues: number[] = [];

  const pushDX = () => {
    if (sTR === 0) { dxValues.push(0); return; }
    const pDI = (sPDM / sTR) * 100;
    const mDI = (sMDM / sTR) * 100;
    const sum = pDI + mDI;
    dxValues.push(sum === 0 ? 0 : (Math.abs(pDI - mDI) / sum) * 100);
  };

  pushDX(); // first DX from seeded values

  for (let i = period; i < trs.length; i++) {
    sTR  = sTR  - sTR  / period + trs[i];
    sPDM = sPDM - sPDM / period + plusDMs[i];
    sMDM = sMDM - sMDM / period + minusDMs[i];
    pushDX();
  }

  if (dxValues.length < period) return 25;

  // Pass 3: Wilder-smooth DX → ADX
  let adxVal = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adxVal = (adxVal * (period - 1) + dxValues[i]) / period;
  }

  return Math.round(adxVal * 100) / 100;
}
