import { Queue } from 'bullmq';
import { config } from '../config';
import { createRedis } from '../lib/redis';

export const EMAIL_QUEUE = config.QUEUE_NAME;

export interface EmailJobData {
  emailId: string;
  /** Set when the rate limiter granted this job a future send slot (epoch ms). */
  reservedSlotAt?: number;
  /** Whether that slot counts against the hour's reserved budget (see rateLimiter). */
  reservationCounted?: boolean;
}

/** Deterministic job id: re-adding the same email is a no-op in BullMQ (dedupe). BullMQ forbids ':' in custom ids. */
export const jobIdFor = (emailId: string) => `email_${emailId}`;

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE, {
  connection: createRedis(),
  defaultJobOptions: {
    attempts: config.EMAIL_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: config.EMAIL_BACKOFF_MS },
    // Keep history bounded but useful for Bull Board.
    removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
    removeOnFail: { age: 14 * 24 * 3600 },
  },
});

export async function enqueueEmail(emailId: string, scheduledAt: Date): Promise<void> {
  await emailQueue.add(
    'send',
    { emailId },
    { jobId: jobIdFor(emailId), delay: Math.max(0, scheduledAt.getTime() - Date.now()) },
  );
}

/** Bulk enqueue in chunks (1000+ emails per campaign). Existing job ids are ignored by BullMQ. */
export async function enqueueEmails(rows: { id: string; scheduledAt: Date }[]): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < rows.length; i += 500) {
    await emailQueue.addBulk(
      rows.slice(i, i + 500).map((r) => ({
        name: 'send',
        data: { emailId: r.id },
        opts: { jobId: jobIdFor(r.id), delay: Math.max(0, r.scheduledAt.getTime() - now) },
      })),
    );
  }
}
