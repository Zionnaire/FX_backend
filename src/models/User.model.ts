// src/models/User.model.ts

import mongoose, { Document, Schema } from 'mongoose';
import bcryptjs from 'bcryptjs';
import { IUser } from '../types/user.types';

export interface IUserDocument extends Omit<IUser, '_id'>, Document {
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const userSchema = new Schema<IUserDocument>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    refreshToken: {
      type: String,
      default: null,
    },
    simulationBalance: {
      type: Number,
      default: 10000,
      min: 0,
    },
    preferences: {
      defaultPair: {
        type: String,
        enum: ['XAU/USD', 'GBP/USD', 'EUR/USD', 'USD/JPY'],
        default: 'XAU/USD',
      },
      defaultTimeframe: {
        type: String,
        enum: ['1m', '5m', '15m', '1h', '4h', '1d'],
        default: '1h',
      },
      riskPercent: {
        type: Number,
        default: 2,
        min: 0.1,
        max: 100,
      },
    },
    autoTrade: {
      enabled:         { type: Boolean,  default: false },
      mt5ApiKey:       { type: String,   default: null  },
      defaultRiskPct:  { type: Number,   default: 1, min: 0.1, max: 10 },
      maxDailyLossPct: { type: Number,   default: 5, min: 1,   max: 50 },
      maxDailyTrades:  { type: Number,   default: 3, min: 1,   max: 20 },
      minConfluence:   { type: Number,   default: 5, min: 1,   max: 8  },
      minConfidence:   { type: Number,   default: 65, min: 50, max: 100 },
      eaLastPollAt:    { type: Date,     default: null },
    },
    // Telegram config — stored as Mixed to avoid extending IUser interface
    telegram: { type: Schema.Types.Mixed, default: () => ({
      chat_id: null, enabled: false,
      on_signal: true, on_auto_trade: true, on_alert: true,
      on_daily_briefing: true, on_circuit_breaker: true,
    })},
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = ret as any;
        delete r.password;
        delete r.refreshToken;
        return r;
      },
    },
  }
);

userSchema.pre('save', async function (next) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = this as any;
  if (!doc.isModified('password')) return next();
  try {
    const salt   = await bcryptjs.genSalt(12);
    doc.password = await bcryptjs.hash(doc.password as string, salt);
    next();
  } catch (error) {
    next(error as Error);
  }
});

userSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return bcryptjs.compare(candidatePassword, (this as any).password as string);
};

export default mongoose.model<IUserDocument>('User', userSchema);