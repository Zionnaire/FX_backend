// src/services/monteCarlo.service.ts
// Monte Carlo robustness simulation.
//
// Takes the user's historical closed trade R-multiples and shuffles them
// N × iterations to generate a distribution of equity curve outcomes.
// Answers: "Given my real historical trades, how bad could it plausibly get?"
//
// Unlike the backtest (which is path-dependent on the original sequence),
// Monte Carlo randomises the trade order to stress-test against adverse clustering.
//
// No new R values are invented — it only reshuffles the user's actual trades.

import { Types } from 'mongoose';
import TradeEvent, { ITradeEvent } from '../models/TradeEvent.model';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MonteCarloOptions {
  iterations:      number;    // 500–5000; default 1000
  lookback_days:   number;    // default 90
  initial_balance: number;    // default 10000
  ruin_threshold:  number;    // default 0.50 (50% drawdown = ruin)
}

export interface MonteCarloResult {
  iterations:          number;
  sample_trades:       number;     // trades used as input
  initial_balance:     number;
  // Return distribution (as % of initial_balance)
  median_return_pct:   number;
  p5_return_pct:       number;     // worst 5% of outcomes
  p25_return_pct:      number;
  p75_return_pct:      number;
  p95_return_pct:      number;
  // Drawdown distribution
  max_drawdown_p50:    number;     // median max drawdown %
  max_drawdown_p75:    number;
  max_drawdown_p90:    number;
  max_drawdown_p95:    number;
  // Risk
  ruin_probability:    number;     // % of simulations hitting ruin_threshold
  expected_win_rate:   number;     // sample win rate
  expected_expectancy: number;     // mean R
  // Visualization subset
  equity_curves:       number[][];  // 50 representative curves (balance per trade)
  risk_of_loss_pct:    number;      // % of sims ending below initial_balance
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function runMonteCarlo(
  userId:  string,
  options: Partial<MonteCarloOptions> = {},
): Promise<MonteCarloResult> {
  const {
    iterations     = 1000,
    lookback_days  = 90,
    initial_balance = 10000,
    ruin_threshold  = 0.50,
  } = options;

  const since   = new Date(Date.now() - lookback_days * 86_400_000);
  const userOid = new Types.ObjectId(userId);

  const events = await TradeEvent.find({
    user_id:   userOid,
    timestamp: { $gte: since },
    outcome:   { $in: ['win', 'loss', 'breakeven'] },
  }).lean() as ITradeEvent[];

  if (events.length < 10) {
    return _insufficientDataResult(iterations, events.length, initial_balance);
  }

  // Build R-multiple array from real trade history
  const rMultiples = events.map((e) =>
    e.outcome === 'win' ? e.rr_ratio : e.outcome === 'breakeven' ? 0 : -1,
  );

  const wins  = events.filter((e) => e.outcome === 'win').length;
  const n     = events.length;
  const winRate   = (wins / n) * 100;
  const expectancy = rMultiples.reduce((s, r) => s + r, 0) / n;

  // Risk fraction: how much of balance is risked per trade
  // Use 2% as default (standard money management)
  const riskFraction = 0.02;

  const finalBalances: number[] = [];
  const maxDrawdowns:  number[] = [];
  const equityCurvesSample: number[][] = [];

  const sampleEvery = Math.max(1, Math.floor(iterations / 50));

  for (let iter = 0; iter < iterations; iter++) {
    const shuffled = _shuffle([...rMultiples]);
    const { finalBalance, maxDrawdownPct } = _simulatePath(
      shuffled, initial_balance, riskFraction, ruin_threshold,
    );
    finalBalances.push(finalBalance);
    maxDrawdowns.push(maxDrawdownPct);

    if (iter % sampleEvery === 0) {
      const curve = _buildEquityCurve(shuffled, initial_balance, riskFraction);
      equityCurvesSample.push(curve);
    }
  }

  finalBalances.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);

  const ruinCount   = finalBalances.filter((b) => b <= initial_balance * (1 - ruin_threshold)).length;
  const lossCount   = finalBalances.filter((b) => b < initial_balance).length;

  return {
    iterations,
    sample_trades:       n,
    initial_balance,
    median_return_pct:   _pctChange(initial_balance, _percentile(finalBalances, 50)),
    p5_return_pct:       _pctChange(initial_balance, _percentile(finalBalances, 5)),
    p25_return_pct:      _pctChange(initial_balance, _percentile(finalBalances, 25)),
    p75_return_pct:      _pctChange(initial_balance, _percentile(finalBalances, 75)),
    p95_return_pct:      _pctChange(initial_balance, _percentile(finalBalances, 95)),
    max_drawdown_p50:    parseFloat(_percentile(maxDrawdowns, 50).toFixed(2)),
    max_drawdown_p75:    parseFloat(_percentile(maxDrawdowns, 75).toFixed(2)),
    max_drawdown_p90:    parseFloat(_percentile(maxDrawdowns, 90).toFixed(2)),
    max_drawdown_p95:    parseFloat(_percentile(maxDrawdowns, 95).toFixed(2)),
    ruin_probability:    parseFloat(((ruinCount / iterations) * 100).toFixed(2)),
    expected_win_rate:   parseFloat(winRate.toFixed(1)),
    expected_expectancy: parseFloat(expectancy.toFixed(3)),
    equity_curves:       equityCurvesSample,
    risk_of_loss_pct:    parseFloat(((lossCount / iterations) * 100).toFixed(1)),
  };
}

// ─── Simulation helpers ───────────────────────────────────────────────────────

function _simulatePath(
  rMultiples:    number[],
  startBalance:  number,
  riskFraction:  number,
  ruinThreshold: number,
): { finalBalance: number; maxDrawdownPct: number } {
  let balance = startBalance;
  let peak    = startBalance;
  let maxDD   = 0;
  const ruinLevel = startBalance * (1 - ruinThreshold);

  for (const r of rMultiples) {
    const risk    = balance * riskFraction;
    balance      += risk * r;
    if (balance > peak) peak = balance;
    const dd = (peak - balance) / peak * 100;
    if (dd > maxDD) maxDD = dd;
    if (balance <= ruinLevel) break;
  }

  return { finalBalance: balance, maxDrawdownPct: parseFloat(maxDD.toFixed(2)) };
}

function _buildEquityCurve(
  rMultiples:   number[],
  startBalance: number,
  riskFraction: number,
): number[] {
  const curve: number[] = [startBalance];
  let balance = startBalance;
  for (const r of rMultiples) {
    balance += balance * riskFraction * r;
    curve.push(parseFloat(balance.toFixed(2)));
  }
  return curve;
}

function _shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function _percentile(sorted: number[], p: number): number {
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function _pctChange(start: number, end: number): number {
  return parseFloat((((end - start) / start) * 100).toFixed(2));
}

function _insufficientDataResult(
  iterations: number, n: number, initialBalance: number,
): MonteCarloResult {
  return {
    iterations, sample_trades: n, initial_balance: initialBalance,
    median_return_pct: 0, p5_return_pct: 0, p25_return_pct: 0,
    p75_return_pct: 0, p95_return_pct: 0,
    max_drawdown_p50: 0, max_drawdown_p75: 0, max_drawdown_p90: 0, max_drawdown_p95: 0,
    ruin_probability: 0, expected_win_rate: 0, expected_expectancy: 0,
    equity_curves: [], risk_of_loss_pct: 0,
  };
}
