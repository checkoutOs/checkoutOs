// hash.ts
/*
    Pure helpers for producing a deterministic request hash used by the
    idempotency flow (AGENTS.md §5.3 — utils are pure functions, no side effects).

    Invariant: same (method, path, body) tuple -> same SHA-256 hex digest.
    The service layer compares hashes across requests to detect "same
    idempotency key, different payload" (IdempotencyKeyReusedError).
*/

import { createHash } from 'crypto';

// Normalise an unknown request body to a stable string for hashing.
// JSON.stringify(undefined) returns undefined (not a string), so empty
// bodies collapse to an empty string — (method, path) still distinguishes
// distinct endpoints, so the hash remains collision-safe in practice.
function normaliseBody(body: unknown): string {
  return body === undefined ? '' : JSON.stringify(body);
}

// SHA-256 hex digest of `method:path:normalisedBody`.
// The (method, path) prefix lets a single idempotency key be legitimately
// reused across distinct endpoints (e.g. POST /payments vs POST /refunds).
export function generateRequestHash(method: string, path: string, body: unknown): string {
  const data = `${method}:${path}:${normaliseBody(body)}`;
  return createHash('sha256').update(data).digest('hex');
}
