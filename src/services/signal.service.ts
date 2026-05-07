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
import { ISignal } from '../types/signal.types';
import { VALID_PAIRS, VALID_TIMEFRAMES, ValidPair, ValidTimeframe } from '../types/chart.types';

// Maps each timeframe to the next higher timeframe for trend confluence
const HIGHER_TF: Record<ValidTimeframe, ValidTimeframe> = {
  '1m':  '15m',
  '5m':  '1h',
  '15m': '1h',
  '1h':  '4h',
  '4h':  '1d',
  '1d':  '1d',
};

function getSession(): string {
  const h = new Date().getUTCHours();
  if (h >= 23 || h < 7)  return 'Asian Session (low volatility, tight ranges)';
  if (h >= 7  && h < 12) return 'London Open / European Session (rising volatility)';
  if (h >= 12 && h < 17) return 'London-NY Overlap (peak liquidity, highest volatility)';
  return 'New York Session (moderate volatility)';
}

// ─── getSignal ────────────────────────────────────────────────────────────────

export async function getSignal(
  userId: string,
  pair: string,
  timeframe: string
): Promise<ISignal> {

  // Validate pair and timeframe before any DB or API call
  if (!VALID_PAIRS.includes(pair as ValidPair)) {
    throw new Error(`Invalid pair: ${pair}`);
  }
  if (!VALID_TIMEFRAMES.includes(timeframe as ValidTimeframe)) {
    throw new Error(`Invalid timeframe: ${timeframe}`);
  }

  const userObjectId = new Types.ObjectId(userId);

  // ── Cache check ───────────────────────────────────────────────────────────
  const cached = await Signal.findOne({
    userId:    userObjectId,
    pair,
    timeframe,
    createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
  }).lean();

  if (cached) return cached;

  // ── Generate new signal ───────────────────────────────────────────────────
  const candles = await getOHLCV(pair, timeframe);

  if (candles.length === 0) {
    throw new Error(`No candle data available for ${pair} ${timeframe}`);
  }

  const lastCandle = candles[candles.length - 1];

  // Run all indicator calculations (includes ATR)
  const indicators = computeAll(candles);

  // Higher-timeframe trend for confluence
  const validTimeframe = timeframe as ValidTimeframe;
  const htf = HIGHER_TF[validTimeframe];
  let higherTfTrend = 'Higher timeframe data unavailable';
  if (htf !== validTimeframe) {
    try {
      const htfCandles = await getOHLCV(pair, htf);
      if (htfCandles.length > 0) {
        const htfInd  = computeAll(htfCandles);
        const htfLast = htfCandles[htfCandles.length - 1];
        const dir     = htfLast.close > htfInd.ema50 ? 'BULLISH' : 'BEARISH';
        const vsEma   = htfLast.close > htfInd.ema50 ? 'above' : 'below';
        const macdDir = htfInd.macd.histogram > 0 ? 'bullish' : 'bearish';
        higherTfTrend =
          `${htf}: ${dir} | price ${vsEma} EMA50(${htfInd.ema50.toFixed(5)}) | ` +
          `RSI=${htfInd.rsi.toFixed(1)} | ADX=${htfInd.adx.toFixed(1)} | ` +
          `MACD histogram ${macdDir} (${htfInd.macd.histogram.toFixed(5)})`;
      }
    } catch {
      // non-fatal — signal is still generated without HTF context
    }
  } else {
    higherTfTrend = 'Already on highest tracked timeframe (1d)';
  }

  // Fetch sentiment, personal rules, and past accuracy in parallel
  const [newsSentiment, ragContext, accuracyCtx] = await Promise.allSettled([
    getSentimentSummary(pair as ValidPair),
    queryUserRules(userId, pair),
    getAccuracyContext(userId, pair, timeframe),
  ]);

  const sentiment  = newsSentiment.status === 'fulfilled' ? newsSentiment.value  : 'Sentiment unavailable';
  const context    = ragContext.status    === 'fulfilled' ? ragContext.value      : '';
  const accuracy   = accuracyCtx.status  === 'fulfilled' ? accuracyCtx.value     : '';

  // ── Personal edge context ─────────────────────────────────────────────────
  // Quick aggregate to tell the AI how this specific user performs on this pair,
  // so signal confidence is calibrated to their actual historical edge.
  let tradingContext = '';
  try {
    const [pairStat] = await Trade.aggregate([
      { $match: { userId: userObjectId, pair, status: { $in: ['win', 'loss'] } } },
      { $group: {
        _id:   null,
        total: { $sum: 1 },
        wins:  { $sum: { $cond: [{ $eq: ['$status', 'win'] }, 1, 0] } },
        buys:  { $sum: { $cond: [{ $eq: ['$type', 'BUY'] }, 1, 0] } },
        buyWins: { $sum: {
          $cond: [{ $and: [{ $eq: ['$type', 'BUY'] }, { $eq: ['$status', 'win'] }] }, 1, 0]
        }},
      }},
    ]);
    if (pairStat && pairStat.total >= 5) {
      const wr = ((pairStat.wins / pairStat.total) * 100).toFixed(0);
      const buyWr = pairStat.buys > 0
        ? `BUY ${((pairStat.buyWins / pairStat.buys) * 100).toFixed(0)}% / SELL ${(((pairStat.wins - pairStat.buyWins) / Math.max(pairStat.total - pairStat.buys, 1)) * 100).toFixed(0)}%`
        : '';
      const guidance = pairStat.wins / pairStat.total >= 0.60
        ? 'Proven edge — high-quality setups can be traded with confidence.'
        : pairStat.wins / pairStat.total >= 0.50
        ? 'Moderate edge — A+ setups only, tighter size.'
        : 'Below 50% win rate — apply stricter entry criteria or consider skipping.';
      tradingContext = `${pairStat.total} trades on ${pair}: ${wr}% win rate${buyWr ? ` (${buyWr})` : ''}. ${guidance}`;
    }
  } catch { /* non-fatal — signal generated without personal context */ }

  const result = await generateSignal({
    pair:            pair as ValidPair,
    timeframe:       validTimeframe,
    price:           lastCandle.close,
    rsi:             indicators.rsi,
    macd:            indicators.macd,
    ema20:           indicators.ema20,
    ema50:           indicators.ema50,
    bb:              indicators.bb,
    stoch:           indicators.stoch,
    adx:             indicators.adx,
    atr:             indicators.atr,
    patterns:        indicators.patterns,
    newsSentiment:   sentiment,
    ragContext:      context,
    accuracyContext: accuracy,
    tradingContext,
    session:         getSession(),
    higherTfTrend,
  });

  // Validate Groq returned a usable signal before saving
  if (!result.signal || !['BUY', 'SELL', 'HOLD'].includes(result.signal)) {
    throw new Error('AI returned an invalid signal value');
  }

  const signal = await Signal.create({
    userId:               userObjectId,
    pair,
    timeframe,
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
  });

  return signal;
}

// ─── getSignalHistory ─────────────────────────────────────────────────────────

export async function getSignalHistory(
  userId: string,
  pair: string
): Promise<ISignal[]> {
  if (!VALID_PAIRS.includes(pair as ValidPair)) {
    throw new Error(`Invalid pair: ${pair}`);
  }

  return Signal.find({
    userId: new Types.ObjectId(userId),
    pair,
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
}