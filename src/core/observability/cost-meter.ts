/**
 * Per-task cost meter — model-agnostic.
 *
 * Tracks tokens in/out per model, plus non-LLM costs (OCR calls, screenshot
 * bytes) if we want to surface those later. Converts to USD via a static
 * price table that is overrideable at runtime.
 *
 * Why this exists: the product claim is "cost-aware — picks the cheapest path
 * that works." The audit showed we had no way to prove it. The cost meter
 * makes blind-first savings visible in /task responses and in a new
 * `clawdcursor cost` CLI.
 *
 * Price table is loaded from:
 *   1. ~/.clawdcursor/pricing.json (user override; precedence)
 *   2. src/core/observability/pricing.default.json (bundled defaults)
 *
 * Unknown models fall back to { inputPerM: 1.0, outputPerM: 5.0 } — a safe
 * ballpark that won't silently report $0 for unmapped models.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
}

const FALLBACK_PRICE: ModelPrice = { inputPerM: 1.0, outputPerM: 5.0 };

// Published list prices as of plan-time. User can override per provider/model
// via ~/.clawdcursor/pricing.json without code changes.
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // Anthropic (approximate public list prices)
  'claude-haiku-4-5': { inputPerM: 1.0, outputPerM: 5.0 },
  'claude-sonnet-4-6': { inputPerM: 3.0, outputPerM: 15.0 },
  'claude-opus-4': { inputPerM: 15.0, outputPerM: 75.0 },
  'claude-opus-4-6': { inputPerM: 15.0, outputPerM: 75.0 },
  // OpenAI
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.60 },
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10.0 },
  // Ollama / local — zero by construction
  'llama3.2': { inputPerM: 0.0, outputPerM: 0.0 },
  'qwen2.5:7b': { inputPerM: 0.0, outputPerM: 0.0 },
  // Groq
  'llama-3.3-70b-versatile': { inputPerM: 0.59, outputPerM: 0.79 },
  // Kimi / Moonshot
  'moonshot-v1-8k': { inputPerM: 0.15, outputPerM: 2.0 },
};

let loadedPrices: Record<string, ModelPrice> | null = null;

function loadPrices(): Record<string, ModelPrice> {
  if (loadedPrices) return loadedPrices;
  const override = path.join(os.homedir(), '.clawdcursor', 'pricing.json');
  let merged = { ...DEFAULT_PRICES };
  try {
    if (fs.existsSync(override)) {
      const parsed = JSON.parse(fs.readFileSync(override, 'utf8')) as Record<string, ModelPrice>;
      merged = { ...merged, ...parsed };
    }
  } catch {
    // Bad override file — log would be nice, but cost-meter must stay silent.
  }
  loadedPrices = merged;
  return loadedPrices;
}

export function priceFor(model: string): ModelPrice {
  const table = loadPrices();
  // Exact match first, then provider-prefix match (e.g. "claude-sonnet-4-*").
  if (table[model]) return table[model];
  for (const key of Object.keys(table)) {
    if (model.startsWith(key)) return table[key];
  }
  return FALLBACK_PRICE;
}

export interface CostEvent {
  model: string;
  /** Where in the pipeline this cost was incurred. Kept wide enough to cover
   *  router-free stages (classify / decompose) and every unified-agent mode. */
  stage:
    | 'classify'
    | 'decompose'
    | 'decomposer-fallback'
    | 'text-agent'
    | 'vision-agent'
    | 'blind'
    | 'hybrid'
    | 'vision';
  inputTokens: number;
  outputTokens: number;
}

export interface CostSnapshot {
  totalUsd: number;
  byModel: Record<string, { inputTokens: number; outputTokens: number; usd: number }>;
  byStage: Record<string, { usd: number; calls: number }>;
}

export class CostMeter {
  private events: CostEvent[] = [];

  record(e: CostEvent): void {
    this.events.push(e);
  }

  snapshot(): CostSnapshot {
    const byModel: CostSnapshot['byModel'] = {};
    const byStage: CostSnapshot['byStage'] = {};
    let total = 0;
    for (const e of this.events) {
      const p = priceFor(e.model);
      const usd = (e.inputTokens / 1_000_000) * p.inputPerM + (e.outputTokens / 1_000_000) * p.outputPerM;
      total += usd;
      const m = byModel[e.model] ??= { inputTokens: 0, outputTokens: 0, usd: 0 };
      m.inputTokens += e.inputTokens;
      m.outputTokens += e.outputTokens;
      m.usd += usd;
      const s = byStage[e.stage] ??= { usd: 0, calls: 0 };
      s.usd += usd;
      s.calls += 1;
    }
    return { totalUsd: total, byModel, byStage };
  }
}
