// src/models/CoachingCache.model.ts
// Caches AI-generated coaching insights to avoid regenerating on every request.
// Invalidated when: 6+ hours old OR user added 3+ new trades since last generation.

import mongoose, { Schema, Document } from 'mongoose';

export interface ICoachingCache extends Document {
  userId:                    mongoose.Types.ObjectId;
  insights:                  string[];
  topSuggestion:             string;
  tradeCountWhenGenerated:   number;
  generatedAt:               Date;
}

const CoachingCacheSchema = new Schema<ICoachingCache>({
  userId:                  { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  insights:                [{ type: String }],
  topSuggestion:           { type: String, default: '' },
  tradeCountWhenGenerated: { type: Number, default: 0 },
  generatedAt:             { type: Date, required: true },
});

export default mongoose.model<ICoachingCache>('CoachingCache', CoachingCacheSchema);
