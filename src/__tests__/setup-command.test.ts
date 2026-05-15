/**
 * Tests for `clawdcursor setup <editor>` (src/surface/setup.ts).
 *
 * Every test uses os.tmpdir() — no real Cursor/Claude/Codex config is
 * ever touched. We exercise the pure-text merge helpers directly
 * (mergeJson, mergeToml) and the orchestrating runSetupInner via
 * --path overrides.
 *
 * Coverage:
 *   - add when absent (JSON)
 *   - update when present (JSON, idempotent)
 *   - preserve other servers and other top-level keys
 *   - --print mode (no file IO)
 *   - --path override
 *   - --list output
 *   - bad editor → exit 2 with supported list
 *   - missing editor argument → exit 2
 *   - TOML add + update + preserve other tables
 *   - parent dir creation
 *   - .bak file creation
 *   - malformed JSON treated as empty without throwing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSetupInner, mergeJson, mergeToml } from '../surface/setup';
import { listEditorIds, getEditor } from '../surface/setup-editors';

// ─────────────────────────────────────────────────────────────────────────────
// Pure merge helpers — no filesystem
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeJson', () => {
  it('adds clawdcursor when the file is empty', () => {
    const { text, wasPresent } = mergeJson('');
    expect(wasPresent).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.mcpServers.clawdcursor).toEqual({
      command: 'clawdcursor',
      args: ['mcp', '--compact'],
    });
  });

  it('adds clawdcursor when mcpServers is missing', () => {
    const input = JSON.stringify({ theme: 'dark' });
    const { text, wasPresent } = mergeJson(input);
    expect(wasPresent).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.theme).toBe('dark');                 // preserved
    expect(parsed.mcpServers.clawdcursor.command).toBe('clawdcursor');
  });

  it('updates clawdcursor when already present', () => {
    const input = JSON.stringify({
      mcpServers: {
        clawdcursor: { command: 'old', args: ['stale'] },
      },
    });
    const { text, wasPresent } = mergeJson(input);
    expect(wasPresent).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.mcpServers.clawdcursor).toEqual({
      command: 'clawdcursor',
      args: ['mcp', '--compact'],
    });
  });

  it('preserves other servers when adding clawdcursor', () => {
    const input = JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
        github:     { command: 'gh-mcp', args: [] },
      },
    });
    const { text, wasPresent } = mergeJson(input);
    expect(wasPresent).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.mcpServers.filesystem).toBeDefined();
    expect(parsed.mcpServers.github).toBeDefined();
    expect(parsed.mcpServers.clawdcursor).toBeDefined();
  });

  it('treats malformed JSON as empty without throwing', () => {
    const { text } = mergeJson('{not json::::');
    const parsed = JSON.parse(text);
    expect(parsed.mcpServers.clawdcursor).toBeDefined();
  });

  it('handles a JSON array at the root by wrapping with an object', () => {
    const { text } = mergeJson('[1,2,3]');
    const parsed = JSON.parse(text);
    expect(parsed.mcpServers.clawdcursor).toBeDefined();
  });

  it('is idempotent — running twice yields the same output', () => {
    const a = mergeJson('').text;
    const b = mergeJson(a).text;
    expect(b).toBe(a);
  });
});

describe('mergeToml', () => {
  it('adds the [mcp_servers.clawdcursor] table to an empty file', () => {
    const { text, wasPresent } = mergeToml('');
    expect(wasPresent).toBe(false);
    expect(text).toContain('[mcp_servers.clawdcursor]');
    expect(text).toContain('command = "clawdcursor"');
    expect(text).toContain('args = ["mcp", "--compact"]');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('appends to a file with other tables', () => {
    const input = [
      '# Codex config',
      '[mcp_servers.github]',
      'command = "github-mcp"',
      'args = []',
      '',
    ].join('\n');
    const { text, wasPresent } = mergeToml(input);
    expect(wasPresent).toBe(false);
    expect(text).toContain('[mcp_servers.github]');     // preserved
    expect(text).toContain('command = "github-mcp"');   // preserved
    expect(text).toContain('[mcp_servers.clawdcursor]');// appended
  });

  it('replaces an existing [mcp_servers.clawdcursor] block in place', () => {
    const input = [
      '[mcp_servers.clawdcursor]',
      'command = "old-command"',
      'args = ["stale"]',
      'enabled = true',
      '',
      '[mcp_servers.github]',
      'command = "github-mcp"',
      'args = []',
    ].join('\n');
    const { text, wasPresent } = mergeToml(input);
    expect(wasPresent).toBe(true);
    expect(text).toContain('command = "clawdcursor"');
    expect(text).not.toContain('old-command');
    expect(text).not.toContain('"stale"');
    // The other table is still intact:
    expect(text).toContain('[mcp_servers.github]');
    expect(text).toContain('command = "github-mcp"');
  });

  it('preserves comments above other tables', () => {
    const input = [
      '# Top-level comment',
      '',
      '# Auth server',
      '[mcp_servers.auth]',
      'command = "auth-mcp"',
    ].join('\n');
    const { text } = mergeToml(input);
    expect(text).toContain('# Top-level comment');
    expect(text).toContain('# Auth server');
    expect(text).toContain('[mcp_servers.auth]');
    expect(text).toContain('[mcp_servers.clawdcursor]');
  });

  it('is idempotent — running twice yields the same output', () => {
    const once = mergeToml('').text;
    const twice = mergeToml(once).text;
    expect(twice).toBe(once);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runSetupInner — orchestration, exit codes, file IO
// ─────────────────────────────────────────────────────────────────────────────

describe('runSetupInner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-setup-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('--list lists supported editors with exit code 0', async () => {
    const r = await runSetupInner('', { list: true });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('listed');
    const blob = r.messages.join('\n');
    for (const id of listEditorIds()) {
      expect(blob).toContain(id);
    }
  });

  it('unknown editor exits 2 and lists supported editors', async () => {
    const r = await runSetupInner('vim', {});
    expect(r.exitCode).toBe(2);
    expect(r.messages.join('\n')).toContain('unknown editor "vim"');
    const blob = r.messages.join('\n');
    for (const id of listEditorIds()) {
      expect(blob).toContain(id);
    }
  });

  it('missing editor argument exits 2 with a helpful list', async () => {
    const r = await runSetupInner('', {});
    expect(r.exitCode).toBe(2);
    expect(r.messages.join('\n')).toMatch(/requires an <editor>/);
  });

  it('--path override writes JSON to the chosen file', async () => {
    const target = path.join(tmpDir, 'cursor-mcp.json');
    const r = await runSetupInner('cursor', { path: target });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('added');
    expect(r.path).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(parsed.mcpServers.clawdcursor.command).toBe('clawdcursor');
    expect(parsed.mcpServers.clawdcursor.args).toEqual(['mcp', '--compact']);
  });

  it('second run on a populated file reports `updated`', async () => {
    const target = path.join(tmpDir, 'cursor-mcp.json');
    await runSetupInner('cursor', { path: target });
    const r = await runSetupInner('cursor', { path: target });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('updated');
    expect(r.messages.join('\n')).toMatch(/updated clawdcursor/);
  });

  it('preserves other mcpServers entries across writes', async () => {
    const target = path.join(tmpDir, 'cursor-mcp.json');
    fs.writeFileSync(target, JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      },
      userPreferences: { theme: 'dark' },
    }, null, 2));

    const r = await runSetupInner('cursor', { path: target });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(parsed.mcpServers.filesystem).toBeDefined();        // other server kept
    expect(parsed.mcpServers.clawdcursor).toBeDefined();       // ours added
    expect(parsed.userPreferences.theme).toBe('dark');         // other key kept
  });

  it('creates a .bak file when the target existed', async () => {
    const target = path.join(tmpDir, 'cursor-mcp.json');
    const original = JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }, null, 2);
    fs.writeFileSync(target, original);
    await runSetupInner('cursor', { path: target });
    expect(fs.existsSync(target + '.bak')).toBe(true);
    expect(fs.readFileSync(target + '.bak', 'utf-8')).toBe(original);
  });

  it('creates parent directories if they don\'t exist', async () => {
    const target = path.join(tmpDir, 'nested', 'dir', 'mcp.json');
    const r = await runSetupInner('cursor', { path: target });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('--print does not write the file', async () => {
    const target = path.join(tmpDir, 'cursor-mcp.json');
    const r = await runSetupInner('cursor', { path: target, print: true });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('printed');
    expect(fs.existsSync(target)).toBe(false);
    // Output includes the JSON body and a "would write" header.
    expect(r.messages.join('\n')).toContain('Would write to:');
    expect(r.messages.join('\n')).toContain('clawdcursor');
  });

  it('--print on an existing file shows the merged result without touching the file', async () => {
    const target = path.join(tmpDir, 'cursor-mcp.json');
    const original = JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }, null, 2);
    fs.writeFileSync(target, original);

    const r = await runSetupInner('cursor', { path: target, print: true });
    expect(r.exitCode).toBe(0);
    // Original is unchanged on disk
    expect(fs.readFileSync(target, 'utf-8')).toBe(original);
    // Output shows the merged config
    const out = r.messages.join('\n');
    expect(out).toContain('clawdcursor');
    expect(out).toContain('other');
  });

  it('--path with .toml extension writes TOML', async () => {
    const target = path.join(tmpDir, 'codex-config.toml');
    const r = await runSetupInner('codex', { path: target });
    expect(r.exitCode).toBe(0);
    const body = fs.readFileSync(target, 'utf-8');
    expect(body).toContain('[mcp_servers.clawdcursor]');
    expect(body).toContain('command = "clawdcursor"');
  });

  it('codex setup against existing TOML preserves other tables', async () => {
    const target = path.join(tmpDir, 'codex-config.toml');
    const original = [
      '# Codex config',
      'model = "gpt-5"',
      '',
      '[mcp_servers.github]',
      'command = "github-mcp"',
      'args = []',
      '',
    ].join('\n');
    fs.writeFileSync(target, original);

    const r = await runSetupInner('codex', { path: target });
    expect(r.exitCode).toBe(0);
    const body = fs.readFileSync(target, 'utf-8');
    expect(body).toContain('model = "gpt-5"');             // preserved
    expect(body).toContain('[mcp_servers.github]');         // preserved
    expect(body).toContain('command = "github-mcp"');      // preserved
    expect(body).toContain('[mcp_servers.clawdcursor]');   // added
    expect(fs.existsSync(target + '.bak')).toBe(true);     // backed up
  });

  it('codex second run reports updated', async () => {
    const target = path.join(tmpDir, 'codex-config.toml');
    await runSetupInner('codex', { path: target });
    const r = await runSetupInner('codex', { path: target });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('updated');
  });

  it('claude-code with --path override writes JSON directly (bypasses shellout)', async () => {
    const target = path.join(tmpDir, 'claude.json');
    const r = await runSetupInner('claude-code', { path: target });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(parsed.mcpServers.clawdcursor).toBeDefined();
  });

  it('claude-code with --print emits JSON without spawning a process', async () => {
    const r = await runSetupInner('claude-code', { print: true });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('printed');
    expect(r.messages.join('\n')).toContain('clawdcursor');
  });

  it('--print returns valid parseable JSON in its content field', async () => {
    const r = await runSetupInner('cursor', { print: true, path: path.join(tmpDir, 'x.json') });
    expect(r.exitCode).toBe(0);
    expect(r.content).toBeDefined();
    const parsed = JSON.parse(r.content!);
    expect(parsed.mcpServers.clawdcursor).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setup-editors metadata sanity
// ─────────────────────────────────────────────────────────────────────────────

describe('setup-editors metadata', () => {
  it('every editor in listEditorIds() resolves via getEditor()', () => {
    for (const id of listEditorIds()) {
      const cfg = getEditor(id);
      expect(cfg).not.toBeNull();
      expect(cfg!.id).toBe(id);
      expect(cfg!.name.length).toBeGreaterThan(0);
    }
  });

  it('claude resolves to a per-OS file path', () => {
    const cfg = getEditor('claude')!;
    const home = '/tmp/home';
    const env: NodeJS.ProcessEnv = { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' };

    const macRes = cfg.resolvePath('darwin', home, env);
    expect(macRes.kind).toBe('file');
    if (macRes.kind === 'file') expect(macRes.path).toMatch(/Library.Application Support.Claude/);

    const winRes = cfg.resolvePath('win32', home, env);
    expect(winRes.kind).toBe('file');
    if (winRes.kind === 'file') expect(winRes.path).toMatch(/Claude.claude_desktop_config\.json$/);

    const linuxRes = cfg.resolvePath('linux', home, env);
    expect(linuxRes.kind).toBe('file');
  });

  it('claude-code uses shellout', () => {
    const cfg = getEditor('claude-code')!;
    const r = cfg.resolvePath(process.platform, '/tmp', process.env);
    expect(r.kind).toBe('shellout');
    if (r.kind === 'shellout') {
      expect(r.argv[0]).toBe('claude');
      expect(r.argv).toContain('clawdcursor');
    }
  });

  it('codex resolves to ~/.codex/config.toml', () => {
    const cfg = getEditor('codex')!;
    const r = cfg.resolvePath(process.platform, '/tmp/home', process.env);
    expect(r.kind).toBe('file');
    if (r.kind === 'file') {
      expect(r.path).toMatch(/\.codex.config\.toml$/);
      expect(r.format).toBe('toml');
    }
  });

  it('cursor resolves to ~/.cursor/mcp.json with json format', () => {
    const cfg = getEditor('cursor')!;
    const r = cfg.resolvePath(process.platform, '/tmp/home', process.env);
    expect(r.kind).toBe('file');
    if (r.kind === 'file') {
      expect(r.path).toMatch(/\.cursor.mcp\.json$/);
      expect(r.format).toBe('json');
    }
  });

  it('windsurf resolves to ~/.codeium/windsurf/mcp_config.json', () => {
    const cfg = getEditor('windsurf')!;
    const r = cfg.resolvePath(process.platform, '/tmp/home', process.env);
    expect(r.kind).toBe('file');
    if (r.kind === 'file') {
      expect(r.path).toMatch(/\.codeium.windsurf.mcp_config\.json$/);
    }
  });
});
