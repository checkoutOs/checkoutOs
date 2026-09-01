// tests/unit/services/idempotency.service.test.ts
// Unit tests for IdempotencyService business logic.
//
// Strategy: spy on the store namespace functions — the service imports
// `* as IdempotencyStore`, so vi.spyOn intercepts every internal call site
// without touching Redis.
//
// Business invariants protected:
//   - MISS is returned only when SET NX wins the race
//   - HIT returns the exact cached response for COMPLETED records
//   - Same key + different hash always throws IdempotencyKeyReusedError
//   - Race retries are bounded by IDEMPOTENCY_MAX_RETRIES, then IN_PROGRESS
//   - Stale IN_PROGRESS recovers via forceUpdateIfInProgress (atomic)
//   - completeIdempotency NEVER throws and never overwrites a foreign record

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as IdempotencyStore from '../../../src/store/idempotency.store';
import { checkIdempotency, completeIdempotency } from '../../../src/services/idempotency.service';
import { IdempotencyKeyReusedError } from '../../../src/errors/idempotency.errors';
import type { IdempotencyRecord } from '../../../src/types/common.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEY = '123e4567-e89b-42d3-a456-426614174000';
const HASH = 'hash_aaa111';

function inProgressRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  const now = new Date().toISOString();
  return {
    requestHash: HASH,
    status: 'IN_PROGRESS',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function completedRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return inProgressRecord({
    status: 'COMPLETED',
    response: { paymentId: 'chk_cached' },
    ...overrides,
  });
}

/** Spy all four store functions with inert defaults; tests override per case. */
function spyOnStore(): void {
  vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockResolvedValue(null);
  vi.spyOn(IdempotencyStore, 'setIdempotencyRecordIfNotExists').mockResolvedValue(true);
  vi.spyOn(IdempotencyStore, 'updateIdempotencyRecord').mockResolvedValue(true);
  vi.spyOn(IdempotencyStore, 'forceUpdateIfInProgress').mockResolvedValue(true);
}

beforeEach(() => {
  spyOnStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// checkIdempotency
// ---------------------------------------------------------------------------

describe('checkIdempotency', () => {
  it('returns MISS when no record exists and SET NX wins', async () => {
    const result = await checkIdempotency({ key: KEY, requestHash: HASH });

    expect(result).toEqual({ type: 'MISS' });
    expect(IdempotencyStore.setIdempotencyRecordIfNotExists).toHaveBeenCalledTimes(1);
    // Record must be created as IN_PROGRESS carrying OUR hash — a later
    // different-payload retry must be detected as a reuse violation.
    const createdRecord = vi.mocked(IdempotencyStore.setIdempotencyRecordIfNotExists).mock
      .calls[0][1] as IdempotencyRecord;
    expect(createdRecord.status).toBe('IN_PROGRESS');
    expect(createdRecord.requestHash).toBe(HASH);
  });

  it('returns HIT with the cached response for COMPLETED records', async () => {
    const cached = completedRecord();
    vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockResolvedValue(cached);

    const result = await checkIdempotency({ key: KEY, requestHash: HASH });

    expect(result).toEqual({ type: 'HIT', response: { paymentId: 'chk_cached' } });
    // A HIT must not write anything — dedup means zero side effects.
    expect(IdempotencyStore.setIdempotencyRecordIfNotExists).not.toHaveBeenCalled();
    expect(IdempotencyStore.updateIdempotencyRecord).not.toHaveBeenCalled();
  });

  it('returns IN_PROGRESS for a fresh IN_PROGRESS record (< stale window)', async () => {
    vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockResolvedValue(
      inProgressRecord({ updatedAt: new Date().toISOString() }),
    );

    const result = await checkIdempotency({ key: KEY, requestHash: HASH });

    expect(result).toEqual({ type: 'IN_PROGRESS' });
    // Fresh IN_PROGRESS must NOT trigger recovery — another live request owns it.
    expect(IdempotencyStore.forceUpdateIfInProgress).not.toHaveBeenCalled();
  });

  it('throws IdempotencyKeyReusedError when hash differs', async () => {
    vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockResolvedValue(
      inProgressRecord({ requestHash: 'hash_different_bbb222' }),
    );

    await expect(checkIdempotency({ key: KEY, requestHash: HASH })).rejects.toThrow(
      IdempotencyKeyReusedError,
    );
  });

  it('recovers a stale IN_PROGRESS record via forceUpdateIfInProgress', async () => {
    vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockResolvedValue(
      inProgressRecord({
        updatedAt: new Date(Date.now() - 31_000).toISOString(), // > 30s stale window
      }),
    );

    const result = await checkIdempotency({ key: KEY, requestHash: HASH });

    expect(result).toEqual({ type: 'MISS' });
    expect(IdempotencyStore.forceUpdateIfInProgress).toHaveBeenCalledTimes(1);
    // Recovery must carry the incoming hash so future mismatch detection works.
    const recovered = vi.mocked(IdempotencyStore.forceUpdateIfInProgress).mock
      .calls[0][1] as IdempotencyRecord;
    expect(recovered.requestHash).toBe(HASH);
  });

  it('returns IN_PROGRESS after exhausting race retries', async () => {
    // Every SET NX loses the race → loop must give up after MAX_RETRIES.
    vi.spyOn(IdempotencyStore, 'setIdempotencyRecordIfNotExists').mockResolvedValue(false);

    const result = await checkIdempotency({ key: KEY, requestHash: HASH });

    expect(result).toEqual({ type: 'IN_PROGRESS' });
    expect(IdempotencyStore.setIdempotencyRecordIfNotExists).toHaveBeenCalledTimes(3); // IDEMPOTENCY_MAX_RETRIES
  });

  it('re-evaluates and hits when a lost recovery race resolves to COMPLETED', async () => {
    // Attempt 1: stale IN_PROGRESS, but another worker wins forceUpdate.
    // Attempt 2 (retry): re-fetch now sees COMPLETED → HIT.
    vi.spyOn(IdempotencyStore, 'getIdempotencyRecord')
      .mockResolvedValueOnce(
        inProgressRecord({ updatedAt: new Date(Date.now() - 31_000).toISOString() }),
      )
      .mockResolvedValueOnce(completedRecord());
    vi.spyOn(IdempotencyStore, 'forceUpdateIfInProgress').mockResolvedValue(false);

    const result = await checkIdempotency({ key: KEY, requestHash: HASH });

    // Losing the recovery race must degrade gracefully into the correct
    // outcome (HIT), never into an error or a duplicate MISS.
    expect(result).toEqual({ type: 'HIT', response: { paymentId: 'chk_cached' } });
  });
});

// ---------------------------------------------------------------------------
// completeIdempotency
// ---------------------------------------------------------------------------

describe('completeIdempotency', () => {
  it('transitions IN_PROGRESS -> COMPLETED atomically on the happy path', async () => {
    vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockResolvedValue(inProgressRecord());

    const result = await completeIdempotency({
      key: KEY,
      requestHash: HASH,
      response: { paymentId: 'chk_new_payment' },
    });

    expect(result).toBe(true);
    const updatedRecord = vi.mocked(IdempotencyStore.updateIdempotencyRecord).mock
      .calls[0][1] as IdempotencyRecord;
    expect(updatedRecord.status).toBe('COMPLETED');
    expect(updatedRecord.response).toEqual({ paymentId: 'chk_new_payment' });
  });

  it('creates a COMPLETED record from scratch when none exists', async () => {
    vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockResolvedValue(null);

    const result = await completeIdempotency({
      key: KEY,
      requestHash: HASH,
      response: { paymentId: 'chk_orphan_complete' },
    });

    expect(result).toBe(true);
    const createdRecord = vi.mocked(IdempotencyStore.setIdempotencyRecordIfNotExists).mock
      .calls[0][1] as IdempotencyRecord;
    expect(createdRecord.status).toBe('COMPLETED');
  });

  it('returns false WITHOUT writing when hash mismatches (foreign record)', async () => {
    vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockResolvedValue(
      inProgressRecord({ requestHash: 'hash_foreign_fff999' }),
    );
    const updateSpy = vi.spyOn(IdempotencyStore, 'updateIdempotencyRecord');

    const result = await completeIdempotency({
      key: KEY,
      requestHash: HASH,
      response: { paymentId: 'chk_x' },
    });

    expect(result).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('never throws — swallows store failures and returns false', async () => {
    vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockRejectedValue(
      new Error('redis exploded'),
    );
    const updateSpy = vi.spyOn(IdempotencyStore, 'updateIdempotencyRecord');

    // Contract: a complete() failure must NEVER break the payment response,
    // so this call must resolve (false), not reject.
    await expect(completeIdempotency({ key: KEY, requestHash: HASH, response: {} })).resolves.toBe(
      false,
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
