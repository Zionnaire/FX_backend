import dotenv from 'dotenv';

dotenv.config();

const requiredEnvVars = [
  'PORT',
  'MONGODB_URI',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_ACCESS_EXPIRES_IN',
  'JWT_REFRESH_EXPIRES_IN',
  'GROQ_API_KEY',
  'JINA_API_KEY',
  'CLIENT_URL',
  'BACKEND_URL',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

export default {
  port: parseInt(process.env.PORT || '5000'),
  mongoUri: process.env.MONGODB_URI!,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET!,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET!,
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  nodeEnv: process.env.NODE_ENV || 'development',
  groqApiKey: process.env.GROQ_API_KEY!,
  jinaApiKey: process.env.JINA_API_KEY!,
  huggingfaceApiKey: process.env.HUGGINGFACE_API_KEY,
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY,
  twelveDataApiKey:   process.env.TWELVE_DATA_API_KEY,
  newsApiKey: process.env.NEWS_API_KEY,
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME,
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY,
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET,
  clientUrl: process.env.CLIENT_URL!,
  backendUrl: process.env.BACKEND_URL!,
  alertCheckIntervalMs: parseInt(process.env.ALERT_CHECK_INTERVAL_MS || '60000'),
  signalCacheTtlMs: parseInt(process.env.SIGNAL_CACHE_TTL_MS || '300000'),
  newsCacheTtlMs: parseInt(process.env.NEWS_CACHE_TTL_MS || '1800000'),
};
