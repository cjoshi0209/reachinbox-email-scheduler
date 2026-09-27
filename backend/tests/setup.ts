import { afterAll } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { emailQueue } from '../src/queue/emailQueue';

afterAll(async () => {
  await emailQueue.close();
  await prisma.$disconnect();
  redis.disconnect();
});
