import 'dotenv/config';

export const config = {
  databaseUrl: process.env.DATABASE_URL!,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET!,
  jwtExpiry: process.env.JWT_EXPIRY || '7d',
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '10', 10),
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  resendApiKey: process.env.RESEND_API_KEY!,
  fromEmail: process.env.FROM_EMAIL || 'alerts@firearm-alert.ca',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID as string | undefined,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN as string | undefined,
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER as string | undefined,
  adminEmails: (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean),
  backendUrl: process.env.BACKEND_URL || `http://localhost:${process.env.PORT || '4000'}`,
} as const;

// Fail fast at startup if critical vars are missing
const required = ['DATABASE_URL', 'JWT_SECRET', 'RESEND_API_KEY', 'REDIS_URL'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}
