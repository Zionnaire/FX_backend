// src/models/Alert.model.ts

import mongoose, { Schema } from 'mongoose';
import { IAlert } from '../types/alert.types';

const VALID_PAIRS = ['XAU/USD', 'GBP/USD', 'EUR/USD', 'USD/JPY'] as const;

const VALID_CONDITIONS = [
  'price_above',
  'price_below',
  'rsi_above',
  'rsi_below',
  'ai_signal_buy',
  'ai_signal_sell',
  'pattern_detected',
] as const;

const VALID_PATTERNS = [
  // Two-candle / single-candle
  'Bullish Engulfing',
  'Bearish Engulfing',
  'Hammer',
  'Shooting Star',
  'Doji',
  // Caginalp & Laurent (1998) three-day statistically validated patterns
  'Three White Soldiers',
  'Three Black Crows',
  'Three Inside Up',
  'Three Inside Down',
  'Three Outside Up',
  'Three Outside Down',
  'Morning Star',
  'Evening Star',
] as const;

const VALID_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

const alertSchema = new Schema<IAlert>(
  {
    userId: {
      type: Schema.Types.ObjectId,   // must match User model's _id type
      ref: 'User',
      required: true,
      index: true,
    },
    pair: {
      type: String,
      enum: VALID_PAIRS,             // no silent typos
      required: true,
    },
    condition: {
      type: String,
      enum: VALID_CONDITIONS,
      required: true,
    },
    targetValue: {
      type: Number,
      // required only when condition is NOT pattern_detected
      required: function (this: IAlert) {
        return this.condition !== 'pattern_detected';
      },
      // Basic range sanity — prevents nonsense like RSI of 5000
      validate: {
        validator: function (this: IAlert, val: number) {
          if (
            this.condition === 'rsi_above' ||
            this.condition === 'rsi_below'
          ) {
            return val >= 0 && val <= 100;
          }
          return true; // price checks — no upper bound needed
        },
        message: 'RSI target value must be between 0 and 100',
      },
    },
    targetPattern: {
      type: String,
      enum: VALID_PATTERNS,
      required: function (this: IAlert) {
        return this.condition === 'pattern_detected';
      },
    },
    timeframe: {
      type: String,
      enum: VALID_TIMEFRAMES,
      default: '1h',
    },
    type: {
      type: String,
      enum: ['buy', 'sell', 'info'],
      required: true,
    },
    enabled: {
      type: Boolean,
      default: true,
      index: true,               // alert checker filters by this
    },
    triggered: {
      type: Boolean,
      default: false,
      index: true,               // alert checker filters by this
    },
    triggeredAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Compound Index ───────────────────────────────────────────────────────────
// Alert checker runs: Alert.find({ enabled: true, triggered: false })
// every 60 seconds across all users — this index makes it fast
alertSchema.index({ enabled: 1, triggered: 1 });

// Per-user lookup index (getAlerts endpoint)
alertSchema.index({ userId: 1, createdAt: -1 });

// ─── Per-user Alert Cap ───────────────────────────────────────────────────────
// Prevent a single user from creating unlimited alerts
alertSchema.pre('save', async function (next) {
  if (!this.isNew) return next();   // only check on creation

  const count = await mongoose.model('Alert').countDocuments({
    userId: this.userId,
    enabled: true,
  });

  if (count >= 50) {
    return next(
      new Error('Alert limit reached. Maximum 50 active alerts per user.')
    );
  }

  next();
});

export default mongoose.model<IAlert>('Alert', alertSchema);