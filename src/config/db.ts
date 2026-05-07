import mongoose from 'mongoose';
import env from './env';

const maxRetries = 5;
const retryDelay = 5000;

export async function connectDB(retryCount = 0): Promise<void> {
  try {
    await mongoose.connect(env.mongoUri);
    console.log('✓ MongoDB connected successfully');
  } catch (error) {
    if (retryCount < maxRetries) {
      console.log(`✗ MongoDB connection failed. Retrying in ${retryDelay}ms... (${retryCount + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      return connectDB(retryCount + 1);
    }
    throw new Error(`Failed to connect to MongoDB after ${maxRetries} retries: ${error}`);
  }
}
