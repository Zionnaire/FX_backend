// src/models/NewsCache.model.ts

import mongoose, { Schema } from 'mongoose';
import { INewsCache } from '../types/news.types';

const newsCacheSchema = new Schema<INewsCache>(
  {
    key: {
      type:     String,
      required: true,
      unique:   true,
      index:    true,
    },
    data: {
      type:     Schema.Types.Mixed,
      required: true,   // was missing — empty cache entries are useless
    },
    expiresAt: {
      type:     Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// TTL index — MongoDB auto-deletes documents when expiresAt is reached
// This replaces the incorrect { index: { expires: 0 } } syntax
// which was on the field definition instead of as a proper index
newsCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Shared cache lookup index — used by both chart and news services
newsCacheSchema.index({ key: 1, expiresAt: 1 });

export default mongoose.model<INewsCache>('NewsCache', newsCacheSchema);