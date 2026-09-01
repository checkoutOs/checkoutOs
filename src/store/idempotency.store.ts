// idempotency.store.ts
// Redis operations for idempotency records.
//
// Key pattern:
//   chk:idem:{key}  → string  — JSON-serialised IdempotencyRecord
//
// Operations:
//   getIdempotencyRecord           → GET  (returns parsed record or null)
//   setIdempotencyRecordIfNotExists → SET NX EX  (atomic create)
//   updateIdempotencyRecord         → Lua atomic update (only if key exists)
//   forceUpdateIfInProgress         → Lua atomic overwrite (only if status
//                                       is IN_PROGRESS) — used for stale
//                                       recovery; eliminates the delete-then-set
//                                       race window.
//
// All keys expire after IDEMPOTENCY_TTL_SECONDS (default 24 hours).
// Every ioredis error is caught and re-thrown as StoreError.

import { redisClient } from './redis.client';
import { StoreError } from '../errors/store.errors';
import { IDEMPOTENCY_TTL_SECONDS, type IdempotencyRecord } from '../types/common.types';

const KEY_PREFIX = 'chk:idem:';

function buildKey(idempotencyKey: string): string {
  return `${KEY_PREFIX}${idempotencyKey}`;
}

// Lua: atomic update — returns 1 if updated, 0 if key did not exist.
// Used by completeIdempotency() to transition IN_PROGRESS → COMPLETED.
const ATOMIC_UPDATE_SCRIPT = `
local key = KEYS[1]
local newValue = ARGV[1]
local ttl = tonumber(ARGV[2])

local existing = redis.call("GET", key)
if not existing then
    return 0
end

redis.call("SET", key, newValue, "EX", ttl)
return 1
`;

// Lua: atomic stale recovery — overwrites ONLY when the stored record is
// IN_PROGRESS. Returns 1 if overwritten, 0 otherwise (missing or not
// IN_PROGRESS). Eliminates the delete+setNx race window: two workers invoking
// this concurrently will see at most one overwrite succeed.
const FORCE_UPDATE_IF_IN_PROGRESS_SCRIPT = `
local key = KEYS[1]
local newValue = ARGV[1]
local ttl = tonumber(ARGV[2])

local existing = redis.call("GET", key)
if not existing then
    return 0
end

local ok, rec = pcall(cjson.decode, existing)
if not ok or rec == nil or rec.status ~= "IN_PROGRESS" then
    return 0
end

redis.call("SET", key, newValue, "EX", ttl)
return 1
`;

function serialise(record: IdempotencyRecord): string {
  return JSON.stringify(record);
}

function deserialise(raw: string): IdempotencyRecord | null {
  try {
    return JSON.parse(raw) as IdempotencyRecord;
  } catch {
    // Corrupted data — treat as not found.
    return null;
  }
}

export async function getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
  try {
    const raw = await redisClient.get(buildKey(key));
    if (!raw) {
      return null;
    }
    return deserialise(raw);
  } catch (err) {
    throw new StoreError(`getIdempotencyRecord:${key}`, err);
  }
}

export async function setIdempotencyRecordIfNotExists(
  key: string,
  record: IdempotencyRecord,
): Promise<boolean> {
  try {
    // SET key value NX EX ttl — atomic create-on-absent with TTL.
    // Using .call() with explicit return cast: ioredis's .set() overload
    // doesn't accept the ('NX', 'EX', seconds) ordering we need here.
    const result = (await redisClient.call(
      'SET',
      buildKey(key),
      serialise(record),
      'NX',
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
    )) as 'OK' | null;
    return result === 'OK';
  } catch (err) {
    throw new StoreError(`setIdempotencyRecordIfNotExists:${key}`, err);
  }
}

export async function updateIdempotencyRecord(
  key: string,
  record: IdempotencyRecord,
): Promise<boolean> {
  try {
    const result = await redisClient.eval(
      ATOMIC_UPDATE_SCRIPT,
      1,
      buildKey(key),
      serialise(record),
      String(IDEMPOTENCY_TTL_SECONDS),
    );
    return result === 1;
  } catch (err) {
    throw new StoreError(`updateIdempotencyRecord:${key}`, err);
  }
}

// Atomically overwrite an IN_PROGRESS record. Used by IdempotencyService
// for stale recovery — guarantees that two concurrent recoveries cannot
// both succeed (one returns 1, the other returns 0) and that a record
// already transitioned to COMPLETED cannot be clobbered back to IN_PROGRESS.
export async function forceUpdateIfInProgress(
  key: string,
  record: IdempotencyRecord,
): Promise<boolean> {
  try {
    const result = await redisClient.eval(
      FORCE_UPDATE_IF_IN_PROGRESS_SCRIPT,
      1,
      buildKey(key),
      serialise(record),
      String(IDEMPOTENCY_TTL_SECONDS),
    );
    return result === 1;
  } catch (err) {
    throw new StoreError(`forceUpdateIfInProgress:${key}`, err);
  }
}
