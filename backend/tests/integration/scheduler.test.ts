import { randomUUID } from 'node:crypto';
import type { Job, Worker } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleCampaign } from '../../src/emails/emailService';
import { encrypt } from '../../src/lib/crypto';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { emailQueue, enqueueEmail, jobIdFor, type EmailJobData } from '../../src/queue/emailQueue';
import { HOUR_MS, SenderRateLimiter } from '../../src/queue/rateLimiter';
import { notifyUser } from '../../src/slack/slackService';
import { createEmailProcessor } from '../../src/worker/processEmail';
import { reconcile } from '../../src/worker/reconcile';
import { startWorker } from '../../src/worker/startWorker';
import { countByStatus, createUserWithSender, FakeTransport, resetQueue, sleep, waitFor } from '../helpers/fixtures';

const limiter = new SenderRateLimiter(redis);
let workers: Worker[] = [];

function run(transport: FakeTransport, opts: { concurrency?: number; notify?: typeof notifyUser } = {}) {
  const w = startWorker({ transport, limiter, notify: opts.notify }, { concurrency: opts.concurrency ?? 5 });
  workers.push(w);
  return w;
}

const recipients = (n: number, tag = randomUUID().slice(0, 6)) => Array.from({ length: n }, (_, i) => `lead${i}-${tag}@example.com`);

beforeEach(async () => {
  await resetQueue();
  // Park rows left by earlier tests so reconciliation assertions only see this test's data.
  await prisma.scheduledEmail.updateMany({ where: { status: { in: ['scheduled', 'processing'] } }, data: { status: 'cancelled' } });
});
afterEach(async () => {
  await Promise.all(workers.map((w) => w.close(true)));
  workers = [];
});

describe('scheduling', () => {
  it('persists rows in Postgres and creates delayed BullMQ jobs with deterministic ids', async () => {
    const { user, sender } = await createUserWithSender();
    const startAt = new Date(Date.now() + 60_000);
    const res = await scheduleCampaign(user.id, {
      senderId: sender.id,
      subject: 'Hello',
      body: 'Body',
      recipients: recipients(3),
      startAt: startAt.toISOString(),
      delayMs: 5000,
    });
    expect(res.scheduled).toBe(3);

    const rows = await prisma.scheduledEmail.findMany({ where: { campaignId: res.campaignId }, orderBy: { sequence: 'asc' } });
    expect(rows.map((r) => r.status)).toEqual(['scheduled', 'scheduled', 'scheduled']);
    // Campaign "delay between emails" spaces the initial schedule.
    expect(rows.map((r) => r.scheduledAt.getTime() - startAt.getTime())).toEqual([0, 5000, 10000]);

    for (const r of rows) {
      expect(r.bullJobId).toBe(jobIdFor(r.id));
      const job = await emailQueue.getJob(r.bullJobId);
      expect(await job!.getState()).toBe('delayed');
      expect(job!.opts.delay).toBeGreaterThan(r.scheduledAt.getTime() - Date.now() - 2000);
    }
  });

  it('supports 1000+ emails in one request', async () => {
    const { user, sender } = await createUserWithSender();
    const res = await scheduleCampaign(user.id, {
      senderId: sender.id,
      subject: 'Load',
      body: 'Body',
      recipients: recipients(1200),
      startAt: new Date(Date.now() + 3_600_000).toISOString(),
      delayMs: 0,
    });
    expect(res.scheduled).toBe(1200);
    expect(await emailQueue.getDelayedCount()).toBeGreaterThanOrEqual(1200);
  });
});

describe('idempotency & duplicate protection', () => {
  it('replays the same Idempotency-Key instead of scheduling twice (even concurrently)', async () => {
    const { user, sender } = await createUserWithSender();
    const input = { senderId: sender.id, subject: 'Once', body: 'B', recipients: recipients(4), delayMs: 0, startAt: new Date(Date.now() + 60_000).toISOString() };
    const key = `key-${randomUUID()}`;
    const results = await Promise.all([scheduleCampaign(user.id, input, key), scheduleCampaign(user.id, input, key), scheduleCampaign(user.id, input, key)]);
    expect(new Set(results.map((r) => r.campaignId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await prisma.campaign.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.scheduledEmail.count({ where: { userId: user.id } })).toBe(4);
  });

  it('removes duplicate recipients inside one campaign', async () => {
    const { user, sender } = await createUserWithSender();
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'S', body: 'B', recipients: ['a@x.com', 'A@x.com', 'b@x.com'], delayMs: 0 });
    expect(res).toMatchObject({ scheduled: 2, duplicatesRemoved: 1 });
  });

  it('re-adding the same job id is a no-op', async () => {
    const { user, sender } = await createUserWithSender();
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'S', body: 'B', recipients: recipients(1), delayMs: 0, startAt: new Date(Date.now() + 60_000).toISOString() });
    const row = await prisma.scheduledEmail.findFirstOrThrow({ where: { campaignId: res.campaignId } });
    await enqueueEmail(row.id, row.scheduledAt);
    await enqueueEmail(row.id, row.scheduledAt);
    expect(await emailQueue.getDelayedCount()).toBe(1);
  });

  it('never sends the same email twice, even when two workers race on it', async () => {
    const { user, sender } = await createUserWithSender();
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'Race', body: 'B', recipients: recipients(1), delayMs: 0, startAt: new Date(Date.now() + 60_000).toISOString() });
    const row = await prisma.scheduledEmail.findFirstOrThrow({ where: { campaignId: res.campaignId } });
    await prisma.scheduledEmail.update({ where: { id: row.id }, data: { scheduledAt: new Date() } });

    const transport = new FakeTransport({ latencyMs: 50 });
    const process = createEmailProcessor({ transport, limiter });
    const fakeJob = { id: 'x', data: { emailId: row.id }, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<EmailJobData>;
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => process(fakeJob, 'token')));

    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
    // A late replay after completion is skipped too.
    expect(await process(fakeJob, 'token')).toBe('skipped');
    expect(transport.sent).toHaveLength(1);
    const final = await prisma.scheduledEmail.findUniqueOrThrow({ where: { id: row.id } });
    expect(final).toMatchObject({ status: 'sent', attempts: 1 });
    expect(final.messageId).toBe(`<${row.idempotencyKey}@reachinbox.local>`);
  });
});

describe('worker execution', () => {
  it('sends due emails and records sent state + preview url', async () => {
    const { user, sender } = await createUserWithSender();
    const transport = new FakeTransport();
    run(transport);
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'Now', body: 'B', recipients: recipients(3), delayMs: 0 });
    await waitFor(async () => (await countByStatus(res.campaignId)).sent === 3);
    const rows = await prisma.scheduledEmail.findMany({ where: { campaignId: res.campaignId } });
    expect(rows.every((r) => r.sentAt && r.previewUrl?.startsWith('https://ethereal.email/'))).toBe(true);
    expect(transport.sent).toHaveLength(3);
  });

  it('does not send before the scheduled time', async () => {
    const { user, sender } = await createUserWithSender();
    const transport = new FakeTransport();
    run(transport);
    const startAt = Date.now() + 1500;
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'Later', body: 'B', recipients: recipients(1), delayMs: 0, startAt: new Date(startAt).toISOString() });
    await sleep(800);
    expect(transport.sent).toHaveLength(0);
    await waitFor(async () => (await countByStatus(res.campaignId)).sent === 1);
    expect(transport.sent[0]!.at).toBeGreaterThanOrEqual(startAt - 50);
  });

  it('runs jobs in parallel up to the configured concurrency', async () => {
    const { user, sender } = await createUserWithSender();
    const transport = new FakeTransport({ latencyMs: 150 });
    run(transport, { concurrency: 4 });
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'Par', body: 'B', recipients: recipients(16), delayMs: 0 });
    await waitFor(async () => (await countByStatus(res.campaignId)).sent === 16);
    expect(transport.maxInFlight).toBeGreaterThan(1);
    expect(transport.maxInFlight).toBeLessThanOrEqual(4);
    expect(new Set(transport.sent.map((s) => s.to)).size).toBe(16);
  });

  it('keeps concurrency safe across two worker instances (no duplicates)', async () => {
    const { user, sender } = await createUserWithSender();
    const transport = new FakeTransport({ latencyMs: 30 });
    run(transport, { concurrency: 5 });
    run(transport, { concurrency: 5 });
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'Two workers', body: 'B', recipients: recipients(30), delayMs: 0 });
    await waitFor(async () => (await countByStatus(res.campaignId)).sent === 30);
    expect(transport.sent).toHaveLength(30);
  });

  it('enforces the minimum delay between sends of a sender, even with high concurrency', async () => {
    const { user, sender } = await createUserWithSender();
    const transport = new FakeTransport();
    // Campaign delay 400ms => runtime min gap 400ms (max(MIN_EMAIL_DELAY_MS, campaign delay)).
    const res = await scheduleCampaign(user.id, {
      senderId: sender.id,
      subject: 'Throttle',
      body: 'B',
      recipients: recipients(4),
      delayMs: 400,
      startAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    // Collapse the planned schedule so all 4 become due at once - only the limiter can space them.
    await prisma.scheduledEmail.updateMany({ where: { campaignId: res.campaignId }, data: { scheduledAt: new Date() } });
    const rows = await prisma.scheduledEmail.findMany({ where: { campaignId: res.campaignId } });
    for (const r of rows) {
      const job = await emailQueue.getJob(r.bullJobId);
      await job!.changeDelay(0);
    }
    // Record when the Redis limiter granted each send.
    const grants: number[] = [];
    const spyLimiter = Object.create(limiter) as SenderRateLimiter;
    spyLimiter.reserve = async (input) => {
      const d = await limiter.reserve(input);
      if (d.kind === 'allowed') grants.push(input.now ?? Date.now());
      return d;
    };
    workers.push(startWorker({ transport, limiter: spyLimiter }, { concurrency: 10 }));
    await waitFor(async () => (await countByStatus(res.campaignId)).sent === 4);

    // Guarantee: grants are >= minDelay apart (atomic in Redis, across all workers).
    grants.sort((a, b) => a - b);
    for (let i = 1; i < grants.length; i++) expect(grants[i]! - grants[i - 1]!).toBeGreaterThanOrEqual(400);
    // Actual SMTP hand-off follows the grant after one DB write, so send gaps stay close to it.
    const times = transport.sent.map((s) => s.at).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(300);
  });

  it('retries transient SMTP failures with backoff, then succeeds', async () => {
    const { user, sender } = await createUserWithSender();
    const transport = new FakeTransport({ failTimes: 2 });
    run(transport);
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'Flaky', body: 'B', recipients: recipients(1), delayMs: 0 });
    await waitFor(async () => (await countByStatus(res.campaignId)).sent === 1);
    const row = await prisma.scheduledEmail.findFirstOrThrow({ where: { campaignId: res.campaignId } });
    expect(row).toMatchObject({ status: 'sent', attempts: 3, error: null });
  });

  it('marks the email failed after max attempts (and never sends it)', async () => {
    const { user, sender } = await createUserWithSender();
    const transport = new FakeTransport({ alwaysFail: true });
    run(transport);
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'Dead', body: 'B', recipients: recipients(1), delayMs: 0 });
    await waitFor(async () => (await countByStatus(res.campaignId)).failed === 1);
    const row = await prisma.scheduledEmail.findFirstOrThrow({ where: { campaignId: res.campaignId } });
    expect(row).toMatchObject({ status: 'failed', attempts: 3 });
    expect(row.error).toContain('SMTP 421');
    expect(row.failedAt).not.toBeNull();
  });

  it('skips cancelled emails', async () => {
    const { user, sender } = await createUserWithSender();
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'C', body: 'B', recipients: recipients(1), delayMs: 0, startAt: new Date(Date.now() + 1000).toISOString() });
    await prisma.scheduledEmail.updateMany({ where: { campaignId: res.campaignId }, data: { status: 'cancelled' } });
    const transport = new FakeTransport();
    run(transport);
    await sleep(2000);
    expect(transport.sent).toHaveLength(0);
  });
});

describe('hourly rate limit', () => {
  it('reschedules overflow to the next hour window (never drops), preserves order and notifies Slack once', async () => {
    const { user, sender } = await createUserWithSender();
    const transport = new FakeTransport();
    const notify = vi.fn(async () => true);
    run(transport, { concurrency: 1, notify });

    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'Limited', body: 'B', recipients: recipients(6), delayMs: 0, hourlyLimit: 2 });
    await waitFor(async () => {
      const c = await countByStatus(res.campaignId);
      const moved = await prisma.scheduledEmail.count({ where: { campaignId: res.campaignId, rescheduleCount: { gt: 0 } } });
      return c.sent === 2 && moved === 4;
    });

    const rows = await prisma.scheduledEmail.findMany({ where: { campaignId: res.campaignId }, orderBy: { sequence: 'asc' } });
    const pending = rows.filter((r) => r.status === 'scheduled');
    expect(pending).toHaveLength(4);
    const nextWindow = (Math.floor(Date.now() / HOUR_MS) + 1) * HOUR_MS;
    for (const r of pending) {
      expect(r.scheduledAt.getTime()).toBeGreaterThanOrEqual(nextWindow);
      expect(await emailQueue.getJobState(r.bullJobId)).toBe('delayed');
    }
    // Order preserved: later sequence => later (or equal-window later) slot.
    const times = pending.map((r) => r.scheduledAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // 4 overflow with limit 2/hour => 2 in the next window, 2 in the one after.
    expect(new Set(times.map((t) => Math.floor(t / HOUR_MS))).size).toBe(2);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(user.id, expect.objectContaining({ text: expect.stringContaining(sender.email) }));
  });

  it('delivers a real Slack webhook call when connected, and skips silently when not', async () => {
    const { user } = await createUserWithSender();
    expect(await notifyUser(user.id, { text: 'hi' })).toBe(false); // not connected: no throw

    const hookUrl = 'https://hooks.slack.com/services/T000/B000/XXXX';
    await prisma.slackConnection.create({
      data: { userId: user.id, teamId: 'T1', teamName: 'Team', channelId: 'C1', channelName: '#alerts', webhookUrl: encrypt(hookUrl), accessToken: encrypt('xoxb-test') },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    try {
      expect(await notifyUser(user.id, { text: 'limit hit' })).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(hookUrl, expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'limit hit' }) }));

      // Slack errors are swallowed (never break sending)
      fetchSpy.mockResolvedValueOnce(new Response('invalid_token', { status: 403 }));
      expect(await notifyUser(user.id, { text: 'x' })).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('restart persistence', () => {
  it('sends future emails after the worker is stopped and a new one starts, without duplicates', async () => {
    const { user, sender } = await createUserWithSender();
    const first = new FakeTransport();
    const w1 = run(first);
    const startAt = Date.now() + 2500;
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'Restart', body: 'B', recipients: recipients(3), delayMs: 300, startAt: new Date(startAt).toISOString() });

    // "Crash" before anything is due.
    await w1.close();
    workers = workers.filter((w) => w !== w1);
    expect(first.sent).toHaveLength(0);
    await sleep(500);

    // Restart: a brand-new worker (new process in real life) with startup reconciliation.
    await reconcile();
    const second = new FakeTransport();
    run(second);
    await waitFor(async () => (await countByStatus(res.campaignId)).sent === 3);
    expect(second.sent).toHaveLength(3);
    expect(Math.min(...second.sent.map((s) => s.at))).toBeGreaterThanOrEqual(startAt - 50);
  });

  it('reconcile re-creates jobs lost from Redis and is idempotent', async () => {
    const { user, sender } = await createUserWithSender();
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'Lost', body: 'B', recipients: recipients(3), delayMs: 0, startAt: new Date(Date.now() + 600_000).toISOString() });
    const rows = await prisma.scheduledEmail.findMany({ where: { campaignId: res.campaignId } });
    await (await emailQueue.getJob(rows[0]!.bullJobId))!.remove();
    await (await emailQueue.getJob(rows[1]!.bullJobId))!.remove();

    expect((await reconcile()).requeued).toBe(2);
    expect((await reconcile()).requeued).toBe(0);
    for (const r of rows) expect(await emailQueue.getJobState(r.bullJobId)).toBe('delayed');
    const job = await emailQueue.getJob(rows[0]!.bullJobId);
    expect(job!.opts.delay).toBeGreaterThan(590_000); // remaining delay, not restarted from scratch
  });

  it('marks emails stuck in processing (crash mid-send) as failed instead of resending', async () => {
    const { user, sender } = await createUserWithSender();
    const res = await scheduleCampaign(user.id, { senderId: sender.id, subject: 'Stuck', body: 'B', recipients: recipients(1), delayMs: 0, startAt: new Date(Date.now() + 600_000).toISOString() });
    await prisma.scheduledEmail.updateMany({ where: { campaignId: res.campaignId }, data: { status: 'processing', processingAt: new Date(Date.now() - 120_000) } });
    const r = await reconcile();
    expect(r.staleFailed).toBeGreaterThanOrEqual(1);
    const row = await prisma.scheduledEmail.findFirstOrThrow({ where: { campaignId: res.campaignId } });
    expect(row.status).toBe('failed');
    expect(row.error).toContain('Delivery state unknown');
  });
});
