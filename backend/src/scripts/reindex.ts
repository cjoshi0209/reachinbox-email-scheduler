/** Rebuilds the Elasticsearch index from Postgres (the source of truth). */
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { closeEmailQueue } from '../queue/emailQueue';
import { ensureIndex, indexEmails, es } from '../search/elastic';

async function main() {
  await ensureIndex();
  let cursor: string | undefined;
  let total = 0;
  for (;;) {
    const batch = await prisma.scheduledEmail.findMany({
      include: { sender: { select: { email: true } } },
      orderBy: { id: 'asc' },
      take: 1000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    await indexEmails(batch, { refresh: true });
    total += batch.length;
    cursor = batch[batch.length - 1]!.id;
  }
  logger.info({ total }, 'Reindex complete');
}

main()
  .catch((err) => {
    logger.error({ err }, 'Reindex failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeEmailQueue();
    await es.close();
    await prisma.$disconnect();
    redis.disconnect();
  });
