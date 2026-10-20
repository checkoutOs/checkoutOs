// tests/unit/telemetry/sampling.test.ts
// Unit tests for ErrorBiasedSpanProcessor (ADR 003 §5 Phase 6).
//
// Business invariants protected:
//   - every trace containing an error span is exported, WHOLE — including
//     spans that ended before the error did — whatever the ratio
//   - non-error traces are exported at ~ratio, deterministically per trace id
//   - the decision waits for the local root (no parent, or a remote parent)
//   - spans ending after their root follow the decision already made
//   - memory is bounded: undecided traces are capped and expire
//   - shutdown decides in-flight traces, so an error at shutdown is not lost

import { describe, it, expect } from 'vitest';
import { SpanKind, SpanStatusCode, type SpanContext } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ErrorBiasedSpanProcessor, isFailure, traceIdRatio } from '../../../src/telemetry/sampling';

class RecordingProcessor implements SpanProcessor {
  ended: ReadableSpan[] = [];
  started = 0;
  shutdowns = 0;
  onStart(): void {
    this.started += 1;
  }
  onEnd(span: ReadableSpan): void {
    this.ended.push(span);
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    this.shutdowns += 1;
    return Promise.resolve();
  }
}

let spanCounter = 0;

// A trace id whose low 32 bits put it at `share` of the ratio range.
function traceIdAt(share: number): string {
  const low = Math.floor(share * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `${'a'.repeat(24)}${low}`;
}

function span(
  traceId: string,
  opts: { parent?: 'local' | 'remote'; error?: boolean; kind?: SpanKind; httpStatus?: number } = {},
): ReadableSpan {
  spanCounter += 1;
  const context: SpanContext = {
    traceId,
    spanId: spanCounter.toString(16).padStart(16, '0'),
    traceFlags: 1,
  };
  return {
    name: `span-${spanCounter}`,
    spanContext: () => context,
    ...(opts.parent && {
      parentSpanContext: {
        traceId,
        spanId: 'ffffffffffffffff',
        traceFlags: 1,
        isRemote: opts.parent === 'remote',
      },
    }),
    // Children default to CLIENT (a gateway/Redis call), roots to SERVER.
    kind: opts.kind ?? (opts.parent ? SpanKind.CLIENT : SpanKind.SERVER),
    attributes:
      opts.httpStatus === undefined ? {} : { 'http.response.status_code': opts.httpStatus },
    status: { code: opts.error ? SpanStatusCode.ERROR : SpanStatusCode.UNSET },
  } as unknown as ReadableSpan;
}

// A request: children end first, the local root last — as in a real server.
function request(
  processor: ErrorBiasedSpanProcessor,
  traceId: string,
  { childError = false, rootError = false, children = 2 } = {},
): ReadableSpan[] {
  const spans = [
    ...Array.from({ length: children }, (_, i) =>
      span(traceId, { parent: 'local', error: childError && i === 0 }),
    ),
    span(traceId, { error: rootError }),
  ];
  for (const s of spans) processor.onEnd(s);
  return spans;
}

describe('traceIdRatio', () => {
  it('is deterministic and in [0, 1)', () => {
    const id = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(traceIdRatio(id)).toBe(traceIdRatio(id));
    expect(traceIdRatio(id)).toBeGreaterThanOrEqual(0);
    expect(traceIdRatio(id)).toBeLessThan(1);
    expect(traceIdRatio('0'.repeat(32))).toBe(0);
    expect(traceIdRatio('f'.repeat(32))).toBeLessThan(1);
  });
});

describe('isFailure', () => {
  it('counts a root span with ERROR or HTTP >= 500', () => {
    expect(isFailure(span('t', { error: true }), true)).toBe(true);
    expect(isFailure(span('t', { httpStatus: 502 }), true)).toBe(true);
    expect(isFailure(span('t', { httpStatus: 404 }), true)).toBe(false);
    expect(isFailure(span('t', { httpStatus: 200 }), true)).toBe(false);
  });

  it('counts a failed outbound span (gateway, Redis, relay)', () => {
    for (const kind of [SpanKind.CLIENT, SpanKind.PRODUCER, SpanKind.CONSUMER]) {
      expect(isFailure(span('t', { parent: 'local', error: true, kind }), false)).toBe(true);
    }
  });

  it('ignores ERROR on INTERNAL spans — Express marks every next(err), even a 404', () => {
    const handler = span('t', { parent: 'local', error: true, kind: SpanKind.INTERNAL });

    expect(isFailure(handler, false)).toBe(false);
  });
});

describe('ErrorBiasedSpanProcessor', () => {
  it('samples a 4xx trace like any other — its INTERNAL handler error does not count', () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 0 });
    const traceId = traceIdAt(0.5);

    processor.onEnd(span(traceId, { parent: 'local', error: true, kind: SpanKind.INTERNAL }));
    processor.onEnd(span(traceId, { parent: 'local', kind: SpanKind.CLIENT })); // redis hgetall
    processor.onEnd(span(traceId, { httpStatus: 404 }));

    expect(next.ended).toEqual([]);
  });

  it('keeps a 5xx trace whose only signal is the root status code', () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 0 });

    processor.onEnd(span(traceIdAt(0.5), { httpStatus: 502 }));

    expect(next.ended).toHaveLength(1);
  });

  it('exports a whole error trace even at ratio 0 — child error', () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 0 });

    const spans = request(processor, traceIdAt(0.99), { childError: true });

    expect(next.ended).toEqual(spans);
  });

  it('exports a whole error trace even at ratio 0 — root error (5xx)', () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 0 });

    const spans = request(processor, traceIdAt(0.99), { rootError: true });

    expect(next.ended).toEqual(spans);
  });

  it('drops a non-error trace above the ratio and keeps one below it', () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 0.1 });

    request(processor, traceIdAt(0.5));
    expect(next.ended).toEqual([]);

    const kept = request(processor, traceIdAt(0.05));
    expect(next.ended).toEqual(kept);
  });

  it('keeps about `ratio` of random non-error traces', () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 0.1 });
    const traces = 20_000;

    for (let i = 0; i < traces; i += 1) {
      const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(
        '',
      );
      processor.onEnd(span(id));
    }

    const share = next.ended.length / traces;
    expect(share).toBeGreaterThan(0.085);
    expect(share).toBeLessThan(0.115);
  });

  it('ratio 1 keeps everything; ratio 0 keeps only errors', () => {
    const all = new RecordingProcessor();
    const errorsOnly = new RecordingProcessor();
    const keepAll = new ErrorBiasedSpanProcessor(all, { ratio: 1 });
    const keepErrors = new ErrorBiasedSpanProcessor(errorsOnly, { ratio: 0 });

    for (const share of [0, 0.3, 0.999]) {
      request(keepAll, traceIdAt(share));
      request(keepErrors, traceIdAt(share));
    }

    expect(all.ended).toHaveLength(9);
    expect(errorsOnly.ended).toHaveLength(0);
  });

  it('waits for the local root — nothing is exported while children end', () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 1 });
    const traceId = traceIdAt(0.01);

    processor.onEnd(span(traceId, { parent: 'local' }));
    processor.onEnd(span(traceId, { parent: 'local', error: true }));
    expect(next.ended).toHaveLength(0);
    expect(processor.pendingTraces).toBe(1);

    processor.onEnd(span(traceId));
    expect(next.ended).toHaveLength(3);
    expect(processor.pendingTraces).toBe(0);
  });

  it('treats a span with a REMOTE parent as the local root (incoming traceparent)', () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 0 });
    const traceId = traceIdAt(0.99);

    processor.onEnd(span(traceId, { parent: 'local', error: true }));
    processor.onEnd(span(traceId, { parent: 'remote' }));

    expect(next.ended).toHaveLength(2);
  });

  it('applies the decision to spans that end after the root', () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 0 });
    const kept = traceIdAt(0.99);
    const dropped = traceIdAt(0.98);

    request(processor, kept, { rootError: true });
    request(processor, dropped);
    const lateKept = span(kept, { parent: 'local' });
    processor.onEnd(lateKept);
    processor.onEnd(span(dropped, { parent: 'local' }));

    expect(next.ended).toContain(lateKept);
    expect(next.ended.filter((s) => s.spanContext().traceId === dropped)).toEqual([]);
    expect(processor.pendingTraces).toBe(0);
  });

  it('keeps interleaved traces apart', () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 0 });
    const a = traceIdAt(0.9);
    const b = traceIdAt(0.8);

    processor.onEnd(span(a, { parent: 'local', error: true }));
    processor.onEnd(span(b, { parent: 'local' }));
    processor.onEnd(span(b));
    processor.onEnd(span(a));

    expect(new Set(next.ended.map((s) => s.spanContext().traceId))).toEqual(new Set([a]));
  });

  it('caps undecided traces, dropping the oldest', () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 1, maxTraces: 3 });

    for (let i = 0; i < 10; i += 1) {
      processor.onEnd(span(traceIdAt(i / 100), { parent: 'local' }));
    }

    expect(processor.pendingTraces).toBe(3);
  });

  it('expires undecided traces after the TTL', () => {
    let clock = 0;
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, {
      ratio: 1,
      traceTtlMs: 1_000,
      now: () => clock,
    });

    processor.onEnd(span(traceIdAt(0.1), { parent: 'local' }));
    clock = 5_000;
    processor.onEnd(span(traceIdAt(0.2), { parent: 'local' }));

    expect(processor.pendingTraces).toBe(1);
  });

  it('caps spans buffered per trace', () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 1, maxSpansPerTrace: 5 });

    request(processor, traceIdAt(0.01), { children: 20 });

    expect(next.ended).toHaveLength(5);
  });

  it('decides in-flight traces on shutdown, then shuts the next processor down', async () => {
    const next = new RecordingProcessor();
    const processor = new ErrorBiasedSpanProcessor(next, { ratio: 0 });

    processor.onEnd(span(traceIdAt(0.99), { parent: 'local', error: true }));
    processor.onEnd(span(traceIdAt(0.98), { parent: 'local' }));
    await processor.shutdown();

    expect(next.ended).toHaveLength(1);
    expect(next.shutdowns).toBe(1);
    expect(processor.pendingTraces).toBe(0);
  });

  it('forwards onStart', () => {
    const next = new RecordingProcessor();
    new ErrorBiasedSpanProcessor(next, { ratio: 0 }).onStart({} as Span, {} as never);

    expect(next.started).toBe(1);
  });
});
