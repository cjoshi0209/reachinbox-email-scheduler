import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/lib/prisma';
import { ensureIndex, es } from '../../src/search/elastic';
import { createUserWithSender, resetQueue } from '../helpers/fixtures';
import { createTestUser } from '../helpers/testUser';

const app = createApp();
const cookie = (token: string) => [`rb_session=${token}`];

beforeAll(async () => {
  await resetQueue();
  await ensureIndex();
});

describe('public endpoints', () => {
  it('GET /health reports dependencies', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ postgres: 'ok', redis: 'ok', elasticsearch: 'ok', status: 'ok' });
  });

  it('sets security headers (helmet)', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('GET /auth/google redirects to the login page when Google is not configured', async () => {
    const res = await request(app).get('/auth/google');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login\?error=google_not_configured$/);
  });

  it('GET /auth/google/callback rejects a missing/forged state', async () => {
    const res = await request(app).get('/auth/google/callback?code=abc&state=forged');
    expect(res.headers.location).toMatch(/error=invalid_state/);
  });

  it('GET /auth/slack/callback rejects an unsigned state', async () => {
    const res = await request(app).get('/auth/slack/callback?code=abc&state=nope');
    expect(res.headers.location).toMatch(/slack=invalid_state/);
  });
});

describe('authentication', () => {
  it('protects API routes', async () => {
    for (const path of ['/api/auth/me', '/api/emails/scheduled', '/api/emails/sent', '/api/emails/search?q=x', '/api/senders', '/api/slack/status']) {
      expect((await request(app).get(path)).status, path).toBe(401);
    }
    expect((await request(app).post('/api/emails/schedule').send({})).status).toBe(401);
  });

  it('rejects a tampered session cookie', async () => {
    const { token } = await createTestUser();
    const res = await request(app).get('/api/auth/me').set('Cookie', cookie(`${token}x`));
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me returns the profile; POST /auth/logout clears the cookie', async () => {
    const { user, token } = await createTestUser();
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie(token));
    expect(me.body).toEqual({ id: user.id, email: user.email, name: user.name, avatarUrl: null });
    const out = await request(app).post('/auth/logout').set('Cookie', cookie(token));
    expect(out.status).toBe(204);
    expect(out.headers['set-cookie']?.[0]).toMatch(/rb_session=;/);
  });
});

describe('Bull Board', () => {
  it('is not public', async () => {
    const res = await request(app).get('/admin/queues');
    expect(res.status).toBe(401); // basic-auth challenge (BULL_BOARD_USER set in tests)
    expect(res.headers['www-authenticate']).toContain('Basic');
  });
  it('is available to a logged-in user or with basic auth', async () => {
    const { token } = await createTestUser();
    expect((await request(app).get('/admin/queues').set('Cookie', cookie(token))).status).toBe(200);
    expect((await request(app).get('/admin/queues').auth('admin', 'secret-pass')).status).toBe(200);
    expect((await request(app).get('/admin/queues').auth('admin', 'wrong')).status).toBe(401);
  });
});

describe('emails API', () => {
  it('validates the schedule payload', async () => {
    const { token, sender } = await createUserWithSender();
    const bad = await request(app).post('/api/emails/schedule').set('Cookie', cookie(token)).send({ senderId: sender.id, subject: '', body: 'x', recipients: [] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Validation failed');

    const invalidEmails = await request(app)
      .post('/api/emails/schedule')
      .set('Cookie', cookie(token))
      .send({ senderId: sender.id, subject: 's', body: 'b', recipients: ['ok@x.com', 'broken'] });
    expect(invalidEmails.status).toBe(400);
    expect(invalidEmails.body.details.invalid).toEqual(['broken']);

    const otherSender = await request(app).post('/api/emails/schedule').set('Cookie', cookie(token)).send({ senderId: 'nope', subject: 's', body: 'b', recipients: ['a@x.com'] });
    expect(otherSender.status).toBe(400);
  });

  it('schedules (201), replays with the same Idempotency-Key (200), lists, searches and fetches detail', async () => {
    const { token, sender } = await createUserWithSender();
    const tag = randomUUID().slice(0, 8);
    const body = {
      senderId: sender.id,
      subject: `Quarterly roadmap ${tag}`,
      body: 'Let us sync about the roadmap',
      recipients: [`alice-${tag}@acme.com`, `bob-${tag}@acme.com`],
      startAt: new Date(Date.now() + 3_600_000).toISOString(),
      delayMs: 1000,
      hourlyLimit: 50,
    };
    const key = `idem-${tag}`;
    const first = await request(app).post('/api/emails/schedule').set('Cookie', cookie(token)).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ scheduled: 2, replayed: false, hourlyLimit: 50 });

    const again = await request(app).post('/api/emails/schedule').set('Cookie', cookie(token)).set('Idempotency-Key', key).send(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ campaignId: first.body.campaignId, replayed: true });

    const list = await request(app).get('/api/emails/scheduled').set('Cookie', cookie(token));
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((i: { recipient: string }) => i.recipient)).toEqual([`alice-${tag}@acme.com`, `bob-${tag}@acme.com`]);
    expect(list.body.items[0]).not.toHaveProperty('idempotencyKey');

    expect((await request(app).get('/api/emails/sent').set('Cookie', cookie(token))).body.total).toBe(0);

    // Elasticsearch: full-text on subject, recipient and body.
    await es.indices.refresh({ index: 'emails_test' });
    const bySubject = await request(app).get(`/api/emails/search?q=roadmap ${tag}`).set('Cookie', cookie(token));
    expect(bySubject.body).toMatchObject({ source: 'elasticsearch', total: 2 });
    const byRecipient = await request(app).get(`/api/emails/search?q=bob-${tag}`).set('Cookie', cookie(token));
    expect(byRecipient.body.items.map((i: { recipient: string }) => i.recipient)).toContain(`bob-${tag}@acme.com`);
    const byStatus = await request(app).get(`/api/emails/search?q=${tag}&status=sent`).set('Cookie', cookie(token));
    expect(byStatus.body.total).toBe(0);

    const id = list.body.items[0].id as string;
    const detail = await request(app).get(`/api/emails/${id}`).set('Cookie', cookie(token));
    expect(detail.body).toMatchObject({ id, status: 'scheduled', campaign: { delayMs: 1000, hourlyLimit: 50, totalEmails: 2 } });

    // Cancel: DB state, queue job removed, ES updated.
    const cancel = await request(app).post(`/api/emails/${id}/cancel`).set('Cookie', cookie(token));
    expect(cancel.body).toEqual({ id, status: 'cancelled' });
    expect((await request(app).post(`/api/emails/${id}/cancel`).set('Cookie', cookie(token))).status).toBe(409);
    await es.indices.refresh({ index: 'emails_test' });
    const cancelled = await request(app).get(`/api/emails/search?q=${tag}&status=cancelled`).set('Cookie', cookie(token));
    expect(cancelled.body.total).toBe(1);
  });

  it('matches an exact email address without fuzzy look-alikes', async () => {
    const { token, sender } = await createUserWithSender();
    const d = `d${randomUUID().slice(0, 6)}.com`;
    await request(app)
      .post('/api/emails/schedule')
      .set('Cookie', cookie(token))
      .send({ senderId: sender.id, subject: 'Look-alikes', body: 'x', recipients: [`dame@${d}`, `tame@${d}`, `game@${d}`], startAt: new Date(Date.now() + 3_600_000).toISOString() });
    await es.indices.refresh({ index: 'emails_test' });
    const res = await request(app).get(`/api/emails/search?q=dame@${d}`).set('Cookie', cookie(token));
    expect(res.body.items.map((i: { recipient: string }) => i.recipient)).toEqual([`dame@${d}`]);
    // Typo tolerance still works for longer words ("alikse" -> "alikes").
    const fuzzy = await request(app).get('/api/emails/search?q=alikse').set('Cookie', cookie(token));
    expect(fuzzy.body.total).toBe(3);
  });

  it("does not leak other users' emails", async () => {
    const a = await createUserWithSender();
    const b = await createUserWithSender();
    const res = await request(app)
      .post('/api/emails/schedule')
      .set('Cookie', cookie(a.token))
      .send({ senderId: a.sender.id, subject: 'Private thing', body: 'x', recipients: ['p@x.com'], startAt: new Date(Date.now() + 3_600_000).toISOString() });
    const row = await prisma.scheduledEmail.findFirstOrThrow({ where: { campaignId: res.body.campaignId } });
    expect((await request(app).get(`/api/emails/${row.id}`).set('Cookie', cookie(b.token))).status).toBe(404);
    await es.indices.refresh({ index: 'emails_test' });
    expect((await request(app).get('/api/emails/search?q=Private').set('Cookie', cookie(b.token))).body.total).toBe(0);
    // b cannot schedule with a's sender
    expect(
      (await request(app).post('/api/emails/schedule').set('Cookie', cookie(b.token)).send({ senderId: a.sender.id, subject: 's', body: 'b', recipients: ['q@x.com'] })).status,
    ).toBe(400);
  });

  it('lists senders without exposing SMTP secrets, and exposes stats', async () => {
    const { token } = await createUserWithSender();
    const res = await request(app).get('/api/senders').set('Cookie', cookie(token));
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).not.toHaveProperty('smtpPass');
    expect(res.body.items[0]).not.toHaveProperty('smtpUser');
    expect(res.body.maxPerHour).toBe(1000);
    const stats = await request(app).get('/api/emails/stats').set('Cookie', cookie(token));
    expect(stats.body).toMatchObject({ scheduled: 0, sent: 0, upcoming: 0 });
  });

  it('reports Slack status and disconnect is idempotent', async () => {
    const { token } = await createUserWithSender();
    const status = await request(app).get('/api/slack/status').set('Cookie', cookie(token));
    expect(status.body).toMatchObject({ connected: false });
    expect((await request(app).delete('/api/slack/disconnect').set('Cookie', cookie(token))).status).toBe(204);
    expect((await request(app).post('/api/slack/test').set('Cookie', cookie(token))).status).toBe(409);
  });
});
