import { config } from '../config';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { emailQueue, enqueueEmails } from '../queue/emailQueue';
import { indexEmails } from '../search/elastic';

/**
 * One-shot recovery run at worker start-up (NOT a polling loop / cron):
 *
 * 1. Every Postgres row in "scheduled" must have a BullMQ job. Normally it already does
 *    (Redis persists delayed jobs with AOF), but if Redis lost data or the API crashed
 *    between commit and enqueue, the missing jobs are re-created with the remaining delay.
 *    Deterministic job ids make this safe to run any number of times.
 * 2. Rows stuck in "processing" longer than STALE_PROCESSING_MS (worker died mid-send)
 *    are marked failed rather than resent, because delivery state is unknown.
 */
export async function reconcile(): Promise<{ requeued: number; staleFailed: number }> {
  let requeued = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.scheduledEmail.findMany({
      where: { status: 'scheduled' },
      select: { id: true, bullJobId: true, scheduledAt: true },
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;

    const states = await Promise.all(batch.map((r) => emailQueue.getJobState(r.bullJobId)));
    const missing = batch.filter((_, i) => {
      const s = states[i];
      // "completed"/"failed" jobs for a still-"scheduled" row mean the job ended without
      // finishing the row (e.g. crash); remove the stale job so the id can be reused.
      return s === 'unknown' || s === 'completed' || s === 'failed';
    });
    for (const r of missing) {
      const job = await emailQueue.getJob(r.bullJobId);
      if (job) await job.remove().catch(() => undefined);
    }
    if (missing.length > 0) {
      await enqueueEmails(missing);
      requeued += missing.length;
    }
  }

  const staleBefore = new Date(Date.now() - config.STALE_PROCESSING_MS);
  const stale = await prisma.scheduledEmail.findMany({
    where: { status: 'processing', processingAt: { lt: staleBefore } },
    select: { id: true },
  });
  if (stale.length > 0) {
    await prisma.scheduledEmail.updateMany({
      where: { id: { in: stale.map((s) => s.id) }, status: 'processing' },
      data: { status: 'failed', failedAt: new Date(), error: 'Delivery state unknown: worker stopped mid-send. Not retried automatically to avoid a duplicate.' },
    });
    const rows = await prisma.scheduledEmail.findMany({ where: { id: { in: stale.map((s) => s.id) } }, include: { sender: { select: { email: true } } } });
    await indexEmails(rows);
  }

  logger.info({ requeued, staleFailed: stale.length }, 'Reconciliation complete');
  return { requeued, staleFailed: stale.length };
}
