import type { Redis } from 'ioredis';

export const HOUR_MS = 3_600_000;

/**
 * One atomic Lua script decides, per sender, whether an email may be sent right now.
 * Because it runs inside Redis, the decision is consistent across any number of
 * worker processes / machines - there is no in-memory state.
 *
 * Hourly state per sender+window:
 *   countKey    = sends granted in this clock hour (authoritative: a grant needs count < limit)
 *   reservedKey = min-delay slots reserved (not yet sent) in this hour. New arrivals overflow
 *                 as soon as count + reserved >= limit, so a burst of 1000 is rescheduled
 *                 immediately instead of each job first waiting for a throttle slot.
 *
 * Min-delay state per sender:
 *   grantKey = time of the last actual grant. Invariant: grants are >= minDelay apart.
 *   tailKey  = the latest reserved future slot (FIFO queue tail).
 *
 * Returns:
 *   {0, count}          allowed: hourly counter incremented, send now
 *   {1, n, firstHit}    hourly limit reached: n = position in this window's overflow queue,
 *                       firstHit = 1 only for the first overflow of this sender+window (Slack once)
 *   {2, slotAt}         throttled: a future send slot was reserved for this job (queue tail)
 *   {3, waitMs}         this job's slot has come but the previous send ran late: wait briefly
 *
 * Keys use a {senderId} hash tag so they live in the same slot on Redis Cluster.
 */
const SCRIPT = `
local countKey    = KEYS[1]
local grantKey    = KEYS[2]
local overflowKey = KEYS[3]
local notifiedKey = KEYS[4]
local tailKey     = KEYS[5]
local reservedKey = KEYS[6]
local holderKey   = KEYS[7]
local now         = tonumber(ARGV[1])
local windowMs    = tonumber(ARGV[2])
local limit       = tonumber(ARGV[3])
local minDelay    = tonumber(ARGV[4])
local reservedAt  = tonumber(ARGV[5])
local maxWait     = tonumber(ARGV[6])
local counted     = tonumber(ARGV[7]) == 1

local isHolder = reservedAt > 0
local function release()
  if isHolder and counted then
    if tonumber(redis.call('GET', holderKey) or '0') > 0 then redis.call('DECR', holderKey) end
    isHolder = false
  end
end

local function overflow()
  release()
  local n = redis.call('INCR', overflowKey)
  redis.call('PEXPIRE', overflowKey, windowMs * 2)
  local first = redis.call('SET', notifiedKey, '1', 'NX', 'PX', windowMs * 2)
  if first then return {1, n, 1} end
  return {1, n, 0}
end

local count = tonumber(redis.call('GET', countKey) or '0')
local reserved = tonumber(redis.call('GET', reservedKey) or '0')
-- Holders already own one of the reserved units, so only the sent count applies to them.
if count >= limit or (not isHolder and count + reserved >= limit) then
  return overflow()
end

if minDelay > 0 then
  local lastGrant = tonumber(redis.call('GET', grantKey) or '0')
  local earliest = lastGrant + minDelay
  local canGrant = false

  if isHolder and now < reservedAt then
    -- Woke before its own slot (clock skew): keep the slot.
    return {2, reservedAt}
  elseif isHolder then
    -- Slot holder: its turn has come; only the actual spacing can hold it back.
    if now >= earliest then
      canGrant = true
    elseif earliest - now <= maxWait then
      return {3, earliest - now}
    else
      -- Far behind (e.g. after downtime): give the slot up and re-queue at the tail.
      release()
      if count + reserved - 1 >= limit then return overflow() end
    end
  end

  if not canGrant then
    local tail = tonumber(redis.call('GET', tailKey) or '0')
    local slot = math.max(tail + minDelay, earliest)
    if slot > now then
      redis.call('SET', tailKey, tostring(slot), 'PX', (slot - now) + minDelay * 2 + 1000)
      if math.floor(slot / windowMs) == math.floor(now / windowMs) then
        redis.call('INCR', reservedKey)
        redis.call('PEXPIRE', reservedKey, windowMs * 2)
        return {2, slot, 1}
      end
      return {2, slot, 0}
    end
  end

  redis.call('SET', grantKey, tostring(now), 'PX', minDelay * 2 + 1000)
end

release()
count = redis.call('INCR', countKey)
redis.call('PEXPIRE', countKey, windowMs * 2)
return {0, count}
`;

/** A slot holder blocked by a late predecessor waits in-process up to this long. */
const MAX_INLINE_WAIT_MS = 1000;

export type RateDecision =
  | { kind: 'allowed'; countInWindow: number }
  | { kind: 'throttled'; slotAt: number; counted: boolean }
  | { kind: 'wait'; waitMs: number }
  | { kind: 'hourly_limit'; targetAt: number; firstHit: boolean; windowStart: number; overflowPosition: number };

export interface ReserveInput {
  senderId: string;
  limitPerHour: number;
  minDelayMs: number;
  reservedSlotAt?: number;
  /** Whether that slot was counted in its window's reserved budget (from the throttled decision). */
  reservationCounted?: boolean;
  now?: number;
}

export class SenderRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly windowMs = HOUR_MS,
  ) {
    this.redis.defineCommand('reserveSend', { numberOfKeys: 7, lua: SCRIPT });
  }

  windowOf(ts: number): number {
    return Math.floor(ts / this.windowMs);
  }

  keys(senderId: string, window: number) {
    const tag = `{${senderId}}`;
    return {
      count: `rl:${tag}:count:${window}`,
      grant: `rl:${tag}:grant`,
      overflow: `rl:${tag}:overflow:${window}`,
      notified: `rl:${tag}:notified:${window}`,
      tail: `rl:${tag}:tail`,
      reserved: `rl:${tag}:reserved:${window}`,
    };
  }

  async reserve(input: ReserveInput): Promise<RateDecision> {
    const now = input.now ?? Date.now();
    const window = this.windowOf(now);
    const k = this.keys(input.senderId, window);
    const holderWindow = input.reservedSlotAt ? this.windowOf(input.reservedSlotAt) : window;
    const res = (await (this.redis as unknown as ReserveCommand).reserveSend(
      k.count,
      k.grant,
      k.overflow,
      k.notified,
      k.tail,
      k.reserved,
      this.keys(input.senderId, holderWindow).reserved,
      now,
      this.windowMs,
      input.limitPerHour,
      input.minDelayMs,
      input.reservedSlotAt ?? 0,
      MAX_INLINE_WAIT_MS,
      input.reservationCounted ? 1 : 0,
    )) as number[];

    const [code, a = 0, b = 0] = res;
    if (code === 0) return { kind: 'allowed', countInWindow: a };
    if (code === 2) return { kind: 'throttled', slotAt: a, counted: b === 1 };
    if (code === 3) return { kind: 'wait', waitMs: a };

    // Hourly limit hit: place the job into a future window without dropping it.
    // Overflow position n (assigned atomically, in processing order) decides the window
    // and an evenly spread offset inside it, which preserves ordering and avoids a
    // thundering herd at the top of the next hour.
    const n = a;
    const windowsAhead = 1 + Math.floor((n - 1) / input.limitPerHour);
    const targetWindowStart = (window + windowsAhead) * this.windowMs;
    const spacing = Math.floor(this.windowMs / input.limitPerHour);
    const offset = ((n - 1) % input.limitPerHour) * spacing;
    return {
      kind: 'hourly_limit',
      targetAt: targetWindowStart + offset,
      firstHit: b === 1,
      windowStart: window * this.windowMs,
      overflowPosition: n,
    };
  }

  /** Current usage, for the UI / diagnostics. */
  async usage(senderId: string, now = Date.now()): Promise<number> {
    const k = this.keys(senderId, this.windowOf(now));
    return Number((await this.redis.get(k.count)) ?? 0);
  }
}

interface ReserveCommand {
  reserveSend(...args: (string | number)[]): Promise<unknown>;
}
