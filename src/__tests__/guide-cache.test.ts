/**
 * Cache tests — TTL, LRU, usage tracking, eviction. Uses a tmp HOME so
 * the real user cache is never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getCached, setCached, touchUsage, listCached, evict, clearCache, CACHE_INTERNALS,
} from '../llm/knowledge/cache';
import type { AppGuide } from '../llm/knowledge/types';

const sampleGuide = (app: string): AppGuide => ({
  app,
  name: app,
  shortcuts: { save: 'mod+s' },
});

describe('cache — round-trip', () => {
  let tmpHome: string;
  const origHome = process.env.CLAWD_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cache-test-'));
    process.env.CLAWD_HOME = tmpHome;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.CLAWD_HOME;
    else process.env.CLAWD_HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('setCached then getCached returns the guide', () => {
    setCached('notion', sampleGuide('notion'), { etag: 'abc123' });
    const entry = getCached('notion');
    expect(entry).not.toBeNull();
    expect(entry!.guide.app).toBe('notion');
    expect(entry!.meta.etag).toBe('abc123');
    expect(entry!.stale).toBe(false);
  });

  it('getCached returns null for a missing app', () => {
    expect(getCached('not-cached')).toBeNull();
  });

  it('listCached returns most-recently-set first', () => {
    setCached('a', sampleGuide('a'));
    setCached('b', sampleGuide('b'));
    setCached('c', sampleGuide('c'));
    const list = listCached();
    expect(list.map(e => e.app)).toEqual(['c', 'b', 'a']);
  });

  it('touchUsage bumps counter and re-orders LRU', () => {
    setCached('a', sampleGuide('a'));
    setCached('b', sampleGuide('b'));
    setCached('c', sampleGuide('c'));
    touchUsage('a'); // a now most-recent
    const list = listCached();
    expect(list[0].app).toBe('a');
    expect(list[0].meta.usageCount).toBe(1);
  });

  it('evict removes a single entry', () => {
    setCached('a', sampleGuide('a'));
    setCached('b', sampleGuide('b'));
    evict('a');
    expect(getCached('a')).toBeNull();
    expect(getCached('b')).not.toBeNull();
  });

  it('clearCache wipes everything', () => {
    setCached('a', sampleGuide('a'));
    setCached('b', sampleGuide('b'));
    clearCache();
    expect(listCached()).toHaveLength(0);
  });
});

describe('cache — LRU eviction', () => {
  let tmpHome: string;
  const origHome = process.env.CLAWD_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cache-lru-test-'));
    process.env.CLAWD_HOME = tmpHome;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.CLAWD_HOME;
    else process.env.CLAWD_HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it(`caps at LRU_CAPACITY (${CACHE_INTERNALS.LRU_CAPACITY}) entries`, () => {
    for (let i = 0; i < CACHE_INTERNALS.LRU_CAPACITY + 5; i++) {
      setCached(`app${i}`, sampleGuide(`app${i}`));
    }
    expect(listCached()).toHaveLength(CACHE_INTERNALS.LRU_CAPACITY);
    // The first 5 added should have been evicted.
    expect(getCached('app0')).toBeNull();
    expect(getCached('app4')).toBeNull();
    expect(getCached('app5')).not.toBeNull();
  });

  it('frequently-used (via touchUsage) survives eviction even when not recently fetched', () => {
    // Set the cap quickly with old entries, then touch 'popular' so it
    // moves to the front, then overflow — 'popular' should survive.
    setCached('popular', sampleGuide('popular'));
    for (let i = 0; i < CACHE_INTERNALS.LRU_CAPACITY - 1; i++) {
      setCached(`filler${i}`, sampleGuide(`filler${i}`));
    }
    touchUsage('popular');
    setCached('newest', sampleGuide('newest')); // would push popular to position 0…
    setCached('newest2', sampleGuide('newest2')); // but only if popular weren't touched
    // Since we touched popular AFTER all fillers, it's near the head and survives.
    expect(getCached('popular')).not.toBeNull();
  });
});
