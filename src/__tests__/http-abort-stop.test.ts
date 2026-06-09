/**
 * POST /abort — restored abort endpoint (legacy-parity regression).
 *
 * The legacy REST surface (src/server.ts) had POST /abort; v0.9 PR7.4
 * ("delete REST endpoints — MCP is the only protocol") deleted it, but
 * `clawdcursor stop` still calls /abort first (cli.ts) before /stop. The
 * result in v1.0.x: stop was a HARD KILL — the in-flight agent run was
 * never aborted, never settled, and never printed its "aborted by user"
 * acknowledgment (live run 2026-06-06 died mid-turn 47 with zero output).
 *
 * These tests lock the restored contract:
 *   • POST /abort exists, is auth-gated, and invokes onAbort.
 *   • POST /stop aborts the in-flight task BEFORE shutting down, and waits
 *     for onStop (bounded) instead of a flat 500ms race.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createUtilityServer, initServerToken } from '../surface/http-utility';

describe('POST /abort', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onAbort and returns {aborted:true}', async () => {
    const token = initServerToken();
    const onAbort = vi.fn();
    const app = createUtilityServer({ onStop: vi.fn(), onAbort });

    const res = await request(app)
      .post('/abort')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.aborted).toBe(true);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('requires auth', async () => {
    initServerToken();
    const onAbort = vi.fn();
    const app = createUtilityServer({ onStop: vi.fn(), onAbort });

    const res = await request(app).post('/abort');

    expect(res.status).toBe(401);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('responds 200 even when no onAbort is wired (tools-only daemon)', async () => {
    const token = initServerToken();
    const app = createUtilityServer({ onStop: vi.fn() });

    const res = await request(app)
      .post('/abort')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.aborted).toBe(true);
  });
});

describe('POST /stop — graceful shutdown aborts the in-flight task first', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('invokes onAbort before onStop and exits 0 after onStop settles', async () => {
    const token = initServerToken();
    const order: string[] = [];
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((..._args: unknown[]) => undefined) as never);
    const onAbort = vi.fn(() => { order.push('abort'); });
    const onStop = vi.fn(async () => { order.push('stop'); });
    const app = createUtilityServer({ onStop, onAbort });

    // Fake timers BEFORE the request so the scheduled hard-kill timeouts
    // never fire for real after the spy is restored.
    vi.useFakeTimers();
    const res = await request(app)
      .post('/stop')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(true);

    // Let the grace race (onStop vs cap) settle.
    await vi.runAllTimersAsync();

    expect(order).toEqual(['abort', 'stop']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe('POST /stop — tolerates a drifted on-disk token (clawdcursor stop reliability)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('accepts the current on-disk token even when it drifted from the daemon in-memory token', async () => {
    const memoryToken = initServerToken();                 // SERVER_TOKEN = memoryToken; file = memoryToken
    const tokenPath = path.join(os.homedir(), '.clawdcursor', 'token');
    const driftedDiskToken = randomBytes(32).toString('hex');
    fs.writeFileSync(tokenPath, driftedDiskToken, 'utf-8'); // another daemon lifecycle rewrote the file
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((..._a: unknown[]) => undefined) as never);
    const app = createUtilityServer({ onStop: vi.fn(async () => {}), onAbort: vi.fn() });

    vi.useFakeTimers();
    const res = await request(app).post('/stop').set('Authorization', `Bearer ${driftedDiskToken}`);
    expect(res.status).toBe(200);             // accepted via the on-disk token (shutdown endpoint)
    expect(res.body.stopped).toBe(true);
    await vi.runAllTimersAsync();
    expect(exitSpy).toHaveBeenCalledWith(0);

    fs.writeFileSync(tokenPath, memoryToken, 'utf-8');       // restore so a real daemon isn't confused
  });

  it('still rejects a wrong token on /stop (matches neither memory nor disk)', async () => {
    initServerToken();
    const app = createUtilityServer({ onStop: vi.fn(), onAbort: vi.fn() });
    const res = await request(app).post('/stop').set('Authorization', 'Bearer deadbeef-not-a-real-token');
    expect(res.status).toBe(401);
  });
});
