import { Worker } from 'bullmq';
import { config } from '../config';
import { logger } from '../lib/logger';
import { createRedis } from '../lib/redis';
import { EMAIL_QUEUE, type EmailJobData } from '../queue/emailQueue';
import { createEmailProcessor, type ProcessorDeps, type ProcessOutcome } from './processEmail';

export function startWorker(deps: ProcessorDeps, opts: { concurrency?: number } = {}) {
  const concurrency = opts.concurrency ?? config.WORKER_CONCURRENCY;
  const worker = new Worker<EmailJobData, ProcessOutcome>(EMAIL_QUEUE, createEmailProcessor(deps), {
    connection: createRedis(),
    concurrency,
    // If a worker dies, its lock expires and the job is picked up again (the processor
    // is idempotent). After 1 stall the job is failed instead of looping forever.
    maxStalledCount: 1,
    lockDuration: 60_000,
  });

  worker.on('ready', () =>
    logger.info(
      { queue: EMAIL_QUEUE, concurrency, minDelayMs: config.MIN_EMAIL_DELAY_MS, maxPerHour: config.MAX_EMAILS_PER_HOUR },
      'Email worker ready',
    ),
  );
  worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message, attemptsMade: job?.attemptsMade }, 'Job attempt failed'));
  worker.on('error', (err) => logger.error({ err }, 'Worker error'));
  return worker;
}
