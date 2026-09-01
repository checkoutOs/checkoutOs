// tests/unit/store/idempotency.store.test.ts
// Unit tests for the idempotency store (Redis operations).
//
// Uses the globally-wired ioredis-mock instance (vitest.setup.unit.ts replaces
// ioredis at module level), so no real Redis is needed.
//
// Known double limitations (verified via spike):
//   - ioredis-mock exposes no `.call()` method → setIdempotencyRecordIfNotExists
//     is tested by spying `redisClient.call` and delegating to the method-form
//     `.set(key, value, 'NX', 'EX', ttl)`, which behaves identically.
//   - ioredis-mock's Lua VM has no `cjson` library → forceUpdateIfInProgress's
//     script cannot execute; its wrapper logic is tested with a mocked `.eval`,
//     while true Lua behaviour (including the cjson status guard) is covered
//     by tests/integration/idempotency.test.ts against real Redis.
//
// Business invariants protected:
//   - SET NX refuses to overwrite an existing idempotency record (race safety)
//   - Atomic update only applies when the key exists (no orphan COMPLETED records)
//   - Corrupted JSON is treated as "not found", never crashes a request
//   - All ioredis failures surface as StoreError (never raw Redis errors)

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { redisClient } from '../../../src/store/redis.client';
import {
  getIdempotencyRecord,
  setIdempotencyRecordIfNotExists,
  updateIdempotencyRecord,
  forceUpdateIfInProgress,
} from '../../../src/store/idempotency.store';
import { StoreError } from '../../../src/errors/store.errors';
import type { IdempotencyRecord } from '../../../src/types/common.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    requestHash: 'hash_default_abc123',
    status: 'IN_PROGRESS',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Delegate redisClient.call('SET', ...) to ioredis-mock's method-form
// .set(), which implements NX/EX identically (spike-verified: first call
// returns 'OK', second returns null, original value preserved).
// NOTE: plain property assignment, not vi.spyOn — ioredis-mock defines no
// `call` property at all, so there is nothing for spyOn to wrap.
function delegateCallToSet(): void {
  const client = redisClient as unknown as Record<string, unknown>;
  client['call'] = async (...args: unknown[]) => {
    const [cmd, key, value, , , ttl] = args as [string, string, string, string, string, number];
    if (cmd !== 'SET') {
      throw new Error(`delegateCallToSet received unexpected command: ${cmd}`);
    }
    return await redisClient.set(key, value, 'NX', 'EX', ttl);
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// redis.client.ts uses lazyConnect: true + enableOfflineQueue: false — without
// an explicit connect() every command throws "Stream isn't writeable". In
// production connectRedis() handles this at startup; ioredis-mock's connect()
// resolves immediately.
beforeAll(async () => {
  await redisClient.connect();
});

beforeEach(async () => {
  await redisClient.flushall();
});

afterEach(() => {
  // Remove the manually assigned `call` delegate (vi.restoreAllMocks only
  // undoes vi.spyOn/vi.fn instances, not plain property assignments).
  delete (redisClient as unknown as Record<string, unknown>)['call'];
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// getIdempotencyRecord
// ---------------------------------------------------------------------------

describe('getIdempotencyRecord', () => {
  it('returns the parsed record after a set', async () => {
    delegateCallToSet();
    const record = makeRecord();
    await setIdempotencyRecordIfNotExists('key-1', record);

    const retrieved = await getIdempotencyRecord('key-1');
    expect(retrieved).toEqual(record);
  });

  it('returns null for a missing key', async () => {
    const retrieved = await getIdempotencyRecord('does-not-exist');
    expect(retrieved).toBeNull();
  });

  it('treats corrupted JSON as not-found instead of throwing', async () => {
    await redisClient.set('chk:idem:corrupt', 'this-is{not-json');
    const retrieved = await getIdempotencyRecord('corrupt');
    expect(retrieved).toBeNull();
  });

  it('wraps ioredis failures in StoreError', async () => {
    vi.spyOn(redisClient, 'get').mockRejectedValue(new Error('connection refused'));
    await expect(getIdempotencyRecord('any-key')).rejects.toThrow(StoreError);
  });
});

// ---------------------------------------------------------------------------
// setIdempotencyRecordIfNotExists
// ---------------------------------------------------------------------------

describe('setIdempotencyRecordIfNotExists', () => {
  it('sets a fresh key and returns true', async () => {
    delegateCallToSet();
    const result = await setIdempotencyRecordIfNotExists('key-nx-1', makeRecord());
    expect(result).toBe(true);
  });

  it('refuses to overwrite an existing key and returns false (NX)', async () => {
    delegateCallToSet();
    const original = makeRecord({ requestHash: 'original-hash' });
    const intruder = makeRecord({ requestHash: 'intruder-hash' });

    await setIdempotencyRecordIfNotExists('key-nx-2', original);
    const second = await setIdempotencyRecordIfNotExists('key-nx-2', intruder);

    expect(second).toBe(false);
    // Original record must be intact — this is what makes parallel
    // createPayment requests safe (loser of the race cannot clobber winner).
    const stored = await getIdempotencyRecord('key-nx-2');
    expect(stored?.requestHash).toBe('original-hash');
  });
});

// ---------------------------------------------------------------------------
// updateIdempotencyRecord (real Lua execution — script uses no cjson)
// ---------------------------------------------------------------------------

describe('updateIdempotencyRecord', () => {
  it('updates an existing record atomically (IN_PROGRESS -> COMPLETED)', async () => {
    delegateCallToSet();
    await setIdempotencyRecordIfNotExists('key-upd-1', makeRecord());

    const completed = makeRecord({
      requestHash: 'hash_default_abc123',
      status: 'COMPLETED',
      response: { paymentId: 'chk_test_payment_001', paymentUrl: 'https://pay.example' },
      updatedAt: '2026-01-01T00:01:00.000Z',
    });
    const updated = await updateIdempotencyRecord('key-upd-1', completed);
    expect(updated).toBe(true);

    const stored = await getIdempotencyRecord('key-upd-1');
    expect(stored?.status).toBe('COMPLETED');
    expect(stored?.response).toEqual({
      paymentId: 'chk_test_payment_001',
      paymentUrl: 'https://pay.example',
    });
  });

  it('returns false when the key does not exist (Lua guards against orphans)', async () => {
    const updated = await updateIdempotencyRecord('never-created', makeRecord());
    // If this returned true we could mark a request COMPLETED that was never
    // IN_PROGRESS — breaking the check() contract for concurrent retries.
    expect(updated).toBe(false);
  });

  it('wraps ioredis failures in StoreError', async () => {
    vi.spyOn(redisClient, 'eval').mockRejectedValue(new Error('script busy'));
    await expect(updateIdempotencyRecord('any-key', makeRecord())).rejects.toThrow(StoreError);
  });
});

// ---------------------------------------------------------------------------
// forceUpdateIfInProgress (script needs cjson — unavailable in ioredis-mock,
// so the Lua behaviour itself is integration-tested; here we pin the wrapper)
// ---------------------------------------------------------------------------

describe('forceUpdateIfInProgress', () => {
  it('returns true when the Lua guard allows the overwrite', async () => {
    const evalSpy = vi.spyOn(redisClient, 'eval').mockResolvedValue(1);

    const result = await forceUpdateIfInProgress('key-frc-1', makeRecord());

    expect(result).toBe(true);
    // Wrapper must pass: numKeys=1, prefixed key, serialised record, TTL last.
    const args = evalSpy.mock.calls[0] as unknown[];
    expect(args[0]).toContain('IN_PROGRESS'); // the status-guard script
    expect(args[1]).toBe(1); // KEYS count
    expect(args[2]).toBe('chk:idem:key-frc-1'); // buildKey prefix applied
    expect(String(args[4])).toBe(String(86400)); // IDEMPOTENCY_TTL_SECONDS
  });

  it('returns false when the record is not IN_PROGRESS (guard blocked)', async () => {
    vi.spyOn(redisClient, 'eval').mockResolvedValue(0);
    const result = await forceUpdateIfInProgress('key-frc-completed', makeRecord());
    // A COMPLETED record must NEVER be clobbered back to IN_PROGRESS —
    // otherwise a stale-recovery retry would erase a cached payment response.
    expect(result).toBe(false);
  });

  it('wraps ioredis failures in StoreError', async () => {
    vi.spyOn(redisClient, 'eval').mockRejectedValue(new Error('NOSCRIPT'));
    await expect(forceUpdateIfInProgress('any-key', makeRecord())).rejects.toThrow(StoreError);
  });
});
