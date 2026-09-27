import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { SmtpMailTransport } from './mail/mailer';
import { emailQueue } from './queue/emailQueue';
import { SenderRateLimiter } from './queue/rateLimiter';
import { ensureIndex } from './search/elastic';
import { reconcile } from './worker/reconcile';
import { startWorker } from './worker/startWorker';

async function main() {
  await ensureIndex().catch((err) => logger.warn({ err }, 'Elasticsearch unavailable at start-up; indexing will be retried per write'));
  // One-shot recovery after a restart (no polling): re-create any missing delayed jobs.
  await reconcile();

  const transport = new SmtpMailTransport();
  const worker = startWorker({ transport, limiter: new SenderRateLimiter(redis) });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down worker gracefully (finishing active jobs)');
    await worker.close();
    transport.close();
    await emailQueue.close();
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
