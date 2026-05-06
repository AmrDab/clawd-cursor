/**
 * External-credential reader.
 *
 * Loads provider API keys from cohabitating agent frameworks (OpenClaw,
 * future hosts) so users who configure credentials there don't have to
 * re-enter them as environment variables.
 *
 * Single source of truth — both `scanProviders()` (doctor's all-providers
 * scan) and `resolveApiConfig({ provider })` (start's per-provider lookup)
 * consult this module so they can never disagree about which key belongs
 * to which provider. v0.8.8 had a real bug where doctor read the right
 * Kimi key but start fell back to the wrong (Anthropic) key on the same
 * machine because only doctor was wired to the OpenClaw profile reader.
 *
 * Read once, cache forever (per-process). Tests can call
 * `clearExternalProviderKeysCache()` to invalidate.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ExternalProviderEntry {
  apiKey: string;
  baseUrl?: string;
  /** Where this entry was sourced — for debugging / logs. */
  sourceFile?: string;
}

let cache: Record<string, ExternalProviderEntry> | null = null;

/**
 * External profile-name → clawdcursor provider key.
 * Mirrors the map inside `scanProviders` so the two code paths agree.
 * If you add a new provider, update both — or better, refactor scanner
 * to import this map directly.
 */
const EXTERNAL_PROVIDER_MAP: Record<string, string> = {
  'anthropic': 'anthropic',
  'openai': 'openai',
  'moonshot': 'kimi',
  'kimi': 'kimi',
  'groq': 'groq',
  'together': 'together',
  'deepseek': 'deepseek',
  'gemini': 'gemini',
  'google': 'gemini',
  'mistral': 'mistral',
  'xai': 'xai',
  'grok': 'xai',
  'alibaba': 'alibaba',
  'qwen': 'alibaba',
  'dashscope': 'alibaba',
  'fireworks': 'fireworks',
  'cohere': 'cohere',
  'perplexity': 'perplexity',
  'pplx': 'perplexity',
};

/**
 * Locate auth-profile JSON files from known external hosts.
 * Returns absolute paths, including only files that actually exist.
 */
function discoverAuthProfilePaths(): string[] {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json'),
    path.join(home, '.openclaw', 'agents', 'main', 'auth-profiles.json'),
    path.join(home, '.openclaw-dev', 'agents', 'main', 'agent', 'auth-profiles.json'),
    path.join(home, '.openclaw-dev', 'agents', 'main', 'auth-profiles.json'),
  ];
  return candidates.filter(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

/**
 * Read all external provider keys, merged across known hosts.
 * First-write-wins per provider (so `.openclaw` beats `.openclaw-dev`
 * if both define the same provider).
 */
export function loadExternalProviderKeys(): Record<string, ExternalProviderEntry> {
  if (cache !== null) return cache;

  const keys: Record<string, ExternalProviderEntry> = {};

  for (const authPath of discoverAuthProfilePaths()) {
    try {
      const raw = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      // Two shapes seen in the wild: `{ profiles: { ... } }` and `{ <profileKey>: { ... } }`.
      const profiles = raw?.profiles ?? raw;
      if (!profiles || typeof profiles !== 'object') continue;

      for (const [profileKey, profileValue] of Object.entries(profiles)) {
        // Profile keys look like "anthropic" or "anthropic:default" — take the
        // segment before the colon as the provider name.
        const providerName = profileKey.split(':')[0].toLowerCase();
        const val = profileValue as { key?: string; apiKey?: string; api_key?: string; baseUrl?: string };
        const apiKey = val?.key || val?.apiKey || val?.api_key || '';
        if (!apiKey) continue;

        const clawdKey = EXTERNAL_PROVIDER_MAP[providerName];
        if (clawdKey && !keys[clawdKey]) {
          keys[clawdKey] = { apiKey, baseUrl: val.baseUrl, sourceFile: authPath };
        }
      }
    } catch {
      // Non-fatal: a malformed external file should never block clawdcursor.
    }
  }

  cache = keys;
  return keys;
}

/**
 * Get a specific provider's external key, or undefined if not found.
 * Use this in credential-resolution paths that want to consult external
 * hosts as one of several fallbacks.
 */
export function getExternalProviderKey(providerKey: string): string | undefined {
  if (!providerKey) return undefined;
  return loadExternalProviderKeys()[providerKey.toLowerCase()]?.apiKey;
}

/**
 * Get a specific provider's external base URL override (rare — only set
 * when an external host explicitly overrides the provider's default URL).
 */
export function getExternalProviderBaseUrl(providerKey: string): string | undefined {
  if (!providerKey) return undefined;
  return loadExternalProviderKeys()[providerKey.toLowerCase()]?.baseUrl;
}

/** Clear the in-process cache. Tests use this; runtime never should. */
export function clearExternalProviderKeysCache(): void {
  cache = null;
}
