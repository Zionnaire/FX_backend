// src/services/portfolioRisk.service.ts
// Live portfolio risk exposure calculator.
//
// Queries all open trades and computes:
//   - Total risk as % of account balance (sum of (entry - SL) × size for each open trade)
//   - Correlated exposure warnings (two or more trades on dollar-related pairs in same direction)
//   - Maximum simultaneous loss scenario (all SLs hit)
//   - Risk budget usage against the user's maxDailyLossPct setting

import { Types } from 'mongoose';
import Trade from '../models/Trade.model';
import User from '../models/User.model';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpenPositionRisk {
  tradeId:     string;
  pair:        string;
  direction:   'BUY' | 'SELL';
  entry:       number;
  stopLoss:    number | null;
  size:        number;           // lots
  riskUSD:     number;           // estimated loss if SL hit
  riskPct:     number;           // riskUSD as % of balance
}

export interface PortfolioRiskSnapshot {
  timestamp:            string;
  account_balance:      number;
  open_trades:          number;
  positions:            OpenPositionRisk[];
  total_risk_pct:       number;       // sum of all position risks
  total_max_loss_usd:   number;       // all SLs hit simultaneously
  risk_budget_limit_pct: number;      // from user.autoTrade.maxDailyLossPct
  risk_budget_used_pct: number;       // total_risk_pct / risk_budget_limit_pct × 100
  is_over_budget:       boolean;
  correlation_warnings: string[];     // e.g. "EUR/USD + GBP/USD both SELL = 2× USD short"
  exposure_by_pair:     Record<string, { direction: string; risk_pct: number }>;
  recommendation:       string;
}

// Correlated groups: if 2+ pairs in the same group trade the same direction = double exposure
const CORRELATION_GROUPS: string[][] = [
  ['EUR/USD', 'GBP/USD'],   // both inverse USD
  ['EUR/USD', 'XAU/USD'],   // gold often inverse USD too
  ['GBP/USD', 'XAU/USD'],
];

const PIP_VALUE_PER_LOT: Record<string, number> = {
  'XAU/USD': 1,    // $1 per 0.01 move × 100 = $10 per 1R (approx; varies)
  'GBP/USD': 10,
  'EUR/USD': 10,
  'USD/JPY': 9.3,
};

const PIP_SIZE: Record<string, number> = {
  'XAU/USD': 0.01,
  'GBP/USD': 0.0001,
  'EUR/USD': 0.0001,
  'USD/JPY': 0.01,
};

// ─── Main function ────────────────────────────────────────────────────────────

export async function getPortfolioRisk(userId: string): Promise<PortfolioRiskSnapshot> {
  const userOid = new Types.ObjectId(userId);

  const [user, openTrades] = await Promise.all([
    User.findById(userOid).lean(),
    Trade.find({ userId: userOid, status: 'open' }).lean(),
  ]);

  const balance      = (user as any)?.simulationBalance ?? 10000;
  const budgetLimitPct = (user as any)?.autoTrade?.maxDailyLossPct ?? 5;

  const positions: OpenPositionRisk[] = openTrades.map((t) => {
    const riskUSD = _estimateRiskUSD(t.pair, t.type, t.entry, (t as any).stopLoss, t.size);
    return {
      tradeId:   String(t._id),
      pair:      t.pair,
      direction: t.type,
      entry:     t.entry,
      stopLoss:  (t as any).stopLoss ?? null,
      size:      t.size,
      riskUSD:   parseFloat(riskUSD.toFixed(2)),
      riskPct:   balance > 0 ? parseFloat(((riskUSD / balance) * 100).toFixed(2)) : 0,
    };
  });

  const totalMaxLossUSD = positions.reduce((s, p) => s + p.riskUSD, 0);
  const totalRiskPct    = balance > 0 ? parseFloat(((totalMaxLossUSD / balance) * 100).toFixed(2)) : 0;
  const budgetUsedPct   = budgetLimitPct > 0 ? parseFloat(((totalRiskPct / budgetLimitPct) * 100).toFixed(1)) : 0;

  // Correlation warnings
  const warnings: string[] = [];
  for (const group of CORRELATION_GROUPS) {
    const inGroup = positions.filter((p) => group.includes(p.pair));
    if (inGroup.length < 2) continue;
    const dirs = [...new Set(inGroup.map((p) => p.direction))];
    if (dirs.length === 1) {
      const [d] = dirs;
      warnings.push(`${inGroup.map((p) => p.pair).join(' + ')} both ${d} = correlated exposure — combined risk: ${inGroup.reduce((s, p) => s + p.riskPct, 0).toFixed(1)}%`);
    }
  }

  // Per-pair summary
  const exposureByPair: Record<string, { direction: string; risk_pct: number }> = {};
  for (const p of positions) {
    const existing = exposureByPair[p.pair];
    if (!existing) {
      exposureByPair[p.pair] = { direction: p.direction, risk_pct: p.riskPct };
    } else {
      existing.risk_pct += p.riskPct;
      if (existing.direction !== p.direction) existing.direction = 'MIXED';
    }
  }

  const recommendation = _buildRecommendation(totalRiskPct, budgetLimitPct, warnings);

  return {
    timestamp:             new Date().toISOString(),
    account_balance:       balance,
    open_trades:           openTrades.length,
    positions,
    total_risk_pct:        totalRiskPct,
    total_max_loss_usd:    parseFloat(totalMaxLossUSD.toFixed(2)),
    risk_budget_limit_pct: budgetLimitPct,
    risk_budget_used_pct:  budgetUsedPct,
    is_over_budget:        totalRiskPct >= budgetLimitPct,
    correlation_warnings:  warnings,
    exposure_by_pair:      exposureByPair,
    recommendation,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _estimateRiskUSD(
  pair: string, direction: string, entry: number, sl: number | null, lots: number,
): number {
  if (!sl || sl <= 0) return 0;
  const pipSz  = PIP_SIZE[pair] ?? 0.0001;
  const pipVal = PIP_VALUE_PER_LOT[pair] ?? 10;
  const slPips = Math.abs(entry - sl) / pipSz;
  return slPips * pipVal * lots;
}

function _buildRecommendation(riskPct: number, limitPct: number, warnings: string[]): string {
  const usedRatio = riskPct / limitPct;
  if (riskPct >= limitPct)  return '🚫 STOP — daily risk budget fully consumed. No new trades.';
  if (usedRatio >= 0.80)    return '⚠️ Caution — 80%+ of risk budget used. Reduce size on next trade.';
  if (warnings.length > 0)  return '⚠️ Correlated exposure detected — avoid adding to same direction.';
  if (usedRatio >= 0.50)    return '✅ Moderate exposure — manage open trades before adding new ones.';
  return '✅ Risk within acceptable bounds.';
}
