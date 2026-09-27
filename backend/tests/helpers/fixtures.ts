import type { Sender } from '@prisma/client';
import { encrypt } from '../../src/lib/crypto';
import { prisma } from '../../src/lib/prisma';
import type { MailTransport, OutgoingEmail, SendResult } from '../../src/mail/mailer';
import { emailQueue } from '../../src/queue/emailQueue';
import { createTestUser } from './testUser';

/** Creates a user + sender. SMTP creds are dummies because tests use FakeTransport. */
export async function createUserWithSender() {
  const { user, token } = await createTestUser();
  const sender = await prisma.sender.create({
    data: {
      userId: user.id,
      name: 'Test Sender',
      email: `sender-${user.id}@ethereal.email`,
      smtpHost: 'smtp.ethereal.email',
      smtpPort: 587,
      smtpUser: 'user',
      smtpPass: encrypt('pass'),
    },
  });
  return { user, sender, token };
}

/** In-memory transport that records every send, with optional latency and failures. */
export class FakeTransport implements MailTransport {
  sent: { to: string; subject: string; messageId: string; at: number; senderId: string }[] = [];
  inFlight = 0;
  maxInFlight = 0;

  constructor(
    private readonly opts: { latencyMs?: number; failTimes?: number; alwaysFail?: boolean } = {},
  ) {}

  private failures = 0;

  async send(sender: Sender, email: OutgoingEmail): Promise<SendResult> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.opts.latencyMs) await sleep(this.opts.latencyMs);
      if (this.opts.alwaysFail || this.failures < (this.opts.failTimes ?? 0)) {
        this.failures++;
        throw new Error('SMTP 421 temporary failure');
      }
      this.sent.push({ to: email.to, subject: email.subject, messageId: email.messageId, at: Date.now(), senderId: sender.id });
      return { messageId: email.messageId, previewUrl: `https://ethereal.email/message/fake-${this.sent.length}` };
    } finally {
      this.inFlight--;
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => Promise<T | false | null | undefined>, timeoutMs = 20_000, intervalMs = 100): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

export async function resetQueue() {
  await emailQueue.obliterate({ force: true });
}

export const countByStatus = async (campaignId: string) => {
  const rows = await prisma.scheduledEmail.groupBy({ by: ['status'], where: { campaignId }, _count: true });
  return Object.fromEntries(rows.map((r) => [r.status, r._count])) as Record<string, number>;
};
