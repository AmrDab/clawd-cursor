/**
 * Unit tests for the new observability primitives.
 *
 * These are ship-blocking for v0.8.1: the logger replaces 775 console.* sites
 * and the cost-meter backs the "cost-aware" product claim. Both must be
 * correct from day one.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CostMeter, priceFor } from '../pipeline/observability/cost-meter';
import {
  newCorrelationId,
  runWithCorrelation,
  getCorrelationId,
  getContext,
} from '../pipeline/observability/correlation';

describe('correlation', () => {
  it('generates stable-format UUIDs', () => {
    const id = newCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('returns different IDs on each call', () => {
    expect(newCorrelationId()).not.toEqual(newCorrelationId());
  });

  it('exposes the correlation ID within runWithCorrelation', async () => {
    const id = newCorrelationId();
    const observed = await runWithCorrelation({ correlationId: id, taskText: 'test' }, () => {
      return getCorrelationId();
    });
    expect(observed).toBe(id);
  });

  it('exposes full context within runWithCorrelation', async () => {
    const id = newCorrelationId();
    const ctx = await runWithCorrelation({ correlationId: id, taskText: 'hello' }, () => {
      return getContext();
    });
    expect(ctx?.correlationId).toBe(id);
    expect(ctx?.taskText).toBe('hello');
    expect(typeof ctx?.startedAt).toBe('number');
  });

  it('isolates context across concurrent tasks', async () => {
    const ids = [newCorrelationId(), newCorrelationId(), newCorrelationId()];
    const results = await Promise.all(
      ids.map(id =>
        runWithCorrelation({ correlationId: id, taskText: id }, async () => {
          // Tiny async hop to force scheduler interleaving.
          await new Promise(r => setTimeout(r, 0));
          return getCorrelationId();
        }),
      ),
    );
    expect(results).toEqual(ids);
  });
});

describe('cost-meter', () => {
  let meter: CostMeter;
  beforeEach(() => {
    meter = new CostMeter();
  });

  it('starts at zero', () => {
    const snap = meter.snapshot();
    expect(snap.totalUsd).toBe(0);
    expect(Object.keys(snap.byModel)).toHaveLength(0);
    expect(Object.keys(snap.byStage)).toHaveLength(0);
  });

  it('prices a known model correctly', () => {
    meter.record({
      model: 'claude-haiku-4-5',
      stage: 'text-agent',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const snap = meter.snapshot();
    expect(snap.totalUsd).toBeCloseTo(1.0, 6); // haiku input ≈ $1/M
    expect(snap.byStage['text-agent'].calls).toBe(1);
  });

  it('falls back to safe default for unknown model', () => {
    meter.record({
      model: 'unknown-model-xyz',
      stage: 'text-agent',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const snap = meter.snapshot();
    // Fallback is { inputPerM: 1.0, outputPerM: 5.0 }
    expect(snap.totalUsd).toBeCloseTo(6.0, 6);
  });

  it('treats Ollama models as free', () => {
    meter.record({
      model: 'llama3.2',
      stage: 'text-agent',
      inputTokens: 10_000_000,
      outputTokens: 10_000_000,
    });
    expect(meter.snapshot().totalUsd).toBe(0);
  });

  it('aggregates multiple events into per-model and per-stage buckets', () => {
    meter.record({ model: 'claude-haiku-4-5', stage: 'text-agent', inputTokens: 1000, outputTokens: 500 });
    meter.record({ model: 'claude-haiku-4-5', stage: 'classify',   inputTokens: 200,  outputTokens: 50  });
    meter.record({ model: 'gpt-4o-mini',      stage: 'text-agent', inputTokens: 1000, outputTokens: 500 });
    const snap = meter.snapshot();
    expect(snap.byModel['claude-haiku-4-5'].inputTokens).toBe(1200);
    expect(snap.byModel['claude-haiku-4-5'].outputTokens).toBe(550);
    expect(snap.byStage['text-agent'].calls).toBe(2);
    expect(snap.byStage['classify'].calls).toBe(1);
    expect(snap.totalUsd).toBeGreaterThan(0);
  });

  it('priceFor returns the fallback price for unknown models', () => {
    const p = priceFor('made-up-model-42');
    expect(p.inputPerM).toBe(1.0);
    expect(p.outputPerM).toBe(5.0);
  });

  it('priceFor matches by prefix for versioned models', () => {
    // "claude-sonnet-4-20250514" is in the table; any suffix variant should match.
    const p = priceFor('claude-sonnet-4-20250514-beta-flavor');
    expect(p.inputPerM).toBe(3.0);
    expect(p.outputPerM).toBe(15.0);
  });
});
