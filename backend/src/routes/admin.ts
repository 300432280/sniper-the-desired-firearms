import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { getEvents, subscribe } from '../services/debugLog';

const router = Router();

// All admin routes require admin auth
router.use(requireAdmin);

// GET /api/admin/debug-log/history — returns all buffered events as JSON
router.get('/debug-log/history', (_req: Request, res: Response) => {
  return res.json({ events: getEvents() });
});

// GET /api/admin/debug-log — SSE stream of live events
router.get('/debug-log', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Send initial keepalive
  res.write(':ok\n\n');

  const unsubscribe = subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // Send keepalive every 30s to prevent timeout
  const keepalive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(keepalive);
  });
});

export default router;
