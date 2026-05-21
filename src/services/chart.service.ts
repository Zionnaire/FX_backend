// src/services/chart.service.ts

import axios from 'axios';
import env from '../config/env';
import NewsCache from '../models/NewsCache.model';
import {
  IOHLCV,
  ISupportLevel,
  IFibLevel,
  VALID_PAIRS,
  VALID_TIMEFRAMES,
  ValidPair,
  ValidTimeframe,
} from '../types/chart.types';

// ─── Yahoo Finance symbol map ─────────────────────────────────────────────────

const YF_SYMBOL: Record<ValidPair, string> = {
  'XAU/USD': 'GC=F',       // Gold futures — XAUUSD=X is not available on Yahoo
  'GBP/USD': 'GBPUSD=X',
  'EUR/USD': 'EURUSD=X',
  'USD/JPY': 'USDJPY=X',
};

// Yahoo Finance interval + range for each timeframe
const YF_INTERVAL: Record<ValidTimeframe, string> = {
  '1m':  '1m',
  '5m':  '5m',
  '15m': '15m',
  '1h':  '60m',
  '4h':  '60m',   // fetch 1h, aggregate to 4h
  '1d':  '1d',
};

const YF_RANGE: Record<ValidTimeframe, string> = {
  '1m':  '7d',
  '5m':  '60d',
  '15m': '60d',
  '1h':  '1y',
  '4h':  '1y',
  '1d':  '2y',
};

// ─── Twelve Data interval map ─────────────────────────────────────────────────
// Twelve Data has native forex + spot gold — better than Yahoo Finance for XAU/USD

const TD_INTERVAL: Record<ValidTimeframe, string> = {
  '1m':  '1min',
  '5m':  '5min',
  '15m': '15min',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1day',
};

// ─── Alpha Vantage interval map ───────────────────────────────────────────────

const AV_INTERVAL: Record<string, string> = {
  '1m':  '1min',
  '5m':  '5min',
  '15m': '15min',
  '1h':  '60min',
  '4h':  '240min',
};

// ─── Cache TTLs ───────────────────────────────────────────────────────────────

function getCacheTtl(timeframe: string): number {
  if (['1m', '5m'].includes(timeframe))         return 60 * 1000;        // 1 min
  if (['15m', '1h'].includes(timeframe))         return 3 * 60 * 1000;   // 3 min
  if (timeframe === '4h')                        return 10 * 60 * 1000;  // 10 min
  return 60 * 60 * 1000;                                                  // 1 hr (daily)
}

// ─── Yahoo Finance fetcher ────────────────────────────────────────────────────

async function fetchFromYahoo(pair: ValidPair, timeframe: ValidTimeframe): Promise<IOHLCV[]> {
  const symbol   = YF_SYMBOL[pair];
  const interval = YF_INTERVAL[timeframe];
  const range    = YF_RANGE[timeframe];

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=false`;

  const response = await axios.get(url, {
    timeout: 15_000,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
    },
  });

  const result = response.data?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo Finance returned empty result');

  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];
  if (!quote || timestamps.length === 0) throw new Error('Yahoo Finance: no quote data');

  const { open, high, low, close } = quote;

  let candles: IOHLCV[] = timestamps
    .map((t: number, i: number) => ({
      time:   t,
      open:   open[i],
      high:   high[i],
      low:    low[i],
      close:  close[i],
      volume: 0,
    }))
    .filter((c: IOHLCV) =>
      c.time > 0 &&
      c.open  != null && !isNaN(c.open)  && c.open  > 0 &&
      c.high  != null && !isNaN(c.high)  && c.high  > 0 &&
      c.low   != null && !isNaN(c.low)   && c.low   > 0 &&
      c.close != null && !isNaN(c.close) && c.close > 0
    )
    .sort((a: IOHLCV, b: IOHLCV) => a.time - b.time);

  // Aggregate 1h → 4h
  if (timeframe === '4h') {
    candles = aggregate4h(candles);
  }

  return candles.slice(-100);
}

function aggregate4h(candles: IOHLCV[]): IOHLCV[] {
  const result: IOHLCV[] = [];
  for (let i = 0; i < candles.length; i += 4) {
    const chunk = candles.slice(i, i + 4);
    if (chunk.length === 0) continue;
    result.push({
      time:   chunk[0].time,
      open:   chunk[0].open,
      high:   Math.max(...chunk.map((c) => c.high)),
      low:    Math.min(...chunk.map((c) => c.low)),
      close:  chunk[chunk.length - 1].close,
      volume: 0,
    });
  }
  return result;
}

// ─── Twelve Data fetcher (primary when key configured) ────────────────────────
// Uses real spot forex / XAU/USD prices — more accurate than Yahoo GC=F futures

async function fetchFromTwelveData(pair: ValidPair, timeframe: ValidTimeframe): Promise<IOHLCV[]> {
  const key = env.twelveDataApiKey;
  if (!key) throw new Error('Twelve Data key not configured');

  const symbol   = pair;             // Twelve Data uses native XAU/USD, EUR/USD etc.
  const interval = TD_INTERVAL[timeframe];

  // Do NOT use encodeURIComponent — Twelve Data needs the literal slash in XAU/USD, EUR/USD etc.
  // timezone=UTC forces all datetimes to UTC regardless of exchange (default is exchange-local,
  // e.g. XAU/USD defaults to AEST UTC+10 which would make timestamps 10h ahead on the chart).
  const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=100&timezone=UTC&apikey=${key}`;

  const response = await axios.get(url, { timeout: 8_000 });
  const data = response.data;

  if (data.status === 'error') {
    throw new Error(`Twelve Data error: ${data.message ?? JSON.stringify(data)}`);
  }

  // Log first value to confirm UTC timestamps look correct
  if (Array.isArray(data.values) && data.values.length > 0) {
    console.info(`[TwelveData] ${pair}/${timeframe} — latest candle: ${data.values[0].datetime} (newest-first)`);
  }

  if (!Array.isArray(data.values) || data.values.length === 0) {
    throw new Error('Twelve Data returned empty values');
  }

  // Values are newest-first — reverse to oldest-first.
  // Twelve Data returns "YYYY-MM-DD HH:MM:SS" without a timezone suffix.
  // Appending 'T' + 'Z' forces V8 to parse it as UTC regardless of server locale.
  const candles: IOHLCV[] = data.values
    .map((v: Record<string, string>) => ({
      time:   Math.floor(new Date(v.datetime.replace(' ', 'T') + 'Z').getTime() / 1000),
      open:   parseFloat(v.open),
      high:   parseFloat(v.high),
      low:    parseFloat(v.low),
      close:  parseFloat(v.close),
      volume: parseFloat(v.volume ?? '0') || 0,
    }))
    .filter((c: IOHLCV) => !isNaN(c.open) && !isNaN(c.close) && c.close > 0)
    .reverse();

  return candles.slice(-100);
}

// ─── Alpha Vantage fetcher (fallback) ─────────────────────────────────────────

async function fetchFromAlphaVantage(pair: ValidPair, timeframe: ValidTimeframe): Promise<IOHLCV[]> {
  const key = env.alphaVantageApiKey;
  if (!key) throw new Error('Alpha Vantage key not configured');

  const [from, to] = pair.split('/');
  let url: string;

  if (timeframe === '1d' || pair === 'XAU/USD') {
    url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${from}&to_symbol=${to}&apikey=${key}`;
  } else {
    const interval = AV_INTERVAL[timeframe];
    url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${from}&to_symbol=${to}&interval=${interval}&outputsize=compact&apikey=${key}`;
  }

  const response = await axios.get(url, { timeout: 15_000 });
  const data = response.data;

  if (data['Note'] || data['Information']) {
    throw new Error('Alpha Vantage rate limit reached');
  }

  const tsKey =
    data['Time Series FX (Daily)']
      ? 'Time Series FX (Daily)'
      : data[`Time Series FX (${AV_INTERVAL[timeframe]})`]
        ? `Time Series FX (${AV_INTERVAL[timeframe]})`
        : data['Time Series FX (1min)']
          ? 'Time Series FX (1min)'
          : null;

  if (!tsKey) {
    console.warn('[chart] Alpha Vantage unexpected shape:', Object.keys(data));
    throw new Error('Alpha Vantage: unexpected response shape');
  }

  const timeSeries: Record<string, Record<string, string>> = data[tsKey];
  return Object.entries(timeSeries)
    .map(([time, values]) => ({
      time:   Math.floor(new Date(time).getTime() / 1000),
      open:   parseFloat(values['1. open']),
      high:   parseFloat(values['2. high']),
      low:    parseFloat(values['3. low']),
      close:  parseFloat(values['4. close']),
      volume: 0,
    }))
    .filter((c) => !isNaN(c.open) && !isNaN(c.close))
    .sort((a, b) => a.time - b.time)
    .slice(-100);
}

// ─── getOHLCV ─────────────────────────────────────────────────────────────────

export async function getOHLCV(pair: string, timeframe: string): Promise<IOHLCV[]> {

  if (!VALID_PAIRS.includes(pair as ValidPair)) throw new Error(`Invalid pair: ${pair}`);
  if (!VALID_TIMEFRAMES.includes(timeframe as ValidTimeframe)) throw new Error(`Invalid timeframe: ${timeframe}`);

  const validPair      = pair as ValidPair;
  const validTimeframe = timeframe as ValidTimeframe;
  const cacheKey       = `chart:${validPair}:${validTimeframe}`;

  // ── Fresh cache ───────────────────────────────────────────────────────────
  const fresh = await NewsCache.findOne({ key: cacheKey, expiresAt: { $gt: new Date() } }).lean();
  if (fresh?.data && Array.isArray(fresh.data) && (fresh.data as IOHLCV[]).length > 0) {
    return fresh.data as IOHLCV[];
  }

  // ── Race Twelve Data vs Yahoo Finance (parallel — fastest wins) ──────────
  // Sequential fallback caused 27s responses when TD timed out then YF also ran.
  // Now both fire simultaneously; first valid result wins. TD has a short timeout
  // so if it's slow, Yahoo wins the race without waiting the full 15s.
  let candles: IOHLCV[] = [];
  let source = '';

  const fetches: Promise<{ candles: IOHLCV[]; src: string }>[] = [];

  if (env.twelveDataApiKey) {
    fetches.push(
      fetchFromTwelveData(validPair, validTimeframe)
        .then((c) => ({ candles: c, src: 'Twelve Data' }))
        .catch((err) => {
          console.warn(`[chart] Twelve Data failed for ${validPair}/${validTimeframe}: ${err instanceof Error ? err.message : String(err)}`);
          return { candles: [] as IOHLCV[], src: '' };
        })
    );
  }

  fetches.push(
    fetchFromYahoo(validPair, validTimeframe)
      .then((c) => ({ candles: c, src: 'Yahoo Finance' }))
      .catch((err) => {
        console.warn(`[chart] Yahoo Finance failed for ${validPair}/${validTimeframe}: ${err instanceof Error ? err.message : String(err)}`);
        return { candles: [] as IOHLCV[], src: '' };
      })
  );

  // Wait for all and pick the first with data, preferring Twelve Data if both succeed
  const results = await Promise.all(fetches);
  const tdResult = results.find((r) => r.src === 'Twelve Data' && r.candles.length > 0);
  const yfResult = results.find((r) => r.src === 'Yahoo Finance' && r.candles.length > 0);
  const winner   = tdResult ?? yfResult;

  if (winner) {
    candles = winner.candles;
    source  = winner.src;
  }

  // ── Alpha Vantage (last resort if both primary sources failed) ────────────
  if (candles.length === 0) {
    try {
      candles = await fetchFromAlphaVantage(validPair, validTimeframe);
      source = 'Alpha Vantage';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[chart] Alpha Vantage failed for ${validPair}/${validTimeframe}: ${msg}`);
    }
  }

  // ── Stale cache fallback ──────────────────────────────────────────────────
  if (candles.length === 0) {
    const stale = await NewsCache.findOne({ key: cacheKey }).lean();
    if (stale?.data && Array.isArray(stale.data) && (stale.data as IOHLCV[]).length > 0) {
      console.info(`[chart] Serving stale cache for ${cacheKey}`);
      return stale.data as IOHLCV[];
    }
    // No data anywhere — fail clearly rather than fabricate
    throw new Error(
      `No market data available for ${validPair} ${validTimeframe}. Both Yahoo Finance and Alpha Vantage are unavailable.`
    );
  }

  console.info(`[chart] Fetched ${candles.length} candles for ${cacheKey} via ${source}`);

  // ── Cache write ───────────────────────────────────────────────────────────
  const ttl = getCacheTtl(validTimeframe);
  await NewsCache.findOneAndUpdate(
    { key: cacheKey },
    { key: cacheKey, data: candles, expiresAt: new Date(Date.now() + ttl) },
    { upsert: true, new: true }
  );

  return candles;
}

// ─── aggregateDailyToWeekly ───────────────────────────────────────────────────
// Groups daily candles into ISO weeks (Mon–Fri). Used to compute weekly trend
// without a separate API call — we already have daily candles in the signal flow.

export function aggregateDailyToWeekly(dailyCandles: IOHLCV[]): IOHLCV[] {
  const groups = new Map<string, IOHLCV[]>();

  for (const c of dailyCandles) {
    const d   = new Date(c.time * 1000);
    const day = d.getUTCDay(); // 0=Sun,1=Mon,...,6=Sat
    // Roll back to the Monday of this week
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
    monday.setUTCHours(0, 0, 0, 0);
    const key = monday.toISOString().split('T')[0];
    const group = groups.get(key) ?? [];
    group.push(c);
    groups.set(key, group);
  }

  const result: IOHLCV[] = [];
  for (const [, candles] of [...groups.entries()].sort()) {
    if (candles.length < 3) continue; // skip partial weeks (< 3 trading days)
    result.push({
      time:   candles[0].time,
      open:   candles[0].open,
      high:   Math.max(...candles.map((c) => c.high)),
      low:    Math.min(...candles.map((c) => c.low)),
      close:  candles[candles.length - 1].close,
      volume: 0,
    });
  }
  return result;
}

// ─── getSupportResistance ─────────────────────────────────────────────────────

export function getSupportResistance(candles: IOHLCV[]): ISupportLevel[] {
  if (candles.length < 10) return [];

  const lookback = 5;
  const highs: number[] = [];
  const lows:  number[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const { high, low } = candles[i];
    let isSwingHigh = true;
    let isSwingLow  = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= high) isSwingHigh = false;
      if (candles[j].low  <= low)  isSwingLow  = false;
    }
    if (isSwingHigh) highs.push(high);
    if (isSwingLow)  lows.push(low);
  }

  const resistance = deduplicate(highs, 0.003).slice(-3);
  const support    = deduplicate(lows,  0.003).slice(-3);

  return [
    ...resistance.map((price, idx) => ({ price, type: 'resistance' as const, strength: 3 - idx })),
    ...support.map((price, idx)    => ({ price, type: 'support' as const,    strength: 3 - idx })),
  ].sort((a, b) => b.price - a.price);
}

function deduplicate(prices: number[], threshold: number): number[] {
  if (prices.length === 0) return [];
  const sorted = [...prices].sort((a, b) => a - b);
  const result = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = result[result.length - 1];
    if (Math.abs(sorted[i] - last) / last > threshold) result.push(sorted[i]);
  }
  return result;
}

// ─── getFibonacciLevels ───────────────────────────────────────────────────────

export function getFibonacciLevels(candles: IOHLCV[]): IFibLevel[] {
  if (candles.length === 0) return [];
  const high = Math.max(...candles.map((c) => c.high));
  const low  = Math.min(...candles.map((c) => c.low));
  const diff = high - low;
  if (diff === 0) return [];
  return [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0].map((ratio) => ({
    label:   `${(ratio * 100).toFixed(1)}%`,
    value:   parseFloat((high - diff * ratio).toFixed(5)),
    percent: ratio,
  }));
}
