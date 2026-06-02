// src/services/tradeEvent.service.ts
// Telemetry logging layer.
// Called once per non-HOLD signal to create an immutable TradeEvent record.
// Also provides outcome updates when signalAccuracy detects a TP/SL hit.

import { Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import TradeEvent, { ITradeEvent, MarketRegime } from '../models/TradeEvent.model';
import { onTradeClose } from './onlineLearning.service';
import { IOHLCV, ValidPair, ValidTimeframe } from '../types/chart.types';
import { Indicators } from './indicator.service';
import { MarketStructure } from './structure.service';
import { TradingBias } from './strategy.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TradeEventInput {
  userId:          string;
  signalId:        string;
  symbol:          ValidPair;
  timeframe:       ValidTimeframe;
  tradingStyle:    'scalp' | 'swing';
  utcHour:         number;
  indicators:      Indicators;
  structure:       MarketStructure;
  atrTrend:        'expanding' | 'contracting' | 'stable';
  signal:          'BUY' | 'SELL';
  entryPrice:      number;
  stopLossPrice:   number;
  takeProfitPrice: number;
  confidenceScore: number;
  // Bias info
  higherTfBias:    TradingBias;  // swing HTF or scalp 1H/4H macro bias
  biasAligned:     boolean;
  // Optional enrichment
  triggerTypesFired?:    string[];
  triggerStrengthScores?: Record<string, number>;
  structureScore?:       number;
  obQualityScore?:       number;
  fvgQualityScore?:      number;
  displacementStrength?: number;
  retestDistanceScore?:  number;
  spreadAtEntry?:        number;
  notes?:                string;
}

// ─── Session label ────────────────────────────────────────────────────────────

export function utcHourToSession(h: number): string {
  if (h >= 22 || h < 7)  return 'Asian';
  if (h >= 7  && h < 12) return 'London Open';
  if (h >= 12 && h < 17) return 'London-NY Overlap';
  return 'New York';
}

// ─── Market regime detection ──────────────────────────────────────────────────
// Uses ADX, BB width, ATR trend, and structure context.

export function detectMarketRegime(
  indicators: Indicators,
  structure:  MarketStructure,
  atrTrend:   'expanding' | 'contracting' | 'stable',
  hasNews:    boolean,
): MarketRegime {
  if (hasNews) return 'news';

  const { adx, bb } = indicators;
  const bbWidth = bb.mid > 0 ? (bb.upper - bb.lower) / bb.mid : 0;

  // Expansion: strong ADX + ATR expanding (big directional move)
  if (adx > 25 && atrTrend === 'expanding') return 'expansion';

  // Compression: ATR contracting + narrow BB (energy coiling)
  if (atrTrend === 'contracting' && bbWidth < 0.008) return 'compression';

  // Trend: strong ADX + clear structure sequence
  if (adx > 25 && (structure.trend === 'bullish' || structure.trend === 'bearish')) return 'trend';

  return 'range';
}

// ─── Quality score helpers ────────────────────────────────────────────────────

export function scoreOBQuality(
  structure: MarketStructure,
  price:     number,
  signal:    'BUY' | 'SELL',
): number {
  const sideDir = signal === 'BUY' ? 'bullish' : 'bearish';
  const ob = structure.orderBlocks.find((b) => b.direction === sideDir);
  if (!ob) return 0;
  const obSize = Math.max(ob.high - ob.low, 0.000001);
  const mid    = (ob.high + ob.low) / 2;
  const dist   = Math.abs(price - mid) / obSize;
  return Math.max(0, Math.round(100 - dist * 60));
}

export function scoreFVGQuality(
  structure: MarketStructure,
  price:     number,
  signal:    'BUY' | 'SELL',
): number {
  const sideDir = signal === 'BUY' ? 'bullish' : 'bearish';
  const fvg = structure.fairValueGaps.find((g) => g.direction === sideDir);
  if (!fvg) return 0;
  const fvgSize = Math.max(fvg.top - fvg.bottom, 0.000001);
  const boundary = signal === 'BUY' ? fvg.bottom : fvg.top;
  const dist     = Math.abs(price - boundary) / fvgSize;
  return Math.max(0, Math.round(100 - dist * 50));
}

export function scoreDisplacement(candles: IOHLCV[], indicators: Indicators): number {
  if (indicators.atr <= 0 || candles.length === 0) return 0;
  const last = candles[candles.length - 1];
  const body  = Math.abs(last.close - last.open);
  return Math.min(100, Math.round((body / indicators.atr) * 50));
}

// ─── Log a new trade event ────────────────────────────────────────────────────

export async function logTradeEvent(input: TradeEventInput): Promise<ITradeEvent | null> {
  try {
    const rrRatio = Math.abs(input.takeProfitPrice - input.entryPrice)
      / Math.max(Math.abs(input.entryPrice - input.stopLossPrice), 0.000001);

    const event = await TradeEvent.create({
      trade_id:               uuidv4(),
      timestamp:              new Date(),
      user_id:                new Types.ObjectId(input.userId),
      symbol:                 input.symbol,
      timeframe:              input.timeframe,
      trading_style:          input.tradingStyle,
      session:                utcHourToSession(input.utcHour),
      market_regime:          detectMarketRegime(
        input.indicators, input.structure, input.atrTrend,
        false,  // news presence is unknown at this point; caller can pass notes
      ),
      higher_timeframe_bias:  input.higherTfBias,
      bias_aligned:           input.biasAligned,
      trigger_types_fired:    input.triggerTypesFired    ?? [],
      trigger_strength_scores:input.triggerStrengthScores ?? {},
      structure_score:        input.structureScore         ?? 0,
      ob_quality_score:       input.obQualityScore         ?? 0,
      fvg_quality_score:      input.fvgQualityScore        ?? 0,
      displacement_strength:  input.displacementStrength   ?? 0,
      retest_distance_score:  input.retestDistanceScore    ?? 0,
      spread_at_entry:        input.spreadAtEntry           ?? 0,
      atr_at_entry:           input.indicators.atr,
      risk_percent_used:      1,
      entry_price:            input.entryPrice,
      stop_loss_price:        input.stopLossPrice,
      take_profit_price:      input.takeProfitPrice,
      rr_ratio:               parseFloat(rrRatio.toFixed(2)),
      confidence_score:       input.confidenceScore,
      signal_direction:       input.signal,
      outcome:                'open',
      mfe:                    null,
      mae:                    null,
      time_to_exit_minutes:   null,
      signal_id:              input.signalId,
      notes:                  input.notes ?? '',
    });

    console.info(`[Telemetry] Logged trade event ${event.trade_id} for ${input.symbol} ${input.signal}`);
    return event;
  } catch (err) {
    // Non-fatal — telemetry must never break the signal flow
    console.warn('[Telemetry] logTradeEvent failed (non-fatal):', err);
    return null;
  }
}

// ─── Update outcome when a trade closes ──────────────────────────────────────
// Called by signalAccuracy.service.ts or tradeMonitor.service.ts.

export async function updateTradeOutcome(
  signalId:           string,
  outcome:            'win' | 'loss' | 'breakeven',
  mfe?:               number | null,
  mae?:               number | null,
  timeToExitMinutes?: number | null,
): Promise<void> {
  try {
    const updated = await TradeEvent.findOneAndUpdate(
      { signal_id: signalId, outcome: 'open' },
      { $set: { outcome, mfe: mfe ?? null, mae: mae ?? null, time_to_exit_minutes: timeToExitMinutes ?? null } },
      { new: true },
    ).lean() as ITradeEvent | null;

    // Trigger regime-partitioned online learning — non-blocking, never throws
    if (updated) {
      onTradeClose(updated).catch(() => { /* non-fatal */ });
    }
  } catch (err) {
    console.warn('[Telemetry] updateTradeOutcome failed (non-fatal):', err);
  }
}
