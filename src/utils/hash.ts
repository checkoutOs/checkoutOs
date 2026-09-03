// hash.ts
/*
  

    Invariant: the same logical (method, path, body) -> the same SHA-256 hex

*/

import { createHash } from 'crypto';

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }

  if (value !== null && typeof value === 'object') {
    const candidate = value as { toJSON?: () => unknown };
    if (typeof candidate.toJSON === 'function') {
      return canonicalise(candidate.toJSON());
    }

    const source = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};

    for (const key of Object.keys(source).sort()) {
      const entry = canonicalise(source[key]);
      if (entry !== undefined) {
        canonical[key] = entry;
      }
    }

    return canonical;
  }

  return value;
}

// Normalise an unknown request body to a stable string for hashing.
// JSON.stringify(undefined) returns undefined (not a string), so empty
// bodies collapse to an empty string — (method, path) still distinguishes
// distinct endpoints, so the hash remains collision-safe in practice.
function normaliseBody(body: unknown): string {
  if (body === undefined) {
    return '';
  }

  const serialised = JSON.stringify(canonicalise(body));

  return serialised ?? '';
}

// SHA-256 hex digest of `method:path:normalisedBody`.
// The (method, path) prefix lets a single idempotency key be legitimately
// reused across distinct endpoints (example POST /payments vs POST /refunds).
export function generateRequestHash(method: string, path: string, body: unknown): string {
  const data = `${method}:${path}:${normaliseBody(body)}`;
  return createHash('sha256').update(data).digest('hex');
}
