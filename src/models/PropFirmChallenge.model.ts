// src/models/PropFirmChallenge.model.ts
// Prop firm challenge tracker.
//
// Tracks live progress against the rules of a funded trading evaluation
// (FTMO, MFF, True Forex Funds, MyFundedFX, etc.) or any custom challenge.
//
// Key computed metrics:
//   daily_loss_used_pct   = (daily_high_balance - current_balance) / account_size × 100
//   total_drawdown_pct    = (all_time_high_balance - current_balance) / account_size × 100
//   profit_progress_pct   = (current_balance - account_size) / (account_size × profit_target_pct / 100) × 100
//
// Circuit breaker: isTradeAllowed() returns false when either daily or total limit is reached.

import { Schema, model, Document, Types } from 'mongoose';

export type ChallengePhase  = 'challenge' | 'verification' | 'funded';
export type ChallengeStatus = 'active' | 'passed' | 'failed' | 'paused';

export interface IPropFirmChallenge extends Document {
  user_id:              Types.ObjectId;
  firm_name:            string;   // 'FTMO' | 'MFF' | 'TFT' | 'MyFundedFX' | 'custom'
  phase:                ChallengePhase;

  // ── Account rules ─────────────────────────────────────────────────────────
  account_size:         number;   // e.g. 100000 (starting bankroll)
  daily_loss_limit_pct: number;   // e.g. 5  (5% of account_size)
  max_drawdown_pct:     number;   // e.g. 10 (10% of account_size — or of all-time high)
  profit_target_pct:    number;   // e.g. 10 (10% of account_size)
  min_trading_days:     number;   // e.g. 4 minimum active days
  max_trading_days:     number;   // 0 = no deadline

  // ── Live tracking ─────────────────────────────────────────────────────────
  start_date:           Date;
  end_date:             Date | null;

  starting_balance:     number;   // account_size at start
  current_balance:      number;   // updated after every trade closes
  daily_high_balance:   number;   // peak balance today (resets at midnight UTC)
  all_time_high_balance: number;  // peak balance ever (for drawdown calculation)
  trading_days_used:    number;   // distinct calendar days with at least one trade

  // ── Status ────────────────────────────────────────────────────────────────
  status:               ChallengeStatus;
  failure_reason:       string | null;
  passed_at:            Date | null;
  is_active:            boolean;
}

const PropFirmChallengeSchema = new Schema<IPropFirmChallenge>(
  {
    user_id:               { type: Schema.Types.ObjectId, required: true, index: true },
    firm_name:             { type: String, required: true, default: 'custom' },
    phase:                 { type: String, enum: ['challenge', 'verification', 'funded'], default: 'challenge' },

    account_size:          { type: Number, required: true, min: 1000 },
    daily_loss_limit_pct:  { type: Number, required: true, default: 5,  min: 1, max: 20 },
    max_drawdown_pct:      { type: Number, required: true, default: 10, min: 1, max: 30 },
    profit_target_pct:     { type: Number, required: true, default: 10, min: 1, max: 30 },
    min_trading_days:      { type: Number, default: 4,  min: 0 },
    max_trading_days:      { type: Number, default: 30, min: 0 },

    start_date:            { type: Date, default: () => new Date() },
    end_date:              { type: Date, default: null },

    starting_balance:      { type: Number, required: true },
    current_balance:       { type: Number, required: true },
    daily_high_balance:    { type: Number, required: true },
    all_time_high_balance: { type: Number, required: true },
    trading_days_used:     { type: Number, default: 0 },

    status:                { type: String, enum: ['active', 'passed', 'failed', 'paused'], default: 'active' },
    failure_reason:        { type: String, default: null },
    passed_at:             { type: Date,   default: null },
    is_active:             { type: Boolean, default: true },
  },
  { timestamps: true },
);

PropFirmChallengeSchema.index({ user_id: 1, is_active: 1 });

export default model<IPropFirmChallenge>('PropFirmChallenge', PropFirmChallengeSchema);
