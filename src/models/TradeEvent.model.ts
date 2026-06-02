// src/models/TradeEvent.model.ts
// Immutable telemetry record for every non-HOLD signal.
// Outcome starts as 'open' and is updated by signalAccuracy or tradeMonitor.
// Used exclusively by the performance analytics engine — never by signal flow.

import { Schema, model, Document, Types } from 'mongoose';

export type MarketRegime   = 'trend' | 'range' | 'compression' | 'expansion' | 'news';
export type TradeOutcome   = 'win' | 'loss' | 'breakeven' | 'open';
export type DataReliability = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';

export interface ITradeEvent extends Document {
  trade_id:                string;   // UUID — unique across all users
  timestamp:               Date;
  user_id:                 Types.ObjectId;
  symbol:                  string;
  timeframe:               string;
  trading_style:           'scalp' | 'swing';
  session:                 string;   // Asian / London Open / London-NY Overlap / New York
  market_regime:           MarketRegime;
  higher_timeframe_bias:   'bullish' | 'bearish' | 'neutral';
  bias_aligned:            boolean;  // does HTF/macro bias agree with signal direction?
  // Trigger metadata
  trigger_types_fired:     string[];
  trigger_strength_scores: Record<string, number>;
  // Quality scores (0–100 each)
  structure_score:         number;
  ob_quality_score:        number;
  fvg_quality_score:       number;
  displacement_strength:   number;
  retest_distance_score:   number;
  // Market context
  spread_at_entry:         number;   // broker feed; 0 when unavailable
  atr_at_entry:            number;
  risk_percent_used:       number;   // default 1.0
  // Levels
  entry_price:             number;
  stop_loss_price:         number;
  take_profit_price:       number;
  rr_ratio:                number;   // planned RR (TP distance / SL distance)
  confidence_score:        number;   // 0–100, bias-adjusted
  signal_direction:        'BUY' | 'SELL';
  // Outcome (filled in when trade closes)
  outcome:                 TradeOutcome;
  mfe:                     number | null;  // max favorable excursion in R
  mae:                     number | null;  // max adverse excursion in R
  time_to_exit_minutes:    number | null;
  // References
  signal_id:               string;
  notes:                   string;
}

const TradeEventSchema = new Schema<ITradeEvent>(
  {
    trade_id:               { type: String, required: true, unique: true },
    timestamp:              { type: Date,   default: () => new Date() },
    user_id:                { type: Schema.Types.ObjectId, required: true },
    symbol:                 { type: String, required: true },
    timeframe:              { type: String, required: true },
    trading_style:          { type: String, enum: ['scalp', 'swing'], required: true },
    session:                { type: String, required: true },
    market_regime:          { type: String, enum: ['trend', 'range', 'compression', 'expansion', 'news'], required: true },
    higher_timeframe_bias:  { type: String, enum: ['bullish', 'bearish', 'neutral'], required: true },
    bias_aligned:           { type: Boolean, required: true },

    trigger_types_fired:    [{ type: String }],
    trigger_strength_scores:{ type: Schema.Types.Mixed, default: {} },

    structure_score:        { type: Number, default: 0 },
    ob_quality_score:       { type: Number, default: 0 },
    fvg_quality_score:      { type: Number, default: 0 },
    displacement_strength:  { type: Number, default: 0 },
    retest_distance_score:  { type: Number, default: 0 },

    spread_at_entry:        { type: Number, default: 0 },
    atr_at_entry:           { type: Number, required: true },
    risk_percent_used:      { type: Number, default: 1 },

    entry_price:            { type: Number, required: true },
    stop_loss_price:        { type: Number, required: true },
    take_profit_price:      { type: Number, required: true },
    rr_ratio:               { type: Number, required: true },
    confidence_score:       { type: Number, required: true },
    signal_direction:       { type: String, enum: ['BUY', 'SELL'], required: true },

    outcome:                { type: String, enum: ['win', 'loss', 'breakeven', 'open'], default: 'open' },
    mfe:                    { type: Number, default: null },
    mae:                    { type: Number, default: null },
    time_to_exit_minutes:   { type: Number, default: null },

    signal_id:              { type: String, required: true },
    notes:                  { type: String, default: '' },
  },
  { timestamps: false },
);

// Compound indexes for analytics queries
TradeEventSchema.index({ user_id: 1, timestamp: -1 });
TradeEventSchema.index({ user_id: 1, symbol: 1, outcome: 1 });
TradeEventSchema.index({ user_id: 1, session: 1, market_regime: 1 });
TradeEventSchema.index({ user_id: 1, higher_timeframe_bias: 1 });

export default model<ITradeEvent>('TradeEvent', TradeEventSchema);
