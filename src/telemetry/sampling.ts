// sampling.ts
// ErrorBiasedSpanProcessor — export 100% of traces that contain an error and
// a fixed share of the rest (ADR 003 §5 Phase 6). Used only when an OTLP
// traces endpoint is configured; see tracing.ts.
//
// Why not a Sampler: a sampler decides when a span STARTS, before anyone knows
// whether the request will fail — so "every error" is impossible with head
// sampling. Instead every span is recorded (as it always is: trace_id must be
// on every log line), buffered per trace, and the decision is made when the
// trace's LOCAL ROOT span ends:
//
//   keep = the trace FAILED                              (see isFailure below)
//       || traceIdRatio(traceId) < ratio                 (deterministic ~ratio)
//
// A trace failed when its local root span has status ERROR or an HTTP status
// >= 500, or when any CLIENT/PRODUCER/CONSUMER span (a gateway call, Redis,
// the merchant relay) has status ERROR. INTERNAL spans do not count: the
// Express instrumentation marks the route-handler span ERROR on every
// next(err) — including expected 4xx (payment not found, validation, 409) —
// and counting those would export every bad client request.
//
// Kept traces are handed, whole, to the next processor (BatchSpanProcessor).
//
// Local root = a span with no parent, or whose parent is remote (an incoming
// traceparent). Spans that end AFTER their root (rare: fire-and-forget work)
// follow the decision already made, remembered briefly.
//
// Bounded, never throws into the request path:
//   - at most MAX_TRACES undecided traces; the oldest is dropped beyond that
//   - at most MAX_SPANS_PER_TRACE spans buffered per trace (rest dropped)
//   - undecided traces older than TRACE_TTL_MS are dropped (a root that never
//     ends must not leak memory)
//
// What it does not do: change the sampled flag propagated downstream (every
// span is sampled at the head, as today), or coordinate across services — a
// downstream service decides its own traces.

import type { Context } from '@opentelemetry/api';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export interface ErrorBiasedOptions {
  /** Share of non-error traces to keep, 0–1. */
  ratio: number;
  maxTraces?: number;
  maxSpansPerTrace?: number;
  traceTtlMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

const MAX_TRACES = 2_000;
const MAX_SPANS_PER_TRACE = 512;
const TRACE_TTL_MS = 60_000;
const DECIDED_MEMORY = 2_000;

interface PendingTrace {
  firstSeen: number;
  spans: ReadableSpan[];
  hasError: boolean;
}

/**
 * Deterministic share in [0, 1) from the trace id's low 32 bits — the same
 * trace always gets the same answer, and random ids spread uniformly.
 */
export function traceIdRatio(traceId: string): number {
  const low = Number.parseInt(traceId.slice(-8), 16);
  return Number.isFinite(low) ? low / 0x1_0000_0000 : 1;
}

function isLocalRoot(span: ReadableSpan): boolean {
  const parent = span.parentSpanContext;
  return parent === undefined || parent.isRemote === true;
}

const HTTP_STATUS = 'http.response.status_code';

/** Does this span, on its own, make its trace a failure? */
export function isFailure(span: ReadableSpan, root: boolean): boolean {
  const error = span.status.code === SpanStatusCode.ERROR;
  if (root) {
    const status = span.attributes[HTTP_STATUS];
    return error || (typeof status === 'number' && status >= 500);
  }
  return error && span.kind !== SpanKind.INTERNAL;
}

export class ErrorBiasedSpanProcessor implements SpanProcessor {
  private readonly pending = new Map<string, PendingTrace>();
  // traceId → kept? for spans that end after their root. Insertion-ordered,
  // trimmed to DECIDED_MEMORY.
  private readonly decided = new Map<string, boolean>();
  private readonly ratio: number;
  private readonly maxTraces: number;
  private readonly maxSpansPerTrace: number;
  private readonly traceTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly next: SpanProcessor,
    options: ErrorBiasedOptions,
  ) {
    this.ratio = Math.min(1, Math.max(0, options.ratio));
    this.maxTraces = options.maxTraces ?? MAX_TRACES;
    this.maxSpansPerTrace = options.maxSpansPerTrace ?? MAX_SPANS_PER_TRACE;
    this.traceTtlMs = options.traceTtlMs ?? TRACE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  onStart(span: Span, parentContext: Context): void {
    this.next.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const { traceId } = span.spanContext();

    const earlier = this.decided.get(traceId);
    if (earlier !== undefined) {
      if (earlier) this.next.onEnd(span);
      return;
    }

    const trace = this.pendingFor(traceId);
    if (trace.spans.length < this.maxSpansPerTrace) trace.spans.push(span);
    const root = isLocalRoot(span);
    if (isFailure(span, root)) trace.hasError = true;

    if (root) this.decide(traceId, trace);
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  // Undecided traces are decided now (an error trace in flight at shutdown is
  // still exported), then the next processor flushes and shuts down.
  shutdown(): Promise<void> {
    for (const [traceId, trace] of [...this.pending]) this.decide(traceId, trace);
    return this.next.shutdown();
  }

  /** Undecided traces currently buffered. */
  get pendingTraces(): number {
    return this.pending.size;
  }

  private pendingFor(traceId: string): PendingTrace {
    const existing = this.pending.get(traceId);
    if (existing !== undefined) return existing;

    this.evict();
    const trace: PendingTrace = { firstSeen: this.now(), spans: [], hasError: false };
    this.pending.set(traceId, trace);
    return trace;
  }

  // Map iteration is insertion order, so the first entries are the oldest.
  private evict(): void {
    const cutoff = this.now() - this.traceTtlMs;
    for (const [traceId, trace] of this.pending) {
      if (trace.firstSeen >= cutoff && this.pending.size < this.maxTraces) break;
      this.pending.delete(traceId);
    }
  }

  private decide(traceId: string, trace: PendingTrace): void {
    this.pending.delete(traceId);
    const keep = trace.hasError || traceIdRatio(traceId) < this.ratio;

    this.decided.set(traceId, keep);
    if (this.decided.size > DECIDED_MEMORY) {
      const oldest = this.decided.keys().next().value;
      if (oldest !== undefined) this.decided.delete(oldest);
    }

    if (keep) for (const span of trace.spans) this.next.onEnd(span);
  }
}
