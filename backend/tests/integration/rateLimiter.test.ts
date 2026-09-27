import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { HOUR_MS, SenderRateLimiter } from '../../src/queue/rateLimiter';

// Two independent connections = two "worker processes" sharing Redis.
const redisA = new IORedis('redis://localhost:6379/1');
const redisB = new IORedis('redis://localhost:6379/1');
const limiterA = new SenderRateLimiter(redisA);
const limiterB = new SenderRateLimiter(redisB);
afterAll(() => {
  redisA.disconnect();
  redisB.disconnect();
});

// Pin "now" to the start of an hour window so tests never straddle a boundary.
const windowStart = (Math.floor(Date.now() / HOUR_MS) + 10) * HOUR_MS;

describe('SenderRateLimiter (distributed hourly limit)', () => {
  it('allows exactly `limit` sends across concurrent callers on separate connections', async () => {
    const senderId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        (i % 2 ? limiterA : limiterB).reserve({ senderId, limitPerHour: 10, minDelayMs: 0, now: windowStart + i }),
      ),
    );
    const allowed = results.filter((r) => r.kind === 'allowed');
    const limited = results.filter((r) => r.kind === 'hourly_limit');
    expect(allowed).toHaveLength(10);
    expect(limited).toHaveLength(50);
    expect(await limiterA.usage(senderId, windowStart)).toBe(10);

    // Overflow positions are unique & gap-free, so no two emails get the same slot.
    const positions = limited.map((r) => (r.kind === 'hourly_limit' ? r.overflowPosition : 0)).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

    // Slack must be notified once per sender per window.
    expect(limited.filter((r) => r.kind === 'hourly_limit' && r.firstHit)).toHaveLength(1);
  });

  it('reschedules overflow into future windows in order, never more than `limit` per window', async () => {
    const senderId = randomUUID();
    const limit = 5;
    const decisions = [];
    for (let i = 0; i < 17; i++) decisions.push(await limiterA.reserve({ senderId, limitPerHour: limit, minDelayMs: 0, now: windowStart + i }));

    const targets = decisions.flatMap((d) => (d.kind === 'hourly_limit' ? [d.targetAt] : []));
    expect(targets).toHaveLength(12);
    // Strictly increasing => ordering preserved.
    for (let i = 1; i < targets.length; i++) expect(targets[i]!).toBeGreaterThan(targets[i - 1]!);
    // Every target is in a future window, with at most `limit` per window.
    const perWindow = new Map<number, number>();
    for (const t of targets) {
      const w = Math.floor(t / HOUR_MS);
      expect(t).toBeGreaterThanOrEqual(windowStart + HOUR_MS);
      perWindow.set(w, (perWindow.get(w) ?? 0) + 1);
    }
    expect([...perWindow.values()].every((n) => n <= limit)).toBe(true);
    expect([...perWindow.keys()]).toHaveLength(3); // 12 overflow / 5 per hour
  });

  it('starts a fresh counter in the next hour window', async () => {
    const senderId = randomUUID();
    await limiterA.reserve({ senderId, limitPerHour: 1, minDelayMs: 0, now: windowStart });
    const blocked = await limiterA.reserve({ senderId, limitPerHour: 1, minDelayMs: 0, now: windowStart + 1 });
    const nextHour = await limiterA.reserve({ senderId, limitPerHour: 1, minDelayMs: 0, now: windowStart + HOUR_MS + 1 });
    expect(blocked.kind).toBe('hourly_limit');
    expect(nextHour.kind).toBe('allowed');
  });

  it('keys limits per sender', async () => {
    const [s1, s2] = [randomUUID(), randomUUID()];
    await limiterA.reserve({ senderId: s1, limitPerHour: 1, minDelayMs: 0, now: windowStart });
    expect((await limiterA.reserve({ senderId: s2, limitPerHour: 1, minDelayMs: 0, now: windowStart })).kind).toBe('allowed');
    expect((await limiterA.reserve({ senderId: s1, limitPerHour: 1, minDelayMs: 0, now: windowStart })).kind).toBe('hourly_limit');
  });
});

describe('SenderRateLimiter (minimum delay between sends)', () => {
  it('reserves distinct, evenly spaced future slots for concurrent requests', async () => {
    const senderId = randomUUID();
    const now = windowStart;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => (i % 2 ? limiterA : limiterB).reserve({ senderId, limitPerHour: 100, minDelayMs: 1000, now })),
    );
    expect(results.filter((r) => r.kind === 'allowed')).toHaveLength(1);
    const slots = results.flatMap((r) => (r.kind === 'throttled' ? [r.slotAt] : [])).sort((a, b) => a - b);
    expect(slots).toEqual([now + 1000, now + 2000, now + 3000, now + 4000]);
  });

  it('lets a job send when it wakes up for its own reserved slot, and counts it', async () => {
    const senderId = randomUUID();
    const now = windowStart;
    await limiterA.reserve({ senderId, limitPerHour: 100, minDelayMs: 1000, now });
    const t = await limiterA.reserve({ senderId, limitPerHour: 100, minDelayMs: 1000, now });
    expect(t.kind).toBe('throttled');
    const slotAt = t.kind === 'throttled' ? t.slotAt : 0;
    const woke = await limiterA.reserve({ senderId, limitPerHour: 100, minDelayMs: 1000, reservedSlotAt: slotAt, reservationCounted: true, now: slotAt + 5 });
    expect(woke).toEqual({ kind: 'allowed', countInWindow: 2 });
  });

  it('regression: a late slot holder cannot make the next holder send too soon', async () => {
    const senderId = randomUUID();
    const now = windowStart;
    const r = (reservedSlotAt?: number, at = now) =>
      limiterA.reserve({ senderId, limitPerHour: 100, minDelayMs: 400, reservedSlotAt, reservationCounted: Boolean(reservedSlotAt), now: at });
    await r(); // A sends at t
    const b = await r(); // B -> slot t+400
    const c = await r(); // C -> slot t+800
    const bSlot = b.kind === 'throttled' ? b.slotAt : 0;
    const cSlot = c.kind === 'throttled' ? c.slotAt : 0;
    expect([bSlot, cSlot]).toEqual([now + 400, now + 800]);

    expect((await r(bSlot, bSlot + 150)).kind).toBe('allowed'); // B runs 150ms late
    // C is on time, but only 250ms after B's real send: it must wait the remaining 150ms.
    expect(await r(cSlot, cSlot)).toEqual({ kind: 'wait', waitMs: 150 });
    expect((await r(cSlot, cSlot + 150)).kind).toBe('allowed');
  });

  it('backlog after downtime: stale holders are spaced out, never burst', async () => {
    const senderId = randomUUID();
    const now = windowStart;
    const minDelayMs = 5000; // larger than the 1s in-process wait budget
    const r = (reservedSlotAt?: number, at = now) => limiterA.reserve({ senderId, limitPerHour: 100, minDelayMs, reservedSlotAt, now: at });
    // Three jobs held slots in the past (worker was down); all wake up at the same moment.
    const wake = now + 360_000;
    const decisions = [await r(now + 10, wake), await r(now + 20, wake), await r(now + 30, wake)];
    expect(decisions[0]!.kind).toBe('allowed');
    // The others are re-queued at distinct future slots, minDelay apart.
    expect(decisions.slice(1)).toEqual([
      { kind: 'throttled', slotAt: wake + minDelayMs, counted: true },
      { kind: 'throttled', slotAt: wake + 2 * minDelayMs, counted: true },
    ]);
  });
});

describe('SenderRateLimiter (limit + min delay together)', () => {
  it('a burst reserves only as many slots as the hourly budget allows; the rest overflows immediately', async () => {
    const senderId = randomUUID();
    const now = windowStart;
    const decisions = [];
    for (let i = 0; i < 1000; i++) decisions.push(await limiterA.reserve({ senderId, limitPerHour: 3, minDelayMs: 2000, now }));
    expect(decisions.filter((d) => d.kind === 'allowed')).toHaveLength(1);
    expect(decisions.filter((d) => d.kind === 'throttled')).toHaveLength(2); // 1 sent + 2 reserved = 3
    expect(decisions.filter((d) => d.kind === 'hourly_limit')).toHaveLength(997);

    // The two holders still get to send at their slots (they own reserved budget).
    const holders = decisions.flatMap((d) => (d.kind === 'throttled' ? [d] : []));
    for (const h of holders) {
      const woke = await limiterA.reserve({ senderId, limitPerHour: 3, minDelayMs: 2000, reservedSlotAt: h.slotAt, reservationCounted: h.counted, now: h.slotAt });
      expect(woke.kind).toBe('allowed');
    }
    expect(await limiterA.usage(senderId, now)).toBe(3);
    // Budget exhausted for the hour.
    expect((await limiterA.reserve({ senderId, limitPerHour: 3, minDelayMs: 2000, now: now + 10_000 })).kind).toBe('hourly_limit');
  });
});
