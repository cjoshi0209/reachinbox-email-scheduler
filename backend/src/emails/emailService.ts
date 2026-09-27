import { randomUUID } from 'node:crypto';
import { Prisma, type EmailStatus } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config';
import { sha256 } from '../lib/crypto';
import { HttpError, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { emailQueue, enqueueEmails, jobIdFor } from '../queue/emailQueue';
import { indexEmails, searchEmails } from '../search/elastic';

export const MAX_RECIPIENTS = 10_000;

export const scheduleSchema = z
  .object({
    senderId: z.string().min(1),
    subject: z.string().trim().min(1, 'Subject is required').max(998),
    body: z.string().trim().min(1, 'Body is required').max(100_000),
    recipients: z.array(z.string().trim()).min(1, 'At least one recipient is required').max(MAX_RECIPIENTS),
    /** When sending should begin. Omitted or in the past = now. */
    startAt: z.iso.datetime({ offset: true }).optional(),
    /** Gap between consecutive emails of this campaign. */
    delayMs: z.coerce.number().int().min(0).max(24 * 3600 * 1000).default(0),
    /** Per-sender hourly cap for this campaign; clamped to MAX_EMAILS_PER_HOUR. */
    hourlyLimit: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export type ScheduleInput = z.infer<typeof scheduleSchema>;

const emailSchema = z.email();

/** Trim, lowercase, dedupe, and split into valid / invalid. Order of first appearance is kept. */
export function normalizeRecipients(raw: string[]): { valid: string[]; invalid: string[]; duplicates: number } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  for (const r of raw) {
    const email = r.trim().toLowerCase();
    if (!email) continue;
    if (!emailSchema.safeParse(email).success) {
      invalid.push(r);
      continue;
    }
    if (seen.has(email)) {
      duplicates++;
      continue;
    }
    seen.add(email);
    valid.push(email);
  }
  return { valid, invalid, duplicates };
}

export const emailIdempotencyKey = (campaignId: string, recipient: string) =>
  sha256(`${campaignId}:${recipient.trim().toLowerCase()}`);

export interface ScheduleResult {
  campaignId: string;
  scheduled: number;
  duplicatesRemoved: number;
  firstSendAt: string;
  lastSendAt: string;
  hourlyLimit: number;
  /** True when this exact request (same Idempotency-Key) was already processed. */
  replayed: boolean;
}

const emailWithSender = { sender: { select: { email: true } } } as const;

export async function scheduleCampaign(userId: string, input: ScheduleInput, requestKey?: string): Promise<ScheduleResult> {
  const key = requestKey?.trim() || randomUUID();

  const existing = await prisma.campaign.findUnique({ where: { userId_requestKey: { userId, requestKey: key } } });
  if (existing) return replayResult(existing.id);

  const sender = await prisma.sender.findFirst({ where: { id: input.senderId, userId } });
  if (!sender) throw new HttpError(400, 'Unknown sender');

  const { valid, invalid, duplicates } = normalizeRecipients(input.recipients);
  if (invalid.length > 0) {
    throw new HttpError(400, `${invalid.length} invalid email address(es)`, { invalid: invalid.slice(0, 50) });
  }
  if (valid.length === 0) throw new HttpError(400, 'No valid recipients');

  const now = Date.now();
  const startMs = Math.max(now, input.startAt ? Date.parse(input.startAt) : now);
  const hourlyLimit = Math.min(input.hourlyLimit ?? config.MAX_EMAILS_PER_HOUR, config.MAX_EMAILS_PER_HOUR);

  let campaignId: string;
  let rows: { id: string; scheduledAt: Date }[];
  try {
    ({ campaignId, rows } = await prisma.$transaction(
      async (tx) => {
        const campaign = await tx.campaign.create({
          data: {
            userId,
            senderId: sender.id,
            requestKey: key,
            subject: input.subject,
            body: input.body,
            startAt: new Date(startMs),
            delayMs: input.delayMs,
            hourlyLimit,
            totalEmails: valid.length,
          },
        });
        const created: { id: string; scheduledAt: Date }[] = [];
        for (let i = 0; i < valid.length; i += 1000) {
          const chunk = valid.slice(i, i + 1000).map((recipient, j) => {
            const seq = i + j;
            const id = `em${randomUUID().replace(/-/g, '')}`;
            const scheduledAt = new Date(startMs + seq * input.delayMs);
            return {
              id,
              campaignId: campaign.id,
              userId,
              senderId: sender.id,
              recipient,
              subject: input.subject,
              body: input.body,
              sequence: seq,
              scheduledAt,
              originalScheduledAt: scheduledAt,
              bullJobId: jobIdFor(id),
              idempotencyKey: emailIdempotencyKey(campaign.id, recipient),
            };
          });
          await tx.scheduledEmail.createMany({ data: chunk });
          created.push(...chunk.map((c) => ({ id: c.id, scheduledAt: c.scheduledAt })));
        }
        return { campaignId: campaign.id, rows: created };
      },
      { timeout: 60_000 },
    ));
  } catch (err) {
    // Two identical requests raced: the loser replays the winner's result.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.campaign.findUnique({ where: { userId_requestKey: { userId, requestKey: key } } });
      if (winner) return replayResult(winner.id);
    }
    throw err;
  }

  // Postgres committed first (source of truth). If enqueueing fails here, the worker's
  // startup reconciliation re-enqueues every "scheduled" row that has no BullMQ job.
  try {
    await enqueueEmails(rows);
  } catch (err) {
    logger.error({ err, campaignId }, 'Enqueue failed after commit; rows will be recovered by reconciliation');
    throw new HttpError(503, 'Emails saved but the queue is unavailable; they will be queued automatically when it recovers.');
  }

  const saved = await prisma.scheduledEmail.findMany({ where: { campaignId }, include: emailWithSender });
  await indexEmails(saved);

  logger.info({ campaignId, count: rows.length, hourlyLimit, delayMs: input.delayMs }, 'Campaign scheduled');
  return {
    campaignId,
    scheduled: rows.length,
    duplicatesRemoved: duplicates,
    firstSendAt: rows[0]!.scheduledAt.toISOString(),
    lastSendAt: rows[rows.length - 1]!.scheduledAt.toISOString(),
    hourlyLimit,
    replayed: false,
  };
}

async function replayResult(campaignId: string): Promise<ScheduleResult> {
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const agg = await prisma.scheduledEmail.aggregate({
    where: { campaignId },
    _min: { originalScheduledAt: true },
    _max: { originalScheduledAt: true },
    _count: true,
  });
  return {
    campaignId,
    scheduled: agg._count,
    duplicatesRemoved: 0,
    firstSendAt: (agg._min.originalScheduledAt ?? c.startAt).toISOString(),
    lastSendAt: (agg._max.originalScheduledAt ?? c.startAt).toISOString(),
    hourlyLimit: c.hourlyLimit,
    replayed: true,
  };
}

// ---------------------------------------------------------------- queries

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const listSelect = {
  id: true,
  recipient: true,
  subject: true,
  body: true,
  status: true,
  scheduledAt: true,
  sentAt: true,
  failedAt: true,
  error: true,
  attempts: true,
  rescheduleCount: true,
  previewUrl: true,
  campaignId: true,
  sender: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ScheduledEmailSelect;

export type EmailListItem = Prisma.ScheduledEmailGetPayload<{ select: typeof listSelect }>;

function toListItem(e: EmailListItem) {
  return { ...e, body: e.body.length > 200 ? `${e.body.slice(0, 200)}...` : e.body };
}

export async function listScheduled(userId: string, page: number, pageSize: number) {
  const where = { userId, status: { in: ['scheduled', 'processing'] as EmailStatus[] } };
  const [items, total] = await Promise.all([
    prisma.scheduledEmail.findMany({
      where,
      select: listSelect,
      orderBy: [{ scheduledAt: 'asc' }, { sequence: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.scheduledEmail.count({ where }),
  ]);
  return { items: items.map(toListItem), total, page, pageSize };
}

export async function listSent(userId: string, page: number, pageSize: number) {
  const where = { userId, status: { in: ['sent', 'failed'] as EmailStatus[] } };
  const [items, total] = await Promise.all([
    prisma.scheduledEmail.findMany({
      where,
      select: listSelect,
      // The terminal transition (sent/failed) is the last write, so updatedAt == completion time.
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.scheduledEmail.count({ where }),
  ]);
  return { items: items.map(toListItem), total, page, pageSize };
}

export async function emailStats(userId: string) {
  const grouped = await prisma.scheduledEmail.groupBy({ by: ['status'], where: { userId }, _count: true });
  const counts: Record<EmailStatus, number> = { scheduled: 0, processing: 0, sent: 0, failed: 0, cancelled: 0 };
  for (const g of grouped) counts[g.status] = g._count;
  return { ...counts, upcoming: counts.scheduled + counts.processing, delivered: counts.sent + counts.failed };
}

export async function getEmail(userId: string, id: string) {
  const email = await prisma.scheduledEmail.findFirst({
    where: { id, userId },
    include: {
      sender: { select: { id: true, name: true, email: true } },
      campaign: { select: { id: true, startAt: true, delayMs: true, hourlyLimit: true, totalEmails: true } },
    },
  });
  if (!email) throw notFound('Email');
  const { idempotencyKey: _k, ...rest } = email;
  return rest;
}

export async function cancelEmail(userId: string, id: string) {
  const res = await prisma.scheduledEmail.updateMany({
    where: { id, userId, status: 'scheduled' },
    data: { status: 'cancelled' },
  });
  if (res.count === 0) {
    const exists = await prisma.scheduledEmail.findFirst({ where: { id, userId }, select: { status: true } });
    if (!exists) throw notFound('Email');
    throw new HttpError(409, `Email is ${exists.status} and can no longer be cancelled`);
  }
  // The worker also ignores cancelled rows, so a failure to remove the job is harmless.
  await emailQueue.remove(jobIdFor(id)).catch(() => undefined);
  const row = await prisma.scheduledEmail.findUniqueOrThrow({ where: { id }, include: emailWithSender });
  await indexEmails([row]);
  return { id, status: 'cancelled' as const };
}

export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.enum(['scheduled', 'processing', 'sent', 'failed', 'cancelled'])).optional()),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function search(userId: string, params: z.infer<typeof searchQuerySchema>) {
  try {
    const { total, ids } = await searchEmails({ userId, ...params });
    const rows = await prisma.scheduledEmail.findMany({ where: { id: { in: ids }, userId }, select: listSelect });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = ids.map((id) => byId.get(id)).filter((r): r is EmailListItem => Boolean(r));
    return { items: items.map(toListItem), total, source: 'elasticsearch' as const };
  } catch (err) {
    // Degrade gracefully: search still works (less smart) if Elasticsearch is down.
    logger.warn({ err }, 'Elasticsearch search failed; falling back to Postgres');
    const where: Prisma.ScheduledEmailWhereInput = {
      userId,
      ...(params.status ? { status: { in: params.status } } : {}),
      ...(params.q
        ? {
            OR: [
              { subject: { contains: params.q, mode: 'insensitive' } },
              { recipient: { contains: params.q, mode: 'insensitive' } },
              { body: { contains: params.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.scheduledEmail.findMany({ where, select: listSelect, orderBy: { scheduledAt: 'desc' }, skip: params.offset, take: params.limit }),
      prisma.scheduledEmail.count({ where }),
    ]);
    return { items: items.map(toListItem), total, source: 'postgres' as const };
  }
}
