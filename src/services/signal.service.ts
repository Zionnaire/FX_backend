// src/services/signal.service.ts

import { Types } from 'mongoose';
import Signal from '../models/Signal.model';
import Trade from '../models/Trade.model';
import { getOHLCV, getSupportResistance, aggregateDailyToWeekly } from './chart.service';
import { computeAll, Indicators } from './indicator.service';
import { atr as calcAtr } from '../utils/indicators.utils';
import { getSentimentSummary } from './news.service';
import { explainSignal } from './groq.service';
import { queryUserRules } from './rag.service';
import { getAccuracyContext } from './signalAccuracy.service';
import { getUpcomingHighImpactEvents } from './economicCalendar.service';
import { triggerAutoTrade } from './autoTrader.service';
import { IOHLCV } from '../types/chart.types';
import { ISignal, SessionRating } from '../types/signal.types';
import { analyzeMarketStructure } from './structure.service';
import { runStrategy, extractBias, TradingBias } from './strategy.service';
import { evaluateScalpExecution } from './scalp-execution.service';
import { logTradeEvent, utcHourToSession, detectMarketRegime, scoreOBQuality, scoreFVGQuality, scoreDisplacement } from './tradeEvent.service';
import { getAdaptiveWeights, getRegimeWeights } from './adaptiveWeights.service';
import { getLearnedBiasAdjustment, computeDynamicConfidence, blendConfidence } from './dynamicConfidence.service';
import { VALID_PAIRS, VALID_TIMEFRAMES, ValidPair, ValidTimeframe } from '../types/chart.types';

// ─── Cache durations by timeframe ─────────────────────────────────────────────
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

// ─── Scalp macro bias timeframes ──────────────────────────────────────────────
// For scalp mode, bias is read from 1H (for 1m/5m execution) or 4H (for 15m/1h
// execution) — higher than the execution TF but lower than swing HTF.
const SCALP_BIAS_TF: Record<ValidTimeframe, ValidTimeframe> = {
  '1m':  '1h',
  '5m':  '1h',
  '15m': '4h',
  '1h':  '4h',
  '4h':  '1d',
  '1d':  '1d',
};

// ─── Session rating per pair ──────────────────────────────────────────────────
function getSessionRating(pair: ValidPair, utcHour: number): SessionRating {
  switch (pair) {
    case 'XAU/USD':
      if ((utcHour >= 7 && utcHour < 12) || (utcHour >= 13 && utcHour < 16)) return 'PRIME';
      if (utcHour >= 12 && utcHour < 20) return 'ACTIVE';
      return 'AVOID';
    case 'GBP/USD':
      if (utcHour >= 13 && utcHour < 17) return 'PRIME';
      if (utcHour >= 7 && utcHour < 17)  return 'ACTIVE';
      return 'AVOID';
    case 'EUR/USD':
      if (utcHour >= 13 && utcHour < 17) return 'PRIME';
      if (utcHour >= 7 && utcHour < 17)  return 'ACTIVE';
      return 'AVOID';
    case 'USD/JPY':
      if (utcHour >= 13 && utcHour < 17) return 'PRIME';
      if ((utcHour >= 7 && utcHour < 17) || utcHour >= 22 || utcHour < 7) return 'ACTIVE';
      return 'AVOID';
    default:
      return 'ACTIVE';
  }
}

// ─── Minimum ATR thresholds ───────────────────────────────────────────────────
const MIN_ATR: Record<ValidPair, number> = {
  'XAU/USD': 1.5,
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
function buildTfSummary(tf: string, candles: IOHLCV[], ind: Indicators): string {
  const last   = candles[candles.length - 1];
  const ema200 = ind.ema200 ?? ind.ema50;
  const dir    = last.close > ema200 ? 'BULLISH' : last.close > ind.ema50 ? 'NEUTRAL-BULLISH' : 'BEARISH';
  const macdDir = ind.macd.histogram > 0 ? 'bullish' : 'bearish';
  const adxCtx  = ind.adx >= 25 ? `trending (${ind.adx.toFixed(1)})` : `ranging (${ind.adx.toFixed(1)})`;
  return `${tf}: ${dir} | price vs EMA50=${last.close > ind.ema50 ? 'above' : 'below'} | RSI=${ind.rsi.toFixed(1)} | ADX=${adxCtx} | MACD=${macdDir}`;
}

// ─── Indicator lean (pre-Groq rule engine) ────────────────────────────────────
// Computes a directional lean from pure indicator maths — before calling Groq.
// Score > 0 = bullish lean, < 0 = bearish lean, near 0 = neutral/conflicted.
function computeIndicatorLean(ind: Indicators, lastCandle: IOHLCV): {
  lean:  'BULL' | 'BEAR' | 'NEUTRAL';
  score: number;
} {
  let score = 0;
  const price = lastCandle.close;
  const ema200 = ind.ema200 ?? ind.ema50;

  // EMA stack — macro bias weighted most (200 > 50 > 20)
  if (price > ema200)   score += 2; else score -= 2;
  if (price > ind.ema50)  score += 1; else score -= 1;
  if (price > ind.ema20)  score += 1; else score -= 1;

  // MACD momentum
  if (ind.macd.histogram > 0) score += 1; else score -= 1;

  // RSI directional bias
  if (ind.rsi > 55) score += 1; else if (ind.rsi < 45) score -= 1;

  // Stochastic
  if (ind.stoch.k > 60) score += 0.5; else if (ind.stoch.k < 40) score -= 0.5;

  const lean: 'BULL' | 'BEAR' | 'NEUTRAL' =
    score >= 2 ? 'BULL' : score <= -2 ? 'BEAR' : 'NEUTRAL';

  return { lean, score };
}

// ─── Quality tier assignment ──────────────────────────────────────────────────
// A+ = full auto-trade eligible.  A = notify only.  B/C = informational.
function assignQualityTier(
  signal:        'BUY' | 'SELL' | 'HOLD',
  confluenceScore: number,
  confidence:    number,
  weeklyAligned: boolean,
  dailyAligned:  boolean,
): 'A+' | 'A' | 'B' | 'C' {
  if (signal === 'HOLD') return 'C';

  // A+: strictest — weekly + daily both agree, high confluence + confidence
  if (
    confluenceScore >= 7 &&
    confidence      >= 75 &&
    weeklyAligned   &&
    dailyAligned
  ) return 'A+';

  // A: daily aligned, solid confluence
  if (confluenceScore >= 5 && confidence >= 65 && dailyAligned) return 'A';

  // B: some indicators align
  if (confluenceScore >= 3 && confidence >= 55) return 'B';

  return 'C';
}

// ─── Main signal function ─────────────────────────────────────────────────────

export async function getSignal(
  userId:       string,
  pair:         string,
  timeframe:    string,
  tradingStyle: 'scalp' | 'swing' = 'swing',
): Promise<ISignal> {

  if (!VALID_PAIRS.includes(pair as ValidPair))       throw new Error(`Invalid pair: ${pair}`);
  if (!VALID_TIMEFRAMES.includes(timeframe as ValidTimeframe)) throw new Error(`Invalid timeframe: ${timeframe}`);

  const validPair    = pair as ValidPair;
  const validTf      = timeframe as ValidTimeframe;
  const userObjectId = new Types.ObjectId(userId);
  const utcHour      = new Date().getUTCHours();

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

  // ── Support / Resistance levels ───────────────────────────────────────────
  let keyLevels = '';
  try {
    const srLevels = getSupportResistance(candles);
    const price    = lastCandle.close;
    const nearest  = srLevels
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
      .slice(0, 4);
    keyLevels = nearest
      .map((l) => `${l.type.toUpperCase()} @ ${l.price.toFixed(5)} (strength ${l.strength})`)
      .join(' | ');
  } catch { /* non-fatal */ }

  // ── ATR rate-of-change ────────────────────────────────────────────────────
  let atrTrend: 'expanding' | 'contracting' | 'stable' = 'stable';
  try {
    if (candles.length >= 20) {
      const prevAtr = calcAtr(candles.slice(0, -5));
      if (prevAtr > 0) {
        const pct = (indicators.atr - prevAtr) / prevAtr;
        if (pct > 0.15)       atrTrend = 'expanding';
        else if (pct < -0.15) atrTrend = 'contracting';
      }
    }
  } catch { /* non-fatal */ }

  // ── Hard ATR gate (data quality — before anything else) ──────────────────
  if (tradingStyle === 'scalp' && indicators.atr < MIN_ATR[validPair] * 0.5) {
    return _syntheticHold(
      userObjectId, validPair, validTf, lastCandle.close, sessionRating, indicators,
      `Scalp blocked: ATR ${indicators.atr.toFixed(5)} is critically low. Wait for volatility.`
    );
  }

  // ── Full multi-timeframe context ──────────────────────────────────────────
  const htf = HIGHER_TF[validTf];
  let higherTfTrend = 'Higher timeframe data unavailable';
  let dailyTrend    = 'Daily data unavailable';
  let weeklyTrend   = 'Weekly data unavailable';
  let htfBiasSummary = '';
  let dailyAligned  = false;
  let weeklyAligned = false;

  try {
    if (htf !== validTf) {
      const htfCandles = await getOHLCV(validPair, htf);
      if (htfCandles.length > 0) {
        const htfInd  = computeAll(htfCandles);
        higherTfTrend = buildTfSummary(htf, htfCandles, htfInd);
      }
    }
    if (validTf !== '1d') {
      const dailyCandles = await getOHLCV(validPair, '1d');
      if (dailyCandles.length > 0) {
        const dailyInd = computeAll(dailyCandles);
        dailyTrend     = buildTfSummary('Daily', dailyCandles, dailyInd);

        const weeklyCandles = aggregateDailyToWeekly(dailyCandles);
        if (weeklyCandles.length >= 3) {
          const wInd    = computeAll(weeklyCandles);
          const lastW   = weeklyCandles[weeklyCandles.length - 1];
          const wEma200 = wInd.ema200 ?? wInd.ema50;
          const wDir    = lastW.close > wEma200 ? 'BULLISH' : lastW.close < wEma200 ? 'BEARISH' : 'NEUTRAL';
          const wMacd   = wInd.macd.histogram > 0 ? 'bullish' : 'bearish';
          weeklyTrend   = `Weekly: ${wDir} | RSI=${wInd.rsi.toFixed(1)} | MACD=${wMacd} | ADX=${wInd.adx.toFixed(1)}`;
        }
      }
    }
    htfBiasSummary = [weeklyTrend, dailyTrend, higherTfTrend]
      .filter((s) => !s.includes('unavailable'))
      .join(' | ');
  } catch { /* non-fatal */ }

  // ── Scalp macro bias (1H/4H — fetched separately from swing HTF) ────────────
  // Used only in scalp mode. Gives the strategy engine a mid-timeframe directional
  // context without letting daily/weekly bias block counter-trend scalp setups.
  let scalpMacroBias: TradingBias | undefined;
  if (tradingStyle === 'scalp') {
    try {
      const scalp_btf         = SCALP_BIAS_TF[validTf];
      const scalp_btf_candles = await getOHLCV(validPair, scalp_btf);
      if (scalp_btf_candles.length > 0) {
        const scalp_btf_ind = computeAll(scalp_btf_candles);
        scalpMacroBias = extractBias(buildTfSummary(scalp_btf, scalp_btf_candles, scalp_btf_ind));
      }
      console.info(`[SCALP] Macro bias TF=${scalp_btf}: ${scalpMacroBias ?? 'neutral'}`);
    } catch { /* non-fatal */ }
  }

  // ── Market structure analysis ─────────────────────────────────────────────
  let structureContext = '';
  let structureObj = analyzeMarketStructure(candles);
  try { structureContext = structureObj.summary; } catch { /* non-fatal */ }

  // ── Pre-fetch regime detection ────────────────────────────────────────────
  // Detect regime from current indicators (without hasNews — corrected post-fetch).
  // Used to fetch the regime-specific weight profile in the parallel block below.
  const preliminaryRegime = detectMarketRegime(indicators, structureObj, atrTrend, false);

  // ── Parallel data fetches ─────────────────────────────────────────────────
  const newsWindow = tradingStyle === 'scalp' ? 30 : 120;
  const [newsSentiment, ragContext, accuracyCtx, calendarEvents, adaptiveWeightResult, regimeWeightResult] = await Promise.allSettled([
    getSentimentSummary(validPair),
    queryUserRules(userId, pair),
    getAccuracyContext(userId, pair, timeframe),
    getUpcomingHighImpactEvents(validPair, newsWindow),
    getAdaptiveWeights(userId),
    getRegimeWeights(userId, preliminaryRegime),
  ]);

  const sentiment      = newsSentiment.status === 'fulfilled'  ? newsSentiment.value  : 'Sentiment unavailable';
  const context        = ragContext.status    === 'fulfilled'  ? ragContext.value     : '';
  const accuracy       = accuracyCtx.status  === 'fulfilled'  ? accuracyCtx.value    : '';
  const upcomingEvts   = calendarEvents.status === 'fulfilled' ? calendarEvents.value : [];
  const weightProfile  = adaptiveWeightResult.status === 'fulfilled' ? adaptiveWeightResult.value : null;
  // Regime profile takes priority; falls back to global profile if no regime data yet
  const regimeProfile  = regimeWeightResult.status === 'fulfilled' ? regimeWeightResult.value : null;
  const activeProfile  = regimeProfile ?? weightProfile;
  const upcomingNews = upcomingEvts.length > 0
    ? upcomingEvts.map((e) => `${e.country} ${e.title} @ ${new Date(e.date).toUTCString()}`).join(' | ')
    : '';

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
      const buyWr = pairStat.buys > 0 ? `BUY ${((pairStat.buyWins / pairStat.buys) * 100).toFixed(0)}%` : '';
      const sellWr = sells > 0 ? `SELL ${(((pairStat.wins - pairStat.buyWins) / sells) * 100).toFixed(0)}%` : '';
      const guidance = pairStat.wins / pairStat.total >= 0.60
        ? 'Proven edge — A+ setups can be traded with full confidence.'
        : pairStat.wins / pairStat.total >= 0.50
        ? 'Moderate edge — A+ setups only.'
        : 'Below 50% win rate — strictest criteria only.';
      tradingContext = `${pairStat.total} closed trades on ${pair}: ${wr}% win rate (${[buyWr, sellWr].filter(Boolean).join(' / ')}). ${guidance}`;
    }
  } catch { /* non-fatal */ }

  // ── DETERMINISTIC RULE ENGINE (decides direction — no AI involved) ────────
  const htfBiasDir    = extractBias(higherTfTrend);
  const dailyBiasDir  = extractBias(dailyTrend);
  const weeklyBiasDir = extractBias(weeklyTrend);

  const strategyDecision = runStrategy(
    candles, indicators, structureObj, sessionRating,
    htfBiasDir, dailyBiasDir, weeklyBiasDir,
    validPair, tradingStyle, atrTrend,
    scalpMacroBias,
  );

  // Strategy said HOLD → return immediately without calling Groq
  if (strategyDecision.signal === 'HOLD') {
    const holdReason = [
      ...strategyDecision.blockers,
      ...strategyDecision.reasons,
    ].join('. ') || 'No high-quality setup detected by the rule engine.';
    return _syntheticHold(
      userObjectId, validPair, validTf, lastCandle.close, sessionRating, indicators,
      holdReason,
    );
  }

  // ── Scalp execution trigger validation ──────────────────────────────────
  // For scalp mode: validate that a candle-close-confirmed execution trigger
  // exists before routing to Groq. Enforces spread gate, cooldown, news lockout,
  // and anti-repaint rules. Swing mode skips this layer entirely.
  let execTriggerTypes: string[] = [];

  if (tradingStyle === 'scalp') {
    const execResult = await evaluateScalpExecution({
      candles,
      indicators,
      structure:      structureObj,
      signal:         strategyDecision.signal,
      pair:           validPair,
      userId,
      upcomingEvents: upcomingEvts,
      // currentSpread: not available from OHLCV; inject from broker tick feed when integrated
    });

    if (!execResult.canExecute) {
      return _syntheticHold(
        userObjectId, validPair, validTf, lastCandle.close, sessionRating, indicators,
        execResult.executionReason,
      );
    }

    execTriggerTypes = [execResult.trigger.type];

    // Enrich strategy decision with execution trigger context for Groq prompt
    strategyDecision.reasons.push(...execResult.trigger.reasons);
    strategyDecision.reasons.push(
      `Execution trigger: ${execResult.trigger.type} (quality=${execResult.trigger.quality}/100)`,
      `Retest score: ${execResult.retestScore.total}/100 (rejection=${execResult.retestScore.rejectionStrength}, depth=${execResult.retestScore.retracementDepth}, mitigation=${execResult.retestScore.mitigationQuality}, FVG=${execResult.retestScore.imbalanceRespect})`,
    );
  }

  // ── AI EXPLAINS the decided direction and computes entry/SL/TP ──────────
  const result = await explainSignal({
    pair:             validPair,
    timeframe:        validTf,
    price:            lastCandle.close,
    rsi:              indicators.rsi,
    macd:             indicators.macd,
    ema20:            indicators.ema20,
    ema50:            indicators.ema50,
    ema200:           indicators.ema200 ?? indicators.ema50,
    bb:               indicators.bb,
    stoch:            indicators.stoch,
    adx:              indicators.adx,
    atr:              indicators.atr,
    patterns:         indicators.patterns,
    newsSentiment:    sentiment,
    ragContext:       context,
    accuracyContext:  accuracy,
    tradingContext,
    session:          getSessionDescription(utcHour),
    sessionRating,
    higherTfTrend,
    dailyTrend,
    weeklyTrend,
    tradingStyle,
    keyLevels,
    atrTrend,
    upcomingNews,
    structureContext,
    // Strategy-engine decision passed explicitly
    decidedSignal:    strategyDecision.signal,
    strategyReasons:  strategyDecision.reasons,
    strategyBlockers: strategyDecision.blockers,
    suggestedSL:      strategyDecision.suggestedSL,
    suggestedTP:      strategyDecision.suggestedTP,
  });

  // ── Post-explain hard news gate ──────────────────────────────────────────
  if (upcomingEvts.length > 0 && result.autoTradeRecommended) {
    result.autoTradeRecommended = false;
    const labels = upcomingEvts.map((e) => `${e.country} ${e.title}`).join(', ');
    result.keyRisks = [
      ...(result.keyRisks ?? []),
      `High-impact news imminent (${newsWindow}min window): ${labels}`,
    ];
  }

  // ── Bias alignment flags ──────────────────────────────────────────────────
  // Used for: (1) quality tier, (2) confidence adjustment, (3) telemetry logging.
  // Bias no longer blocks trades — it adjusts confidence score only.
  if (result.signal !== 'HOLD') {
    dailyAligned  = !(
      (result.signal === 'SELL' && dailyBiasDir  === 'bullish') ||
      (result.signal === 'BUY'  && dailyBiasDir  === 'bearish')
    );
    weeklyAligned = !(
      (result.signal === 'SELL' && weeklyBiasDir === 'bullish') ||
      (result.signal === 'BUY'  && weeklyBiasDir === 'bearish')
    );

    // Higher-TF bias for scalp uses 1H/4H macro bias; swing uses weekly
    const htfBiasForAdjustment = tradingStyle === 'scalp'
      ? (scalpMacroBias ?? htfBiasDir)
      : weeklyBiasDir;
    const biasAlignedForSignal = !(
      (result.signal === 'SELL' && htfBiasForAdjustment === 'bullish') ||
      (result.signal === 'BUY'  && htfBiasForAdjustment === 'bearish')
    );

    // Bias confidence adjustment — regime-specific learned value (never hardcoded)
    const biasIsNeutralForAdj = htfBiasForAdjustment === 'neutral';
    const learnedBiasAdj = getLearnedBiasAdjustment(biasAlignedForSignal, biasIsNeutralForAdj, activeProfile);
    result.confidence = Math.max(0, Math.min(100, result.confidence + learnedBiasAdj));

    if (!biasAlignedForSignal) {
      const profileLabel = regimeProfile ? `${preliminaryRegime}-regime` : 'global';
      result.keyRisks = [
        ...(result.keyRisks ?? []),
        `Counter-trend vs ${tradingStyle === 'scalp' ? '1H/4H' : 'weekly'} bias (${htfBiasForAdjustment}) — ${profileLabel} learned adj: ${learnedBiasAdj >= 0 ? '+' : ''}${learnedBiasAdj.toFixed(1)}pts`,
      ];
    }

    // Dynamic confidence blend — regime-specific weights supplement Groq's score
    const finalRegime = detectMarketRegime(indicators, structureObj, atrTrend, upcomingEvts.length > 0);
    const dynamicConf = computeDynamicConfidence({
      triggerTypes:         execTriggerTypes,
      session:              utcHourToSession(utcHour),
      regime:               finalRegime,
      biasAligned:          biasAlignedForSignal,
      biasIsNeutral:        biasIsNeutralForAdj,
      obQualityScore:       scoreOBQuality(structureObj, lastCandle.close, result.signal as 'BUY' | 'SELL'),
      fvgQualityScore:      scoreFVGQuality(structureObj, lastCandle.close, result.signal as 'BUY' | 'SELL'),
      displacementStrength: scoreDisplacement(candles, indicators),
      clusterExpectancy:    null,
    }, activeProfile);
    result.confidence = blendConfidence(result.confidence, dynamicConf, activeProfile?.is_reliable ?? false);
  }

  // ── Assign quality tier ───────────────────────────────────────────────────
  const qualityTier = assignQualityTier(
    result.signal,
    result.confluenceScore,
    result.confidence,
    weeklyAligned,
    dailyAligned,
  );

  // Only A+ signals are eligible for auto-trade
  if (qualityTier !== 'A+' && result.autoTradeRecommended) {
    result.autoTradeRecommended = false;
    result.keyRisks = [...(result.keyRisks ?? []),
      `Auto-trade blocked: ${qualityTier} tier signal — A+ required (needs confluence ≥7, confidence ≥75, daily+weekly aligned)`,
    ];
  }

  // ── Compute pip distances ─────────────────────────────────────────────────
  const pipsToSL   = toPips(validPair, Math.abs(result.entry - result.stopLoss));
  const pipsToTP   = toPips(validPair, Math.abs(result.takeProfit - result.entry));
  const validUntil = new Date(Date.now() + VALIDITY_MS[validTf]);

  // Derive bias state for telemetry
  const htfBiasForTelemetry = tradingStyle === 'scalp'
    ? (scalpMacroBias ?? htfBiasDir)
    : weeklyBiasDir;
  const biasAlignedForTelemetry = !(
    (result.signal === 'SELL' && htfBiasForTelemetry === 'bullish') ||
    (result.signal === 'BUY'  && htfBiasForTelemetry === 'bearish')
  );

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
    weeklyTrend,
    qualityTier,
  });

  // ── Auto-trade trigger (non-blocking) ────────────────────────────────────
  triggerAutoTrade(signal as unknown as ISignal).catch((e) =>
    console.error('[signal.service] triggerAutoTrade error:', e)
  );

  // ── Trade telemetry (non-blocking, never throws) ──────────────────────────
  if (result.signal !== 'HOLD') {
    logTradeEvent({
      userId,
      signalId:          String(signal._id),
      symbol:            validPair,
      timeframe:         validTf,
      tradingStyle,
      utcHour,
      indicators,
      structure:         structureObj,
      atrTrend,
      signal:            result.signal as 'BUY' | 'SELL',
      entryPrice:        result.entry,
      stopLossPrice:     result.stopLoss,
      takeProfitPrice:   result.takeProfit,
      confidenceScore:   result.confidence,
      higherTfBias:      htfBiasForTelemetry,
      biasAligned:       biasAlignedForTelemetry,
      obQualityScore:    scoreOBQuality(structureObj, lastCandle.close, result.signal as 'BUY' | 'SELL'),
      fvgQualityScore:   scoreFVGQuality(structureObj, lastCandle.close, result.signal as 'BUY' | 'SELL'),
      displacementStrength: scoreDisplacement(candles, indicators),
      structureScore:    strategyDecision.confluenceScore * 12,  // 0–96 mapped to rough 0–100
      triggerTypesFired: strategyDecision.reasons
        .filter((r) => r.startsWith('[SCALP-EXEC]') || r.startsWith('Execution trigger'))
        .map((r) => r.split(':')[0].replace('[SCALP-EXEC] ', '').trim()),
    }).catch(() => { /* telemetry is always non-fatal */ });
  }

  return signal;
}

// ─── Synthetic HOLD (no Groq call) ────────────────────────────────────────────
async function _syntheticHold(
  userId:        Types.ObjectId,
  pair:          ValidPair,
  timeframe:     ValidTimeframe,
  price:         number,
  sessionRating: SessionRating,
  indicators:    Indicators,
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
    qualityTier: 'C' as const,
  }) as unknown as ISignal;
}

// ─── getSignalHistory ─────────────────────────────────────────────────────────

export async function getSignalHistory(
  userId: string,
  pair:   string,
): Promise<ISignal[]> {
  if (!VALID_PAIRS.includes(pair as ValidPair)) throw new Error(`Invalid pair: ${pair}`);
  return Signal.find({ userId: new Types.ObjectId(userId), pair })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
}
