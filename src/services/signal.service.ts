// src/services/signal.service.ts

import { Types } from 'mongoose';
import Signal from '../models/Signal.model';
import Trade from '../models/Trade.model';
import { getOHLCV } from './chart.service';
import { computeAll } from './indicator.service';
import { getSentimentSummary } from './news.service';
import { generateSignal } from './groq.service';
import { queryUserRules } from './rag.service';
import { getAccuracyContext } from './signalAccuracy.service';
import { ISignal, SessionRating } from '../types/signal.types';
import { VALID_PAIRS, VALID_TIMEFRAMES, ValidPair, ValidTimeframe } from '../types/chart.types';

// ─── Cache durations by timeframe ─────────────────────────────────────────────
// No need to re-analyse a 1H setup every 5 minutes — conditions rarely change
// that fast. Shorter timeframes get shorter caches.
const CACHE_MS: Record<ValidTimeframe, number> = {
  '1m':  2  * 60 * 1000,
  '5m':  5  * 60 * 1000,
  '15m': 12 * 60 * 1000,
  '1h':  25 * 60 * 1000,
  '4h':  75 * 60 * 1000,
  '1d':  4  * 60 * 60 * 1000,
};

// ─── Signal validity after generation ─────────────────────────────────────────
const VALIDITY_MS: Record<ValidTimeframe, number> = {
  '1m':  5  * 60 * 1000,
  '5m':  15 * 60 * 1000,
  '15m': 45 * 60 * 1000,
  '1h':  3  * 60 * 60 * 1000,
  '4h':  12 * 60 * 60 * 1000,
  '1d':  48 * 60 * 60 * 1000,
};

// ─── Higher-timeframe map ─────────────────────────────────────────────────────
const HIGHER_TF: Record<ValidTimeframe, ValidTimeframe> = {
  '1m':  '15m',
  '5m':  '1h',
  '15m': '1h',
  '1h':  '4h',
  '4h':  '1d',
  '1d':  '1d',
};

// ─── Session rating per pair ──────────────────────────────────────────────────
// Based on the trading library: each pair has optimal windows.

function getSessionRating(pair: ValidPair, utcHour: number): SessionRating {
  switch (pair) {
    case 'XAU/USD':
      // Prime: London open + NY open. Avoid: late NY + Asia.
      if ((utcHour >= 7 && utcHour < 12) || (utcHour >= 13 && utcHour < 16)) return 'PRIME';
      if (utcHour >= 12 && utcHour < 20) return 'ACTIVE';
      return 'AVOID';

    case 'GBP/USD':
      if (utcHour >= 13 && utcHour < 17) return 'PRIME'; // London-NY overlap
      if (utcHour >= 7 && utcHour < 17)  return 'ACTIVE';
      return 'AVOID';

    case 'EUR/USD':
      if (utcHour >= 13 && utcHour < 17) return 'PRIME'; // London-NY overlap
      if (utcHour >= 7 && utcHour < 17)  return 'ACTIVE';
      return 'AVOID';

    case 'USD/JPY':
      if (utcHour >= 13 && utcHour < 17) return 'PRIME'; // NY high-impact data
      if ((utcHour >= 7 && utcHour < 17) || utcHour >= 22 || utcHour < 7) return 'ACTIVE';
      return 'AVOID';

    default:
      return 'ACTIVE';
  }
}

// ─── Minimum ATR thresholds (in price units, not pips) ───────────────────────
const MIN_ATR: Record<ValidPair, number> = {
  'XAU/USD': 1.5,   // Gold needs at least ~$1.50 range per candle
  'GBP/USD': 0.0005,
  'EUR/USD': 0.0005,
  'USD/JPY': 0.05,
};

// ─── Pip size per pair ────────────────────────────────────────────────────────
function pipSize(pair: ValidPair): number {
  if (pair === 'USD/JPY') return 0.01;
  if (pair === 'XAU/USD') return 0.01;
  return 0.0001;
}

function toPips(pair: ValidPair, priceDiff: number): number {
  return Math.abs(Math.round(priceDiff / pipSize(pair)));
}

// ─── Session description for prompt ──────────────────────────────────────────
function getSessionDescription(utcHour: number): string {
  if (utcHour >= 22 || utcHour < 7)  return 'Asian Session (11pm-7am UTC) — low volatility, tight ranges, JPY pairs best';
  if (utcHour >= 7  && utcHour < 12) return 'London Open (7am-12pm UTC) — high volatility, trends established here';
  if (utcHour >= 12 && utcHour < 17) return 'London-NY Overlap (12pm-5pm UTC) — PEAK liquidity and volatility, most reliable';
  return 'New York Session (5pm-10pm UTC) — moderate volatility, USD data driven';
}

// ─── Build HTF summary string ─────────────────────────────────────────────────
function buildTfSummary(tf: string, candles: any[], ind: any): string {
  const last = candles[candles.length - 1];
  const dir  = last.close > ind.ema200 ? 'BULLISH' : last.close > ind.ema50 ? 'NEUTRAL-BULLISH' : 'BEARISH';
  const macdDir = ind.macd.histogram > 0 ? 'bullish' : 'bearish';
  const adxCtx  = ind.adx >= 25 ? `trending (${ind.adx.toFixed(1)})` : `ranging (${ind.adx.toFixed(1)})`;
  return `${tf}: ${dir} | price vs EMA50=${last.close > ind.ema50 ? 'above' : 'below'} | RSI=${ind.rsi.toFixed(1)} | ADX=${adxCtx} | MACD=${macdDir}`;
}

// ─── Main signal function ─────────────────────────────────────────────────────

export async function getSignal(
  userId: string,
  pair: string,
  timeframe: string
): Promise<ISignal> {

  if (!VALID_PAIRS.includes(pair as ValidPair)) throw new Error(`Invalid pair: ${pair}`);
  if (!VALID_TIMEFRAMES.includes(timeframe as ValidTimeframe)) throw new Error(`Invalid timeframe: ${timeframe}`);

  const validPair = pair as ValidPair;
  const validTf   = timeframe as ValidTimeframe;
  const userObjectId = new Types.ObjectId(userId);
  const utcHour = new Date().getUTCHours();

  // ── Cache check ───────────────────────────────────────────────────────────
  const cacheWindow = CACHE_MS[validTf];
  const cached = await Signal.findOne({
    userId:    userObjectId,
    pair:      validPair,
    timeframe: validTf,
    createdAt: { $gte: new Date(Date.now() - cacheWindow) },
  }).sort({ createdAt: -1 }).lean();

  if (cached) return cached;

  // ── Fetch candles + compute indicators ───────────────────────────────────
  const candles = await getOHLCV(validPair, validTf);
  if (candles.length === 0) throw new Error(`No candle data for ${pair} ${timeframe}`);

  const indicators = computeAll(candles);
  const lastCandle = candles[candles.length - 1];
  const sessionRating = getSessionRating(validPair, utcHour);

  // ── Pre-generation gate ───────────────────────────────────────────────────
  // If we're in AVOID session AND ATR is below minimum → synthetic HOLD.
  // No Groq call, no cost. The user should not be trading this pair right now.
  const atrTooLow = indicators.atr < MIN_ATR[validPair];
  if (sessionRating === 'AVOID' && atrTooLow) {
    return _syntheticHold(
      userObjectId, validPair, validTf, lastCandle.close,
      sessionRating, indicators,
      `AVOID session for ${pair} + low volatility (ATR ${indicators.atr.toFixed(5)} below threshold). Wait for ${validPair === 'GBP/USD' || validPair === 'EUR/USD' ? 'London session (7am UTC)' : 'prime session window'}.`
    );
  }

  // ── Full multi-timeframe context ──────────────────────────────────────────
  const htf  = HIGHER_TF[validTf];
  let higherTfTrend = 'Higher timeframe data unavailable';
  let dailyTrend    = 'Daily data unavailable';
  let htfBiasSummary = '';

  try {
    // 4H context (or HTF for shorter timeframes)
    if (htf !== validTf) {
      const htfCandles = await getOHLCV(validPair, htf);
      if (htfCandles.length > 0) {
        const htfInd = computeAll(htfCandles);
        higherTfTrend = buildTfSummary(htf, htfCandles, htfInd);
      }
    }

    // Daily context (always useful regardless of entry TF)
    if (validTf !== '1d') {
      const dailyCandles = await getOHLCV(validPair, '1d');
      if (dailyCandles.length > 0) {
        const dailyInd = computeAll(dailyCandles);
        dailyTrend = buildTfSummary('Daily', dailyCandles, dailyInd);
      }
    }

    // Summarise for storage
    htfBiasSummary = [higherTfTrend, dailyTrend].filter(s => !s.includes('unavailable')).join(' | ');
  } catch {
    // non-fatal — signal still generated with partial context
  }

  // ── Parallel data fetches ─────────────────────────────────────────────────
  const [newsSentiment, ragContext, accuracyCtx] = await Promise.allSettled([
    getSentimentSummary(validPair),
    queryUserRules(userId, pair),
    getAccuracyContext(userId, pair, timeframe),
  ]);

  const sentiment = newsSentiment.status === 'fulfilled' ? newsSentiment.value : 'Sentiment unavailable';
  const context   = ragContext.status    === 'fulfilled' ? ragContext.value    : '';
  const accuracy  = accuracyCtx.status  === 'fulfilled' ? accuracyCtx.value   : '';

  // ── Personal edge context ─────────────────────────────────────────────────
  let tradingContext = '';
  try {
    const [pairStat] = await Trade.aggregate([
      { $match: { userId: userObjectId, pair: validPair, status: { $in: ['win', 'loss'] } } },
      { $group: {
        _id:     null,
        total:   { $sum: 1 },
        wins:    { $sum: { $cond: [{ $eq: ['$status', 'win'] }, 1, 0] } },
        buys:    { $sum: { $cond: [{ $eq: ['$type', 'BUY'] }, 1, 0] } },
        buyWins: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'BUY'] }, { $eq: ['$status', 'win'] }] }, 1, 0] }},
      }},
    ]);
    if (pairStat && pairStat.total >= 5) {
      const wr    = ((pairStat.wins / pairStat.total) * 100).toFixed(0);
      const sells = pairStat.total - pairStat.buys;
      const buyWr = pairStat.buys > 0
        ? `BUY ${((pairStat.buyWins / pairStat.buys) * 100).toFixed(0)}%`
        : '';
      const sellWins = pairStat.wins - pairStat.buyWins;
      const sellWr = sells > 0
        ? `SELL ${((sellWins / sells) * 100).toFixed(0)}%`
        : '';
      const guidance = pairStat.wins / pairStat.total >= 0.60
        ? 'Proven edge — A+ setups can be traded with full confidence.'
        : pairStat.wins / pairStat.total >= 0.50
        ? 'Moderate edge — A+ setups only, standard size.'
        : 'Below 50% win rate — apply strictest criteria or skip.';
      tradingContext = `${pairStat.total} closed trades on ${pair}: ${wr}% win rate (${[buyWr, sellWr].filter(Boolean).join(' / ')}). ${guidance}`;
    }
  } catch { /* non-fatal */ }

  // ── Call Groq AI ──────────────────────────────────────────────────────────
  const result = await generateSignal({
    pair:            validPair,
    timeframe:       validTf,
    price:           lastCandle.close,
    rsi:             indicators.rsi,
    macd:            indicators.macd,
    ema20:           indicators.ema20,
    ema50:           indicators.ema50,
    ema200:          indicators.ema200 ?? indicators.ema50, // fallback if ema200 not in computeAll
    bb:              indicators.bb,
    stoch:           indicators.stoch,
    adx:             indicators.adx,
    atr:             indicators.atr,
    patterns:        indicators.patterns,
    newsSentiment:   sentiment,
    ragContext:      context,
    accuracyContext: accuracy,
    tradingContext,
    session:         getSessionDescription(utcHour),
    sessionRating,
    higherTfTrend,
    dailyTrend,
  });

  if (!result.signal || !['BUY', 'SELL', 'HOLD'].includes(result.signal)) {
    throw new Error('AI returned invalid signal value');
  }

  // ── Compute pip distances ─────────────────────────────────────────────────
  const ps        = pipSize(validPair);
  const pipsToSL  = toPips(validPair, Math.abs(result.entry - result.stopLoss));
  const pipsToTP  = toPips(validPair, Math.abs(result.takeProfit - result.entry));
  const validUntil = new Date(Date.now() + VALIDITY_MS[validTf]);

  const signal = await Signal.create({
    userId:               userObjectId,
    pair:                 validPair,
    timeframe:            validTf,
    signal:               result.signal,
    confidence:           result.confidence,
    bullScore:            result.bullScore,
    bearScore:            result.bearScore,
    reasoning:            result.reasoning,
    entry:                result.entry,
    takeProfit:           result.takeProfit,
    stopLoss:             result.stopLoss,
    riskReward:           result.riskReward,
    keyRisks:             result.keyRisks    ?? [],
    timeHorizon:          result.timeHorizon ?? 'Unknown',
    indicators,
    patterns:             indicators.patterns,
    autoTradeRecommended: result.autoTradeRecommended,
    confluenceScore:      result.confluenceScore,
    entryType:            result.entryType,
    sessionRating,
    pipsToSL,
    pipsToTP,
    invalidatesAt:        validUntil,
    htfBias:              htfBiasSummary,
  });

  return signal;
}

// ─── Synthetic HOLD (no Groq call) ────────────────────────────────────────────
async function _syntheticHold(
  userId:        Types.ObjectId,
  pair:          ValidPair,
  timeframe:     ValidTimeframe,
  price:         number,
  sessionRating: SessionRating,
  indicators:    any,
  reason:        string,
): Promise<ISignal> {
  return Signal.create({
    userId, pair, timeframe,
    signal:      'HOLD',
    confidence:  0,
    bullScore:   50,
    bearScore:   50,
    reasoning:   reason,
    entry:       price,
    takeProfit:  price,
    stopLoss:    price,
    riskReward:  '0:0',
    keyRisks:    [reason],
    timeHorizon: 'N/A',
    indicators,
    patterns:    indicators.patterns ?? [],
    autoTradeRecommended: false,
    confluenceScore: 0,
    entryType:   'MARKET' as const,
    sessionRating,
    pipsToSL:    0,
    pipsToTP:    0,
    invalidatesAt: new Date(Date.now() + CACHE_MS[timeframe]),
  }) as unknown as ISignal;
}

// ─── getSignalHistory ─────────────────────────────────────────────────────────

export async function getSignalHistory(
  userId: string,
  pair: string
): Promise<ISignal[]> {
  if (!VALID_PAIRS.includes(pair as ValidPair)) throw new Error(`Invalid pair: ${pair}`);
  return Signal.find({ userId: new Types.ObjectId(userId), pair })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
}
