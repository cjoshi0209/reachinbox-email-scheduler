import { createApp } from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { emailQueue } from './queue/emailQueue';
import { BULL_BOARD_PATH } from './admin/bullBoard';
import { ensureIndex } from './search/elastic';

async function main() {
  await ensureIndex().catch((err) => logger.warn({ err }, 'Elasticsearch unavailable at start-up; search will fall back to Postgres'));
  const server = createApp().listen(config.PORT, () => {
    logger.info(
      { url: config.API_URL, bullBoard: `${config.API_URL}${BULL_BOARD_PATH}`, google: config.googleEnabled, slack: config.slackEnabled },
      'API listening',
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down API');
    server.close(async () => {
      await emailQueue.close();
      await prisma.$disconnect();
      redis.disconnect();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'API failed to start');
  process.exit(1);
});
