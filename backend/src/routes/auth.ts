import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { signToken, requireAuth } from '../middleware/auth';
import { config } from '../config';

const router = Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.nodeEnv === 'production',
  sameSite: 'strict' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  phone: z
    .string()
    .regex(/^\+?[\d\s\-().]{7,20}$/, 'Invalid phone number')
    .optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  const parse = registerSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten().fieldErrors });
  }
  const { email, password, phone } = parse.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  const user = await prisma.user.create({
    data: { email, passwordHash, phone },
    select: { id: true, email: true, tier: true, phone: true },
  });

  const token = signToken({ userId: user.id, email: user.email, tier: user.tier });
  res.cookie('token', token, COOKIE_OPTIONS);

  const isAdmin = config.adminEmails.includes(user.email);
  return res.status(201).json({ user: { ...user, isAdmin } });
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'Invalid email or password format' });
  }
  const { email, password } = parse.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Use constant-time comparison to prevent timing attacks
    await bcrypt.hash('dummy', config.bcryptRounds);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = signToken({ userId: user.id, email: user.email, tier: user.tier });
  res.cookie('token', token, COOKIE_OPTIONS);

  const isAdmin = config.adminEmails.includes(user.email);
  return res.json({
    user: { id: user.id, email: user.email, tier: user.tier, phone: user.phone, isAdmin },
  });
});

// POST /api/auth/logout
router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('token', { httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'strict' });
  return res.json({ message: 'Logged out' });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { id: true, email: true, tier: true, phone: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const isAdmin = config.adminEmails.includes(user.email);
  return res.json({ user: { ...user, isAdmin } });
});

// PATCH /api/auth/profile — update phone number
router.patch('/profile', requireAuth, async (req: Request, res: Response) => {
  const schema = z.object({
    phone: z.string().regex(/^\+?[\d\s\-().]{7,20}$/).optional().nullable(),
  });

  const parse = schema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten().fieldErrors });
  }

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: { phone: parse.data.phone },
    select: { id: true, email: true, tier: true, phone: true },
  });

  const isAdmin = config.adminEmails.includes(user.email);
  return res.json({ user: { ...user, isAdmin } });
});

export default router;
