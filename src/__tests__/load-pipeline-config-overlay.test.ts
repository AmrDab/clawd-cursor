/**
 * Regression tests for the CLI-flag → pipeline-config overlay path.
 *
 * Bug context (fix/cli-flags-ignored-by-agent-loop):
 *   `clawdcursor agent --provider ollama --base-url X --text-model Y --api-key Z`
 *   would print "Using externally configured models: text=Y | vision=" but
 *   then the agent runtime read from loadPipelineConfig() which only looked
 *   at .clawdcursor-config.json. With no file on disk, the pipeline started
 *   with models=text=off and every ladder rung short-circuited.
 *
 * These tests assert that when resolveConfig() returns a ResolvedConfig with
 * CLI-sourced fields, passing that overlay to loadPipelineConfig() produces
 * a PipelineConfig whose layer2/layer3 carry the CLI-supplied values — even
 * when no .clawdcursor-config.json exists.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveConfig } from '../llm/config';
import { loadPipelineConfig } from '../surface/doctor';
import { getPackageRoot } from '../paths';

const CONFIG_FILE = '.clawdcursor-config.json';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-overlay-test-'));
}

// loadPipelineConfig() reads from `<packageRoot>/.clawdcursor-config.json`
// first and falls back to `<cwd>/.clawdcursor-config.json`. We snapshot and
// restore that file so any pre-existing real config is preserved across
// the test run, and the disk read is guaranteed to find "no file" by
// default.
let _savedPkgConfig: string | null = null;
const _pkgConfigPath = path.join(getPackageRoot(), CONFIG_FILE);

function clearPkgConfig(): void {
  if (_savedPkgConfig !== null) {
    fs.writeFileSync(_pkgConfigPath, _savedPkgConfig);
    _savedPkgConfig = null;
  } else if (fs.existsSync(_pkgConfigPath)) {
    fs.unlinkSync(_pkgConfigPath);
  }
}

beforeEach(() => {
  // Snapshot any existing pkg-root config so tests start from a clean slate.
  if (fs.existsSync(_pkgConfigPath)) {
    _savedPkgConfig = fs.readFileSync(_pkgConfigPath, 'utf-8');
    fs.unlinkSync(_pkgConfigPath);
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  clearPkgConfig();
  vi.restoreAllMocks();
});

describe('loadPipelineConfig(overlay) — CLI flags reach the runtime', () => {
  /**
   * Primary regression: this is the live-test scenario from BUG-A.
   * With NO .clawdcursor-config.json and CLI flags supplying provider +
   * base-url + text-model + api-key, the runtime MUST see those flags
   * via loadPipelineConfig — otherwise the pipeline boots with
   * `models=text=off vision=disabled` and every rung short-circuits.
   */
  it('synthesizes a PipelineConfig from CLI flags when no config file exists', () => {
    const tmpDir = makeTmpDir();
    const resolved = resolveConfig({
      cliFlags: {
        provider: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        textModel: 'minimax-m2.5:cloud',
        apiKey: 'cli-key-xyz',
      },
      // Point at non-existent paths so disk has no .clawdcursor-config.json
      projectConfigPath: path.join(tmpDir, 'nope-project.json'),
      userConfigPath: path.join(tmpDir, 'nope-user.json'),
      envOverride: {},
    });

    expect(resolved.source.model).toBe('cli');
    expect(resolved.source.baseUrl).toBe('cli');
    expect(resolved.source.apiKey).toBe('cli');

    const pipeline = loadPipelineConfig(resolved);

    // The whole point of the fix: CLI flags MUST reach loadPipelineConfig
    // even with no disk config.
    expect(pipeline).not.toBeNull();
    expect(pipeline!.layer2.model).toBe('minimax-m2.5:cloud');
    expect(pipeline!.layer2.baseUrl).toBe('http://localhost:11434/v1');
    expect(pipeline!.layer2.apiKey).toBe('cli-key-xyz');
    expect(pipeline!.layer2.enabled).toBe(true);
    expect(pipeline!.providerKey).toBe('ollama');
  });

  it('passes CLI text-model through even when only --text-model + --base-url + --api-key supplied (no --provider)', () => {
    const tmpDir = makeTmpDir();
    const resolved = resolveConfig({
      cliFlags: {
        baseUrl: 'http://localhost:11434/v1',
        textModel: 'qwen2.5:7b',
        apiKey: 'sk-test',
      },
      projectConfigPath: path.join(tmpDir, 'nope-project.json'),
      userConfigPath: path.join(tmpDir, 'nope-user.json'),
      envOverride: {},
    });

    const pipeline = loadPipelineConfig(resolved);

    expect(pipeline).not.toBeNull();
    expect(pipeline!.layer2.model).toBe('qwen2.5:7b');
    expect(pipeline!.layer2.baseUrl).toBe('http://localhost:11434/v1');
    expect(pipeline!.layer2.enabled).toBe(true);
  });

  it('returns null when no overlay AND no disk config (the original broken state, preserved as default for non-overlay callers)', () => {
    const pipeline = loadPipelineConfig(undefined);
    expect(pipeline).toBeNull();
  });

  it('returns null when overlay has no CLI-sourced fields and no disk config', () => {
    const tmpDir = makeTmpDir();
    const resolved = resolveConfig({
      cliFlags: {}, // empty — everything falls through to default
      projectConfigPath: path.join(tmpDir, 'nope-project.json'),
      userConfigPath: path.join(tmpDir, 'nope-user.json'),
      envOverride: {},
    });
    const pipeline = loadPipelineConfig(resolved);
    expect(pipeline).toBeNull();
  });

  it('vision flags propagate when supplied (layer3 enabled with CLI --vision-model + --base-url)', () => {
    const tmpDir = makeTmpDir();
    const resolved = resolveConfig({
      cliFlags: {
        baseUrl: 'http://localhost:11434/v1',
        textModel: 'qwen2.5:7b',
        visionModel: 'llava:13b',
        apiKey: 'sk-test',
      },
      projectConfigPath: path.join(tmpDir, 'nope-project.json'),
      userConfigPath: path.join(tmpDir, 'nope-user.json'),
      envOverride: {},
    });

    const pipeline = loadPipelineConfig(resolved);
    expect(pipeline).not.toBeNull();
    expect(pipeline!.layer3.model).toBe('llava:13b');
    expect(pipeline!.layer3.baseUrl).toBe('http://localhost:11434/v1');
    expect(pipeline!.layer3.enabled).toBe(true);
  });
});
