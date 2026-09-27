import { Router } from 'express';
import { currentUser, requireAuth } from '../auth/session';
import { prisma } from '../lib/prisma';
import { SenderRateLimiter } from '../queue/rateLimiter';
import { redis } from '../lib/redis';
import { config } from '../config';
import { createSender, createSenderSchema, toPublicSender } from './senderService';

export const senderRouter = Router();
senderRouter.use('/api/senders', requireAuth);

const limiter = new SenderRateLimiter(redis);

senderRouter.get('/api/senders', async (req, res) => {
  const senders = await prisma.sender.findMany({ where: { userId: currentUser(req).id }, orderBy: { createdAt: 'asc' } });
  const usage = await Promise.all(senders.map((s) => limiter.usage(s.id)));
  res.json({
    maxPerHour: config.MAX_EMAILS_PER_HOUR,
    items: senders.map((s, i) => ({ ...toPublicSender(s), sentThisHour: usage[i] })),
  });
});

senderRouter.post('/api/senders', async (req, res) => {
  const input = createSenderSchema.parse(req.body);
  const sender = await createSender(currentUser(req).id, input);
  res.status(201).json(toPublicSender(sender));
});
