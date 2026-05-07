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
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.password;
        delete ret.refreshToken;
        return ret;
      },
    },
  }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcryptjs.genSalt(12);
    this.password = await bcryptjs.hash(this.password, salt);
    next();
  } catch (error) {
    next(error as Error);
  }
});

userSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  return bcryptjs.compare(candidatePassword, this.password);
};

export default mongoose.model<IUserDocument>('User', userSchema);