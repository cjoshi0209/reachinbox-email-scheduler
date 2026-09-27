import { describe, expect, it } from 'vitest';
import { emailIdempotencyKey, normalizeRecipients, scheduleSchema } from '../../src/emails/emailService';
import { decrypt, encrypt } from '../../src/lib/crypto';
import { rateLimitMessage } from '../../src/slack/slackService';

describe('normalizeRecipients', () => {
  it('lowercases, trims, dedupes and keeps first-seen order', () => {
    const r = normalizeRecipients([' B@x.com', 'a@x.com', 'b@X.com', '', 'c@x.com']);
    expect(r.valid).toEqual(['b@x.com', 'a@x.com', 'c@x.com']);
    expect(r.duplicates).toBe(1);
    expect(r.invalid).toEqual([]);
  });

  it('reports invalid addresses', () => {
    const r = normalizeRecipients(['ok@x.com', 'nope', 'bad@', '@bad.com']);
    expect(r.valid).toEqual(['ok@x.com']);
    expect(r.invalid).toEqual(['nope', 'bad@', '@bad.com']);
  });
});

describe('emailIdempotencyKey', () => {
  it('is deterministic per campaign + normalized recipient', () => {
    expect(emailIdempotencyKey('c1', 'A@x.com ')).toBe(emailIdempotencyKey('c1', 'a@x.com'));
    expect(emailIdempotencyKey('c1', 'a@x.com')).not.toBe(emailIdempotencyKey('c2', 'a@x.com'));
    expect(emailIdempotencyKey('c1', 'a@x.com')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('scheduleSchema', () => {
  const base = { senderId: 's', subject: 'Hi', body: 'Body', recipients: ['a@x.com'] };
  it('applies defaults', () => {
    expect(scheduleSchema.parse(base)).toMatchObject({ delayMs: 0 });
  });
  it('rejects empty subject, empty recipients, negative delay and unknown fields', () => {
    expect(scheduleSchema.safeParse({ ...base, subject: ' ' }).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...base, recipients: [] }).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...base, delayMs: -1 }).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...base, hourlyLimit: 0 }).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...base, startAt: 'tomorrow' }).success).toBe(false);
  });
});

describe('crypto', () => {
  it('round-trips and uses a random IV', () => {
    const a = encrypt('s3cret');
    expect(a).not.toContain('s3cret');
    expect(a).not.toBe(encrypt('s3cret'));
    expect(decrypt(a)).toBe('s3cret');
  });
  it('detects tampering', () => {
    const parts = encrypt('s3cret').split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'))).toThrow();
  });
});

describe('rateLimitMessage', () => {
  it('includes sender, limit and next send time', () => {
    const m = rateLimitMessage({
      senderEmail: 'me@x.com',
      limit: 50,
      windowStart: new Date('2026-01-01T10:00:00Z'),
      nextSendAt: new Date('2026-01-01T11:00:00Z'),
    });
    expect(m.text).toContain('me@x.com');
    expect(m.text).toContain('50/hour');
    expect(m.text).toContain('2026-01-01 11:00 UTC');
  });
});
