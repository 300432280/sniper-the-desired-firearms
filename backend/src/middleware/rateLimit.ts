import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redisConnection } from '../services/queue';

/**
 * Create a RedisStore backed by the shared ioredis connection.
 * The `prefix` isolates each limiter's keys in the same Redis DB.
 */
function makeStore(prefix: string): RedisStore {
  return new RedisStore({
    sendCommand: (...args: string[]) =>
      redisConnection.call(args[0], ...args.slice(1)) as Promise<number>,
    prefix: `rl:${prefix}:`,
  });
}

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('general'),
  passOnStoreError: true, // allow requests through if Redis is down
  message: { error: 'Too many requests, please try again later.' },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Dev: 1000 attempts so iterating on auth doesn't lock you out.
  // Prod: 10 attempts per 15 min.
  max: process.env.NODE_ENV === 'production' ? 10 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('auth'),
  passOnStoreError: true,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

export const guestSearchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 guest alerts per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('guest'),
  passOnStoreError: true,
  message: { error: 'Guest alert limit reached. Please create an account for unlimited alerts.' },
});
