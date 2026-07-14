//Idempotency store
// chk:idem:{key} = string json serialised idempotency record

/*
    getIdempotencyRecord -> Get the record return parse or null
    setIdempotencyRecordIfNotExists -> SET NX for atomic race-condition reace-condition prevention
    updateIdempotencyRecord -> Lua script for atomic update (esists check + set)

    All keys expires after IDEMPOTENCY_KEY_TTL_SECONDS (default 24 hours)

*/

import { redisClient } from './redis.client';
import { StoreError } from '../errors/store.errors';
import type { IdempotencyRecord } from '../types/common.types';
import { IDEMPOTENCY_TTL_SECONDS } from '../types/common.types';

const KEY_PREFIX = 'chk:idem:';

function buildKey(idempotencyKey: string): string {
  return `${KEY_PREFIX}${idempotencyKey}`;
}

// Lua script for atomic update returns 1 if updated , 0 if did not exist

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

// Serialisation Idempotecy record are stored as JSON string

function serialise(record: IdempotencyRecord): string {
  return JSON.stringify(record);
}

function deserialise(raw: string): IdempotencyRecord | null {
  try {
    return JSON.parse(raw) as IdempotencyRecord;
  } catch {
    // Corrupted data - treat as not found
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
    const result = await redisClient.set(
      buildKey(key),
      serialise(record),
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
      'NX',
    );

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

export async function deleteIdempotencyRecord(key: string): Promise<void> {
  try {
    await redisClient.del(buildKey(key));
  } catch (err) {
    throw new StoreError(`deleteIdempotencyRecord:${key}`, err);
  }
}
