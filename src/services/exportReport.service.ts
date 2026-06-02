// src/services/exportReport.service.ts
// Trade data export engine.
//
// Provides two export formats:
//   1. CSV  — all closed trades as a spreadsheet-compatible flat file
//   2. HTML — a self-contained print-ready performance report
//
// Both are generated from Trade + TradeEvent records.
// No external dependencies required.

import { Types } from 'mongoose';
import Trade from '../models/Trade.model';
import { ITrade } from '../types/trade.types';

// ─── CSV Export ───────────────────────────────────────────────────────────────

export async function exportTradesCSV(userId: string): Promise<string> {
  const userOid = new Types.ObjectId(userId);
  const trades  = await Trade.find({ userId: userOid })
    .sort({ createdAt: -1 })
    .lean() as ITrade[];

  const header = [
    'Date', 'Pair', 'Direction', 'Entry', 'Exit', 'Stop Loss', 'Take Profit',
    'Size (lots)', 'PnL (USD)', 'R:R', 'Status', 'Duration', 'Source', 'Notes',
  ].join(',');

  const rows = trades.map((t) => [
    _fmt((t as any).createdAt),
    t.pair,
    t.type,
    t.entry,
    (t as any).exit   ?? '',
    (t as any).stopLoss   ?? '',
    (t as any).takeProfit ?? '',
    t.size,
    (t as any).pnl ?? '',
    (t as any).rr  ?? '',
    t.status,
    (t as any).duration ?? '',
    t.source ?? 'manual',
    _escape(t.notes ?? ''),
  ].join(','));

  return [header, ...rows].join('\n');
}

// ─── HTML Performance Report ──────────────────────────────────────────────────

export async function exportPerformanceHTML(userId: string): Promise<string> {
  const userOid = new Types.ObjectId(userId);
  const trades  = await Trade.find({ userId: userOid, status: { $in: ['win', 'loss'] } })
    .sort({ createdAt: 1 })
    .lean() as ITrade[];

  const stats = _computeStats(trades);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Trading Performance Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f1117; color: #e2e8f0; padding: 32px; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; color: #f1f5f9; }
  .subtitle { font-size: 13px; color: #64748b; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: #1e2130; border-radius: 10px; padding: 20px; }
  .card-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #64748b; margin-bottom: 6px; }
  .card-value { font-size: 28px; font-weight: 700; }
  .green { color: #22c55e; } .red { color: #ef4444; } .blue { color: #3b82f6; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 10px 12px; background: #1e2130; color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  td { padding: 10px 12px; border-bottom: 1px solid #1e2130; }
  tr:hover td { background: #1a1f2e; }
  .win { color: #22c55e; } .loss { color: #ef4444; }
  h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #f1f5f9; }
  .section { margin-bottom: 32px; }
  @media print { body { background: white; color: black; } .card { background: #f8fafc; } th { background: #f1f5f9; color: #475569; } }
</style>
</head>
<body>
<h1>Performance Report</h1>
<p class="subtitle">Generated ${new Date().toUTCString()} · ${trades.length} closed trades</p>

<div class="grid">
  <div class="card"><div class="card-label">Win Rate</div><div class="card-value ${stats.winRate >= 50 ? 'green' : 'red'}">${stats.winRate.toFixed(1)}%</div></div>
  <div class="card"><div class="card-label">Expectancy</div><div class="card-value ${stats.expectancy >= 0 ? 'green' : 'red'}">${stats.expectancy.toFixed(2)}R</div></div>
  <div class="card"><div class="card-label">Profit Factor</div><div class="card-value ${stats.profitFactor >= 1 ? 'green' : 'red'}">${stats.profitFactor.toFixed(2)}</div></div>
  <div class="card"><div class="card-label">Total Trades</div><div class="card-value blue">${trades.length}</div></div>
  <div class="card"><div class="card-label">Total P&L</div><div class="card-value ${stats.totalPnl >= 0 ? 'green' : 'red'}">${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}</div></div>
  <div class="card"><div class="card-label">Max Consec. Losses</div><div class="card-value red">${stats.maxConsecLosses}</div></div>
</div>

<div class="section">
<h2>Recent Trades</h2>
<table>
<thead><tr><th>Date</th><th>Pair</th><th>Dir</th><th>Entry</th><th>Exit</th><th>P&L</th><th>R:R</th><th>Outcome</th></tr></thead>
<tbody>
${trades.slice(-30).reverse().map((t) => `
  <tr>
    <td>${_fmt((t as any).createdAt)}</td>
    <td>${t.pair}</td>
    <td>${t.type}</td>
    <td>${t.entry}</td>
    <td>${(t as any).exit ?? '—'}</td>
    <td class="${(t as any).pnl >= 0 ? 'win' : 'loss'}">${(t as any).pnl != null ? ((t as any).pnl >= 0 ? '+' : '') + '$' + Number((t as any).pnl).toFixed(2) : '—'}</td>
    <td>${(t as any).rr ?? '—'}</td>
    <td class="${t.status === 'win' ? 'win' : 'loss'}">${t.status.toUpperCase()}</td>
  </tr>`).join('')}
</tbody>
</table>
</div>
</body>
</html>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _computeStats(trades: ITrade[]) {
  const wins   = trades.filter((t) => t.status === 'win');
  const losses = trades.filter((t) => t.status === 'loss');
  const n      = trades.length;

  const winRate     = n > 0 ? (wins.length / n) * 100 : 0;
  const totalPnl    = trades.reduce((s, t) => s + ((t as any).pnl ?? 0), 0);
  const grossWin    = wins.reduce((s, t) => s + ((t as any).pnl ?? 0), 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + ((t as any).pnl ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;

  const avgWin  = wins.length  > 0 ? grossWin  / wins.length  : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const lossRate = 1 - winRate / 100;
  const expectancy = n > 0 ? (winRate / 100) * avgWin - lossRate * avgLoss : 0;

  let maxConsecLosses = 0, cur = 0;
  for (const t of trades) {
    if (t.status === 'loss') { cur++; maxConsecLosses = Math.max(maxConsecLosses, cur); }
    else cur = 0;
  }

  return { winRate, expectancy, profitFactor, totalPnl, maxConsecLosses };
}

function _fmt(d: Date | undefined): string {
  if (!d) return '';
  return new Date(d).toISOString().slice(0, 10);
}

function _escape(s: string): string {
  return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}
