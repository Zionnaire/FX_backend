// src/services/backtest.service.ts
// Sliding-window backtesting engine.
// For each candle N in the history, runs the deterministic strategy engine on
// candles[0..N], then simulates the resulting trade on candles[N+1..N+MAX_HOLD]
// using intrabar highs and lows to detect TP/SL hits accurately.
// Returns aggregate win rate, expectancy, RR distribution, and per-session stats.

import { getOHLCV } from './chart.service';
import { computeAll } from './indicator.service';
import { analyzeMarketStructure } from './structure.service';
import { runStrategy, extractBias } from './strategy.service';
import { atr as calcAtr } from '../utils/indicators.utils';
import { IOHLCV, ValidPair, ValidTimeframe } from '../types/chart.types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BacktestTrade {
  signal:          'BUY' | 'SELL';
  entryTime:       number;
  entry:           number;
  stopLoss:        number;
  takeProfit:      number;
  outcome:         'win' | 'loss' | 'expired';
  exitPrice:       number | null;
  pips:            number;
  rr:              number;        // actual RR achieved (negative if loss)
  confluenceScore: number;
  session:         string;
  structureTrend:  string;
}

export interface BacktestResult {
  pair:           ValidPair;
  timeframe:      ValidTimeframe;
  candlesAnalysed: number;
  totalSignals:   number;
  wins:           number;
  losses:         number;
  expired:        number;
  winRate:        number;
  expectancy:     number;   // (winRate × avgWin) − (lossRate × avgLoss)
  avgWin:         number;   // average winning RR
  avgLoss:        number;   // average losing RR (positive: e.g. 1.0 = lost 1R)
  maxConsecutiveLosses: number;
  profitFactor:   number;   // sum wins / sum losses
  bySession: {
    session:    string;
    signals:    number;
    wins:       number;
    winRate:    number;
  }[];
  byConfluence: {
    score:      number;
    signals:    number;
    wins:       number;
    winRate:    number;
  }[];
  trades:         BacktestTrade[];
}

// ─── Session label ────────────────────────────────────────────────────────────

function sessionLabel(unixTs: number): string {
  const h = new Date(unixTs * 1000).getUTCHours();
  if (h >= 22 || h < 7)  return 'Asian';
  if (h >= 7  && h < 12) return 'London Open';
  if (h >= 12 && h < 17) return 'London-NY Overlap';
  return 'New York';
}

// ─── Pip size ─────────────────────────────────────────────────────────────────

function pipSize(pair: string): number {
  if (pair === 'USD/JPY') return 0.01;
  if (pair === 'XAU/USD') return 0.01;
  return 0.0001;
}

// ─── Simulate single trade on future candles ──────────────────────────────────

function simulateTrade(
  signal:     'BUY' | 'SELL',
  entry:      number,
  stopLoss:   number,
  takeProfit: number,
  future:     IOHLCV[],
  pair:       string,
): Pick<BacktestTrade, 'outcome' | 'exitPrice' | 'pips' | 'rr'> {
  const ps      = pipSize(pair);
  const rUnit   = Math.abs(entry - stopLoss);

  for (const c of future) {
    if (signal === 'BUY') {
      if (c.high >= takeProfit) {
        const pips = Math.round((takeProfit - entry) / ps);
        return { outcome: 'win',  exitPrice: takeProfit, pips, rr: rUnit > 0 ? parseFloat(((takeProfit - entry) / rUnit).toFixed(2)) : 0 };
      }
      if (c.low <= stopLoss) {
        const pips = Math.round((stopLoss - entry) / ps); // negative
        return { outcome: 'loss', exitPrice: stopLoss,   pips, rr: rUnit > 0 ? -parseFloat(((entry - stopLoss) / rUnit).toFixed(2)) : 0 };
      }
    } else {
      if (c.low <= takeProfit) {
        const pips = Math.round((entry - takeProfit) / ps);
        return { outcome: 'win',  exitPrice: takeProfit, pips, rr: rUnit > 0 ? parseFloat(((entry - takeProfit) / rUnit).toFixed(2)) : 0 };
      }
      if (c.high >= stopLoss) {
        const pips = Math.round((entry - stopLoss) / ps); // negative
        return { outcome: 'loss', exitPrice: stopLoss,   pips, rr: rUnit > 0 ? -parseFloat(((stopLoss - entry) / rUnit).toFixed(2)) : 0 };
      }
    }
  }

  return { outcome: 'expired', exitPrice: null, pips: 0, rr: 0 };
}

// ─── Main backtest ────────────────────────────────────────────────────────────

export async function runBacktest(
  pair:         ValidPair,
  timeframe:    ValidTimeframe,
  tradingStyle: 'scalp' | 'swing' = 'swing',
): Promise<BacktestResult> {
  const candles = await getOHLCV(pair, timeframe);

  const WARMUP    = 30;   // minimum candles needed to compute indicators
  const MAX_HOLD  = 20;   // max candles to hold a trade before expiring

  const trades: BacktestTrade[] = [];

  for (let i = WARMUP; i < candles.length - 2; i++) {
    const window = candles.slice(0, i + 1);
    const last   = window[window.length - 1];

    // Compute indicators + structure on this window
    const indicators = computeAll(window);
    if (!indicators || indicators.atr === 0) continue;

    const structure = analyzeMarketStructure(window);

    // ATR-rate-of-change for atrTrend
    let atrTrend: 'expanding' | 'contracting' | 'stable' = 'stable';
    if (window.length >= 20) {
      const prevAtr = calcAtr(window.slice(0, -5));
      if (prevAtr > 0) {
        const pct = (indicators.atr - prevAtr) / prevAtr;
        if (pct > 0.15)       atrTrend = 'expanding';
        else if (pct < -0.15) atrTrend = 'contracting';
      }
    }

    // Derive HTF bias from the current window's EMA stack (simplified, no external fetch)
    const ema200 = indicators.ema200 ?? indicators.ema50;
    const htfBias   = extractBias(last.close > ema200 ? 'BULLISH' : 'BEARISH');
    const dailyBias = extractBias(last.close > indicators.ema50 ? 'BULLISH' : 'BEARISH');
    // Weekly bias from EMA200 (best approximation without separate fetch)
    const weeklyBias = extractBias(last.close > ema200 ? 'BULLISH' : 'BEARISH');

    // UTC hour → session rating (simplified)
    const utcH  = new Date(last.time * 1000).getUTCHours();
    const sessionRating =
      (utcH >= 13 && utcH < 17) ? 'PRIME' :
      (utcH >= 7  && utcH < 20) ? 'ACTIVE' : 'AVOID';

    const decision = runStrategy(
      window, indicators, structure,
      sessionRating, htfBias, dailyBias, weeklyBias,
      pair, tradingStyle, atrTrend,
    );

    if (decision.signal === 'HOLD') continue;

    // Build SL/TP — use strategy suggestion or fallback to ATR multiples
    const entry = last.close;
    const isScalp = tradingStyle === 'scalp';
    const slMult  = isScalp ? 0.75 : 1.5;
    const tpMult  = isScalp ? 1.5  : 3.0;

    let stopLoss: number;
    let takeProfit: number;

    if (decision.signal === 'BUY') {
      stopLoss   = decision.suggestedSL ?? parseFloat((entry - indicators.atr * slMult).toFixed(5));
      takeProfit = decision.suggestedTP ?? parseFloat((entry + indicators.atr * tpMult).toFixed(5));
      // Ensure positive RR
      if (takeProfit <= entry || stopLoss >= entry) continue;
    } else {
      stopLoss   = decision.suggestedSL ?? parseFloat((entry + indicators.atr * slMult).toFixed(5));
      takeProfit = decision.suggestedTP ?? parseFloat((entry - indicators.atr * tpMult).toFixed(5));
      if (takeProfit >= entry || stopLoss <= entry) continue;
    }

    // Minimum RR check (1:1.5 for scalp, 1:2 for swing)
    const rr = Math.abs(takeProfit - entry) / Math.abs(stopLoss - entry);
    if (rr < (isScalp ? 1.5 : 2.0)) continue;

    // Simulate on subsequent candles
    const future = candles.slice(i + 1, i + 1 + MAX_HOLD);
    const result = simulateTrade(decision.signal, entry, stopLoss, takeProfit, future, pair);

    trades.push({
      signal:          decision.signal,
      entryTime:       last.time,
      entry,
      stopLoss,
      takeProfit,
      outcome:         result.outcome,
      exitPrice:       result.exitPrice,
      pips:            result.pips,
      rr:              result.rr,
      confluenceScore: decision.confluenceScore,
      session:         sessionLabel(last.time),
      structureTrend:  structure.trend,
    });
  }

  // ── Aggregate statistics ──────────────────────────────────────────────────

  const closed = trades.filter((t) => t.outcome !== 'expired');
  const wins   = closed.filter((t) => t.outcome === 'win');
  const losses = closed.filter((t) => t.outcome === 'loss');

  const winRate = closed.length > 0
    ? parseFloat(((wins.length / closed.length) * 100).toFixed(1))
    : 0;

  const avgWin  = wins.length  > 0 ? parseFloat((wins.reduce((s, t) => s + t.rr, 0) / wins.length).toFixed(2))  : 0;
  const avgLoss = losses.length > 0 ? parseFloat((losses.reduce((s, t) => s + Math.abs(t.rr), 0) / losses.length).toFixed(2)) : 0;

  const lossRate = 1 - winRate / 100;
  const expectancy = parseFloat(((winRate / 100) * avgWin - lossRate * avgLoss).toFixed(3));

  const profitFactor = avgLoss === 0 ? (avgWin > 0 ? 99 : 0)
    : parseFloat((avgWin * wins.length / (avgLoss * losses.length)).toFixed(2));

  // Max consecutive losses
  let maxConsec = 0, curConsec = 0;
  for (const t of closed) {
    if (t.outcome === 'loss') { curConsec++; maxConsec = Math.max(maxConsec, curConsec); }
    else curConsec = 0;
  }

  // By session
  const sessionMap = new Map<string, { signals: number; wins: number }>();
  for (const t of closed) {
    const s = sessionMap.get(t.session) ?? { signals: 0, wins: 0 };
    s.signals++;
    if (t.outcome === 'win') s.wins++;
    sessionMap.set(t.session, s);
  }
  const bySession = Array.from(sessionMap.entries()).map(([session, v]) => ({
    session,
    signals:  v.signals,
    wins:     v.wins,
    winRate:  v.signals > 0 ? parseFloat(((v.wins / v.signals) * 100).toFixed(1)) : 0,
  }));

  // By confluence score
  const confMap = new Map<number, { signals: number; wins: number }>();
  for (const t of closed) {
    const entry2 = confMap.get(t.confluenceScore) ?? { signals: 0, wins: 0 };
    entry2.signals++;
    if (t.outcome === 'win') entry2.wins++;
    confMap.set(t.confluenceScore, entry2);
  }
  const byConfluence = Array.from(confMap.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([score, v]) => ({
      score,
      signals:  v.signals,
      wins:     v.wins,
      winRate:  v.signals > 0 ? parseFloat(((v.wins / v.signals) * 100).toFixed(1)) : 0,
    }));

  return {
    pair,
    timeframe,
    candlesAnalysed: candles.length,
    totalSignals:    trades.length,
    wins:            wins.length,
    losses:          losses.length,
    expired:         trades.filter((t) => t.outcome === 'expired').length,
    winRate,
    expectancy,
    avgWin,
    avgLoss,
    maxConsecutiveLosses: maxConsec,
    profitFactor,
    bySession,
    byConfluence,
    trades: trades.slice(-50), // return last 50 for inspection
  };
}
