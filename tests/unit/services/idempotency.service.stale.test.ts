// tests/unit/services/idempotency.service.stale.test.ts
// Boundary tests for the 30-second stale IN_PROGRESS auto-recovery window.
//
// Isolated into its own file (per the implementation plan) because it freezes
// time with fake timers, which must not leak into other service tests.
//
// Business invariants protected:
//   - At exactly IDEMPOTENCY_STALE_TIMEOUT_MS (30s) a record is NOT stale
//     (isStale uses strict >) — a live request is never stolen mid-flight
//   - Just past the threshold (30s + 1ms) recovery kicks in exactly once
//   - Recovery overwrites atomically via forceUpdateIfInProgress

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as IdempotencyStore from '../../../src/store/idempotency.store';
import { checkIdempotency } from '../../../src/services/idempotency.service';
import { IdempotencyKeyReusedError } from '../../../src/errors/idempotency.errors';
import {
  IDEMPOTENCY_STALE_TIMEOUT_MS,
  type IdempotencyRecord,
} from '../../../src/types/common.types';

const KEY = 'stale-test-key';
const HASH = 'hash_stale_001';

function recordUpdatedAt(msAgo: number): IdempotencyRecord {
  return {
    requestHash: HASH,
    status: 'IN_PROGRESS',
    createdAt: new Date(Date.now() - msAgo).toISOString(),
    updatedAt: new Date(Date.now() - msAgo).toISOString(),
  };
}

beforeEach(() => {
  // Freeze Date.now() at a fixed instant so staleness maths is exact.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));

  vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockResolvedValue(recordUpdatedAt(0));
  vi.spyOn(IdempotencyStore, 'setIdempotencyRecordIfNotExists').mockResolvedValue(true);
  vi.spyOn(IdempotencyStore, 'updateIdempotencyRecord').mockResolvedValue(true);
  vi.spyOn(IdempotencyStore, 'forceUpdateIfInProgress').mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('checkIdempotency — stale IN_PROGRESS boundary (Issue 7)', () => {
  it('treats a record at exactly the threshold as fresh IN_PROGRESS', async () => {
    const thresholdMs = IDEMPOTENCY_STALE_TIMEOUT_MS; // 30_000
    vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockResolvedValue(
      recordUpdatedAt(thresholdMs),
    );

    // Strict > in isStale(): age == threshold is NOT stale.
    const result = await checkIdempotency({ key: KEY, requestHash: HASH });

    expect(result).toEqual({ type: 'IN_PROGRESS' });
    expect(IdempotencyStore.forceUpdateIfInProgress).not.toHaveBeenCalled();
  });

  it('recovers via forceUpdateIfInProgress one millisecond past the threshold', async () => {
    vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockResolvedValue(
      recordUpdatedAt(IDEMPOTENCY_STALE_TIMEOUT_MS + 1),
    );

    const result = await checkIdempotency({ key: KEY, requestHash: HASH });

    expect(result).toEqual({ type: 'MISS' });
    expect(IdempotencyStore.forceUpdateIfInProgress).toHaveBeenCalledTimes(1);
  });

  it('advanceTimersByTime(31s) crosses the threshold and triggers recovery once', async () => {
    // Record created "now"; simulate the original request crashing, then a
    // client retry arriving 31 seconds later (plan-mandated scenario).
    vi.advanceTimersByTime(31_000);

    const result = await checkIdempotency({ key: KEY, requestHash: HASH });

    expect(result).toEqual({ type: 'MISS' });
    expect(IdempotencyStore.forceUpdateIfInProgress).toHaveBeenCalledTimes(1);
  });

  it('advanceTimersByTime(29s) stays inside the window — no recovery', async () => {
    vi.advanceTimersByTime(29_000);

    const result = await checkIdempotency({ key: KEY, requestHash: HASH });

    expect(result).toEqual({ type: 'IN_PROGRESS' });
    expect(IdempotencyStore.forceUpdateIfInProgress).not.toHaveBeenCalled();
  });

  it('does not recover when the stored hash differs even if stale', async () => {
    // Hash validation happens BEFORE staleness checks: a stale record for a
    // DIFFERENT payload still indicates key reuse, not a crashed request.
    vi.spyOn(IdempotencyStore, 'getIdempotencyRecord').mockResolvedValue({
      ...recordUpdatedAt(60_000),
      requestHash: 'hash_other_payload',
    });

    await expect(checkIdempotency({ key: KEY, requestHash: HASH })).rejects.toThrow(
      IdempotencyKeyReusedError,
    );
    expect(IdempotencyStore.forceUpdateIfInProgress).not.toHaveBeenCalled();
  });
});
