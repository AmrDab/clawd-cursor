/**
 * isLoopbackHost — the #113 bind guard. The daemon refuses non-loopback binds
 * without --allow-remote, so this classification must be exact: a false
 * positive exposes desktop control to the network; a false negative blocks
 * legitimate local setups.
 */
import { describe, it, expect } from 'vitest';
import { isLoopbackHost } from '../surface/http-utility';

describe('isLoopbackHost', () => {
  it('accepts the loopback family', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.53')).toBe(true);      // whole 127/8 block
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackHost(' 127.0.0.1 ')).toBe(true);     // trimmed
  });

  it('rejects everything that reaches beyond the machine', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('1270.0.0.1')).toBe(false);     // not a 127/8 address
    expect(isLoopbackHost('')).toBe(false);
    expect(isLoopbackHost(undefined as unknown as string)).toBe(false);
  });
});
