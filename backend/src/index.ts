import './config'; // Validate env vars first
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { generalLimiter, authLimiter } from './middleware/rateLimit';
import authRouter from './routes/auth';
import searchesRouter from './routes/searches';
import { startWorker } from './services/worker';

const app = express();

// CORS — must allow credentials for httpOnly cookie to be sent
app.use(
  cors({
    origin: config.frontendUrl,
    credentials: true,
  })
);

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(generalLimiter);

// Routes
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/searches', searchesRouter);

// Health check endpoint (used by Railway)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Start BullMQ worker in same process for MVP
// In production, split into separate Railway service for horizontal scaling
const worker = startWorker();

const server = app.listen(config.port, () => {
  console.log(`[Server] Running on port ${config.port} (${config.nodeEnv})`);
  console.log(`[Server] CORS origin: ${config.frontendUrl}`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log('[Server] Shutting down gracefully...');
  await worker.close();
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
