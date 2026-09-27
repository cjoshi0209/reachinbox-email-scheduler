import { DelayedError, type Job } from 'bullmq';
import { config } from '../config';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { MailTransport } from '../mail/mailer';
import type { EmailJobData } from '../queue/emailQueue';
import type { SenderRateLimiter } from '../queue/rateLimiter';
import { indexEmails } from '../search/elastic';
import { notifyUser, rateLimitMessage } from '../slack/slackService';

export interface ProcessorDeps {
  transport: MailTransport;
  limiter: SenderRateLimiter;
  notify?: typeof notifyUser;
  now?: () => number;
}

export type ProcessOutcome =
  | 'sent'
  | 'skipped'
  | 'throttled'
  | 'rate_limited'
  | 'not_due'
  | 'stale_failed';

const withSender = { include: { sender: true, campaign: { select: { hourlyLimit: true, delayMs: true } } } } as const;

async function reindex(id: string) {
  const row = await prisma.scheduledEmail.findUnique({ where: { id }, include: { sender: { select: { email: true } } } });
  if (row) await indexEmails([row]);
}

/**
 * Processes one email job. Safe to run concurrently and safe to run more than once for
 * the same email:
 *  - terminal rows (sent/failed/cancelled) are skipped (idempotent replays)
 *  - the scheduled -> processing transition is a conditional UPDATE, so exactly one
 *    worker can win the right to send
 *  - rate limit / throttle decisions happen in Redis (atomic Lua) BEFORE claiming the row
 */
export function createEmailProcessor(deps: ProcessorDeps) {
  const notify = deps.notify ?? notifyUser;
  const now = deps.now ?? Date.now;

  /** Moves the active job back to "delayed" without consuming a retry attempt. */
  async function moveJob(job: Job<EmailJobData>, token: string | undefined, at: number, data?: Partial<EmailJobData>): Promise<never> {
    if (data) await job.updateData({ ...job.data, ...data });
    await job.moveToDelayed(at, token);
    throw new DelayedError();
  }

  return async function processEmail(job: Job<EmailJobData>, token?: string): Promise<ProcessOutcome> {
    const { emailId } = job.data;
    const log = logger.child({ emailId, jobId: job.id, attempt: job.attemptsMade + 1 });

    const email = await prisma.scheduledEmail.findUnique({ where: { id: emailId }, ...withSender });
    if (!email) {
      log.warn('Email row not found; dropping job');
      return 'skipped';
    }
    if (email.status === 'sent' || email.status === 'failed' || email.status === 'cancelled') {
      log.info({ status: email.status }, 'Already in terminal state; duplicate job ignored');
      return 'skipped';
    }
    if (email.status === 'processing') {
      const since = now() - (email.processingAt?.getTime() ?? 0);
      if (since < config.STALE_PROCESSING_MS) {
        log.warn('Email is being processed by another worker; skipping');
        return 'skipped';
      }
      // A worker died mid-SMTP call. We cannot know if the server accepted the message,
      // so we refuse to resend (no duplicates) and surface it as failed instead.
      await prisma.scheduledEmail.updateMany({
        where: { id: emailId, status: 'processing' },
        data: { status: 'failed', failedAt: new Date(now()), error: 'Delivery state unknown: worker stopped mid-send. Not retried automatically to avoid a duplicate.' },
      });
      await reindex(emailId);
      return 'stale_failed';
    }

    // DB is the source of truth for timing: if the row was pushed later, follow it.
    if (email.scheduledAt.getTime() - now() > 1000) {
      log.debug('Job fired before its scheduled time; re-delaying');
      await moveJob(job, token, email.scheduledAt.getTime());
    }

    // BullMQ may promote a delayed job a few ms early; wait for the reserved slot in-process
    // rather than bouncing it through Redis again.
    const earlyBy = (job.data.reservedSlotAt ?? 0) - now();
    if (earlyBy > 0 && earlyBy <= 1000) await new Promise((r) => setTimeout(r, earlyBy));

    const limitPerHour = Math.min(email.campaign.hourlyLimit, config.MAX_EMAILS_PER_HOUR);
    const minDelayMs = Math.max(config.MIN_EMAIL_DELAY_MS, email.campaign.delayMs);
    const reserve = (reservedSlotAt: number | undefined) =>
      deps.limiter.reserve({
        senderId: email.senderId,
        limitPerHour,
        minDelayMs,
        reservedSlotAt,
        reservationCounted: job.data.reservationCounted,
        now: now(),
      });

    let decision = await reserve(job.data.reservedSlotAt);
    // Our slot has come but the previous send ran a little late: wait in-process (bounded)
    // instead of re-queueing, so ordering is kept and the min gap is still exact.
    for (let i = 0; decision.kind === 'wait' && i < 10; i++) {
      await new Promise((r) => setTimeout(r, decision.kind === 'wait' ? decision.waitMs : 0));
      decision = await reserve(job.data.reservedSlotAt);
    }
    if (decision.kind === 'wait') decision = await reserve(undefined); // give up the slot, re-queue at the tail

    if (decision.kind === 'throttled') {
      await prisma.scheduledEmail.update({ where: { id: emailId }, data: { scheduledAt: new Date(decision.slotAt) } });
      log.debug({ slotAt: new Date(decision.slotAt).toISOString() }, 'Throttled; reserved next send slot');
      await moveJob(job, token, decision.slotAt, { reservedSlotAt: decision.slotAt, reservationCounted: decision.counted });
    }

    if (decision.kind === 'hourly_limit') {
      const targetAt = new Date(decision.targetAt);
      await prisma.scheduledEmail.update({
        where: { id: emailId },
        data: { scheduledAt: targetAt, rescheduleCount: { increment: 1 } },
      });
      await reindex(emailId);
      log.info({ limitPerHour, targetAt: targetAt.toISOString(), position: decision.overflowPosition }, 'Hourly limit reached; rescheduled to next window');
      if (decision.firstHit) {
        // Fire-and-forget: Slack problems must never affect delivery.
        void notify(email.userId, rateLimitMessage({
          senderEmail: email.sender.email,
          limit: limitPerHour,
          windowStart: new Date(decision.windowStart),
          nextSendAt: targetAt,
        })).catch((err) => log.error({ err }, 'Slack notify threw'));
      }
      await moveJob(job, token, decision.targetAt, { reservedSlotAt: undefined, reservationCounted: undefined });
    }

    // Claim the row. Only one worker can move it out of "scheduled".
    const claimed = await prisma.scheduledEmail.updateMany({
      where: { id: emailId, status: 'scheduled' },
      data: { status: 'processing', processingAt: new Date(now()), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      log.info('Lost the claim race (already claimed/cancelled); skipping');
      return 'skipped';
    }

    try {
      const result = await deps.transport.send(email.sender, {
        to: email.recipient,
        subject: email.subject,
        body: email.body,
        messageId: `<${email.idempotencyKey}@reachinbox.local>`,
      });
      await prisma.scheduledEmail.updateMany({
        where: { id: emailId, status: 'processing' },
        data: { status: 'sent', sentAt: new Date(now()), messageId: result.messageId, previewUrl: result.previewUrl, error: null },
      });
      log.info({ to: email.recipient, previewUrl: result.previewUrl }, 'Email sent');
      await reindex(emailId);
      return 'sent';
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const maxAttempts = job.opts.attempts ?? 1;
      const willRetry = job.attemptsMade + 1 < maxAttempts;
      if (willRetry) {
        const backoff = config.EMAIL_BACKOFF_MS * 2 ** job.attemptsMade;
        await prisma.scheduledEmail.updateMany({
          where: { id: emailId, status: 'processing' },
          data: { status: 'scheduled', error: message, scheduledAt: new Date(now() + backoff) },
        });
        log.warn({ err: message, retryInMs: backoff }, 'Send failed; will retry');
      } else {
        await prisma.scheduledEmail.updateMany({
          where: { id: emailId, status: 'processing' },
          data: { status: 'failed', failedAt: new Date(now()), error: message },
        });
        log.error({ err: message }, 'Send failed permanently');
      }
      await reindex(emailId);
      throw err;
    }
  };
}
