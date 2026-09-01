// idempotency.service.ts
// Business logic for idempotency deduplication of POST /payments.
//
// Public API:
//   checkIdempotency(params)  → MISS (proceed) / HIT (return cached) / IN_PROGRESS (409)
//   completeIdempotency(params) → mark request as COMPLETED after successful payment
//
// Invariants:
//   - completeIdempotency() never throws: payment response always takes priority
//   - Stale IN_PROGRESS records (>= IDEMPOTENCY_STALE_TIMEOUT_MS) auto-recover
//   - Race conditions handled by iterative retry up to IDEMPOTENCY_MAX_RETRIES

import * as IdempotencyStore from '../store/idempotency.store';
import { IdempotencyKeyReusedError } from '../errors/idempotency.errors';
import { createContextLogger } from '../utils/logger';
import { now } from '../utils/time';
import {
  IDEMPOTENCY_MAX_RETRIES,
  IDEMPOTENCY_STALE_TIMEOUT_MS,
  type IdempotencyCheckParams,
  type IdempotencyCheckResult,
  type IdempotencyCompleteParams,
  type IdempotencyRecord,
} from '../types/common.types';

const log = createContextLogger('idempotency-service');

// Returns true if the IN_PROGRESS record is stale (older than the stale
// threshold). Handles the case where the original request crashed before
// completeIdempotency() was called — the payment may or may not have been
// created on the gateway. Stale recovery lets a retry treat this as MISS.
function isStale(updatedAt: string): boolean {
  const updated = new Date(updatedAt).getTime();
  const current = Date.now();
  return current - updated > IDEMPOTENCY_STALE_TIMEOUT_MS;
}

// Build a fresh IN_PROGRESS record for a new or recovered request.
function buildInProgressRecord(requestHash: string): IdempotencyRecord {
  const timestamp = now();
  return {
    requestHash,
    status: 'IN_PROGRESS',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

// Check idempotency status for an incoming request.
//
// Throws:
//   IdempotencyKeyReusedError — same key with different request hash (400)
//
// Race-condition handling:
//   Uses iterative retry up to IDEMPOTENCY_MAX_RETRIES. If SET NX fails because
//   another request created the record between our GET and SET NX, we re-fetch
//   and re-evaluate with the new state. After exhaustion we return IN_PROGRESS
//   (safe default — caller surfaces a 409).
//
// Stale recovery:
//   IN_PROGRESS records older than IDEMPOTENCY_STALE_TIMEOUT_MS (30s) are
//   atomically overwritten via Lua forceUpdateIfInProgress, which only
//   overwrites if the stored status is still IN_PROGRESS. This handles the
//   case where a server crash prevented completeIdempotency() from running.
export async function checkIdempotency(
  params: IdempotencyCheckParams,
): Promise<IdempotencyCheckResult> {
  const { key, requestHash } = params;
  let retries = IDEMPOTENCY_MAX_RETRIES;

  while (retries > 0) {
    const existing = await IdempotencyStore.getIdempotencyRecord(key);

    // Case 1: No existing record — create IN_PROGRESS via SET NX.
    if (!existing) {
      const record = buildInProgressRecord(requestHash);
      const created = await IdempotencyStore.setIdempotencyRecordIfNotExists(key, record);
      if (created) {
        log.info('idempotency.miss', { key, requestHash });
        return { type: 'MISS' };
      }

      // Another request created the record between our GET and SET NX.
      // Retry the loop to re-evaluate with the new state.
      retries--;
      log.debug('idempotency.race_retry', { key, retriesLeft: retries });
      continue;
    }

    // Case 2: Existing record with different hash — client error.
    if (existing.requestHash !== requestHash) {
      log.warn('idempotency.hash_mismatch', {
        key,
        existingHash: existing.requestHash,
        newHash: requestHash,
      });
      throw new IdempotencyKeyReusedError(key);
    }

    // Case 3: Completed record — return cached response.
    if (existing.status === 'COMPLETED') {
      log.debug('idempotency.hit', { key });
      return { type: 'HIT', response: existing.response as unknown };
    }

    // Case 4: IN_PROGRESS but stale — recover atomically.
    if (existing.status === 'IN_PROGRESS' && isStale(existing.updatedAt)) {
      log.warn('idempotency.stale_in_progress', {
        key,
        updatedAt: existing.updatedAt,
        stalenessMs: Date.now() - new Date(existing.updatedAt).getTime(),
      });

      // Atomic Lua: only overwrites if status is still IN_PROGRESS.
      // Two concurrent recoveries cannot both succeed (one returns 1).
      const newRecord = buildInProgressRecord(requestHash);
      const overwritten = await IdempotencyStore.forceUpdateIfInProgress(key, newRecord);
      if (overwritten) {
        log.info('idempotency.stale_overwritten', { key });
        return { type: 'MISS' };
      }

      // Another recovery won the race — re-evaluate.
      retries--;
      log.debug('idempotency.stale_race_retry', { key, retriesLeft: retries });
      continue;
    }

    // Case 5: Fresh IN_PROGRESS — another request is processing.
    log.debug('idempotency.in_progress', { key, updatedAt: existing.updatedAt });
    return { type: 'IN_PROGRESS' };
  }

  // Retries exhausted — return IN_PROGRESS so the caller surfaces a 409.
  // The client may retry after the stale timeout window (30s) for auto-recovery.
  log.error('idempotency.race_condition_retry_exhausted', { key });
  return { type: 'IN_PROGRESS' };
}

// Mark the idempotency request as COMPLETED with the payment response.
// Called after the payment is successfully created via the gateway.
//
// Never throws: a failure here must NOT break the payment response.
// The client gets the payment; on retry, the 30s stale window recovers.
export async function completeIdempotency(params: IdempotencyCompleteParams): Promise<boolean> {
  const { key, requestHash, response } = params;

  try {
    const existing = await IdempotencyStore.getIdempotencyRecord(key);

    // Case 1: No existing record — shouldn't happen if check() was called
    // first, but handle gracefully: create a COMPLETED record from scratch
    // so future retries get a HIT.
    if (!existing) {
      const record: IdempotencyRecord = {
        requestHash,
        status: 'COMPLETED',
        response,
        createdAt: now(),
        updatedAt: now(),
      };

      const created = await IdempotencyStore.setIdempotencyRecordIfNotExists(key, record);
      if (created) {
        log.info('idempotency.completed_created', { key });
      } else {
        log.warn('idempotency.completed_create_race', { key });
      }
      return created;
    }

    // Case 2: Hash mismatch — indicates a programming bug. check() already
    // validates the hash and throws IdempotencyKeyReusedError, so reaching
    // here with a different hash means the contract was violated. Log and
    // return false — don't overwrite a record that doesn't belong to us.
    if (existing.requestHash !== requestHash) {
      log.error('idempotency.complete_hash_mismatch', {
        key,
        existingHash: existing.requestHash,
        newHash: requestHash,
      });
      return false;
    }

    // Case 3: Normal path — update IN_PROGRESS → COMPLETED atomically.
    const completeRecord: IdempotencyRecord = {
      ...existing,
      status: 'COMPLETED',
      response,
      updatedAt: now(),
    };

    const updated = await IdempotencyStore.updateIdempotencyRecord(key, completeRecord);
    if (updated) {
      log.info('idempotency.completed', { key });
    } else {
      log.error('idempotency.complete_update_failed', { key });
    }
    return updated;
  } catch (err) {
    // Never throw — payment response takes priority.
    log.error('idempotency.complete_critical_failure', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });

    // TODO v1.2: write to dead-letter queue for reconciliation.
    return false;
  }
}
