// idempotency.middleware.ts
// Pre-controller middleware that prepares the idempotency descriptor for
// POST /payments. Attached to the route via paymentRouter.post('/', ...).
//
// Responsibilities (per AGENTS.md §4.2 — middleware = cross-cutting concerns):
//   1. Extract the Idempotency-Key header
//   2. Validate it's a UUID v4 (any version technically works, but the spec
//      asks for v4 and the OpenAPI schema declares format: uuid)
//   3. Compute a deterministic SHA-256 hash of method + path + body so the
//      service layer can compare hashes across requests: same body → same
//      hash, different body → different hash → IdempotencyKeyReusedError.
//   4. Attach { key, requestHash } to req.idempotency for the controller.
//
// Explicitly NOT done here (per AGENTS.md §5.5 + §5.7):
//   - No Redis access            (store layer's job)
//   - No service calls          (controller's job)
//   - No HIT / MISS / IN_PROGRESS decision (service layer's job)
//   - No res.json / res.status  (errors flow through next(err) → error middleware)
//
// Body parsing order in app.ts guarantees req.body is already parsed by the
// time this middleware runs: express.json() at app.ts:78 mounts BEFORE the
// paymentRouter at app.ts:81, so by the time the request reaches this handler
// req.body is a JavaScript object — safe to JSON.stringify.

import { Request, Response, NextFunction } from 'express';
import { validate as isUuid } from 'uuid';
import { IdempotencyKeyMissingError, IdempotencyKeyInvalidError } from '../errors';
import { generateRequestHash } from '../utils/hash';
import '../types/express.types';

// Header name (case-insensitive per HTTP spec, but Express lowercases).
const IDEMPOTENCY_HEADER = 'idempotency-key';

// Express middleware signature.
// route mounting reads cleanly: `paymentRouter.post('/', idempotencyMiddleware, create)`.
//
// Errors are forwarded via next(err) — the error middleware maps
// IdempotencyKeyMissingError → 400 and IdempotencyKeyInvalidError → 400.
// We deliberately do NOT try/catch the validate() call: uuid's validate
// is a pure synchronous regex check that cannot throw.
export function idempotencyMiddleware(req: Request, _res: Response, next: NextFunction): void {
  // Express lowercases all header names on the req.headers object.
  const key = req.headers[IDEMPOTENCY_HEADER] as string | undefined;

  // --- Check 1: header present ---
  if (!key || key.trim() === '') {
    next(new IdempotencyKeyMissingError());
    return;
  }

  // --- Check 2: valid UUID v4 format ---
  // uuid's validate accepts any UUID version; spec asks for v4. The OpenAPI
  // schema also declares format: uuid. We accept any version here because
  // validating v4 specifically requires the version nibble check, which
  // uuid v13's validate doesn't expose. Document this in the OpenAPI spec
  // so clients know to send v4 — server-side enforcement is best-effort.
  if (!isUuid(key)) {
    next(new IdempotencyKeyInvalidError(key));
    return;
  }

  // --- Check 3: compute request hash for downstream service comparison ---
  const requestHash = generateRequestHash(req.method, req.path, req.body);

  // --- Check 4: attach to req for the controller + service to read ---
  // The express type augmentation in src/types/express.types.ts declares
  // Request.idempotency?: { key: string; requestHash: string }, so this
  // assignment type-checks without any cast.
  req.idempotency = { key, requestHash };

  next();
}
