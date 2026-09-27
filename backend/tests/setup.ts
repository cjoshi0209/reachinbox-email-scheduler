import { afterAll } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { closeEmailQueue } from '../src/queue/emailQueue';

afterAll(async () => {
  await closeEmailQueue();
  await prisma.$disconnect();
  redis.disconnect();
});
