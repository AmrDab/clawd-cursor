/**
 * Agent — thin entry point that routes every task through the unified
 * pipeline. The v0.7 cascade (computer-use, ai-brain, action-router,
 * a11y-reasoner, ocr-reasoner, etc.) was deleted in v0.9.0; the canonical
 * pipeline now lives in `src/core/pipeline.ts`.
 *
 * Construction is intentionally minimal — the agent owns the desktop /
 * a11y / OCR primitives and forwards everything else to the pipeline.
 */

import { NativeDesktop } from '../platform/native-desktop';
import { AccessibilityBridge } from '../platform/accessibility';
import { OcrEngine } from '../platform/ocr-engine';
import { loadPipelineConfig } from '../surface/doctor';
import type { ClawdConfig, AgentState, TaskResult, StepResult } from '../types';
import type { ResolvedConfig } from '../llm/config';

/**
 * Provider-agnostic Anthropic-endpoint detector. Anthropic native endpoints
 * use the `/messages` API shape; everything else (OpenAI, Groq, Together,
 * Kimi, DeepSeek, Ollama, Gemini-via-OpenAI-compat) uses `/chat/completions`.
 * Local endpoints and Ollama always take the OpenAI-compat path even if their
 * host happens to match an Anthropic-ish substring.
 */
function isAnthropicEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  if (baseUrl.includes('localhost')) return false;
  if (baseUrl.includes('11434')) return false; // Ollama default port
  return baseUrl.includes('anthropic.com');
}

export class Agent {
  private desktop: NativeDesktop;
  private a11y: AccessibilityBridge;
  private ocrEngine: OcrEngine;
  private config: ClawdConfig;
  private resolvedConfig: ResolvedConfig | null = null;
  private hasApiKey: boolean;
  private state: AgentState = {
    status: 'idle',
    stepsCompleted: 0,
    stepsTotal: 0,
  };
  private aborted = false;
  private taskExecutionLocked = false;

  private pipelineUnified: import('./pipeline').Pipeline | null = null;

  constructor(config: ClawdConfig, resolvedConfig?: ResolvedConfig) {
    this.config = config;
    this.resolvedConfig = resolvedConfig ?? null;
    this.desktop = new NativeDesktop(config);
    this.a11y = new AccessibilityBridge();
    this.ocrEngine = new OcrEngine();

    // hasApiKey gates the offline-mode banner — true if any cloud key is
    // configured. Local LLM (Ollama) is always available via the pipeline,
    // so absence of cloud keys just means we'll print an offline notice.
    const hasCloudKey = !!(config.ai.apiKey && config.ai.apiKey.length > 0);
    const hasVisionKey = !!(config.ai.visionApiKey && config.ai.visionApiKey.length > 0);
    this.hasApiKey = hasCloudKey || hasVisionKey;

    if (!this.hasApiKey) {
      console.log(`⚡ Running in offline mode (no API key). Router + playbooks only.`);
      console.log(`   To unlock AI fallback, set AI_API_KEY (or run: clawdcursor doctor)`);
    }
  }

  async connect(): Promise<void> {
    await this.desktop.connect();

    // Warm up the PSRunner bridge so assembly loading happens in background
    this.a11y.warmup().catch(() => {});

    // Touch the OCR engine so any first-call latency is paid up front.
    void this.ocrEngine;
  }

  /** Safety-net timeout — only fires if task is truly stuck (stagnation + abort didn't catch it) */
  private static readonly TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — generous, real stop signals are stagnation + abort

  async executeTask(task: string): Promise<TaskResult> {
    // Atomic concurrency guard — boolean lock prevents TOCTOU race
    // where two simultaneous /task requests both see status === 'idle'
    if (this.taskExecutionLocked || this.state.status !== 'idle') {
      return {
        success: false,
        steps: [{ action: 'error', description: 'Agent is busy', success: false, timestamp: Date.now() }],
        duration: 0,
      };
    }
    this.taskExecutionLocked = true;

    this.aborted = false;
    const startTime = Date.now();

    // Wrap the entire task pipeline with a global wall-clock timeout.
    // Individual layers have their own iteration limits, but a deadlocked
    // LLM call could still exceed the limit. IMPORTANT: clear the timer
    // when the task completes to prevent stale timeouts from aborting
    // future tasks (the aborted flag is shared).
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<TaskResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        this.aborted = true;
        console.warn(`\n⏱ Task timed out after ${Agent.TASK_TIMEOUT_MS / 60000} minutes`);
        resolve({
          success: false,
          steps: [{ action: 'error', description: `Task timed out after ${Agent.TASK_TIMEOUT_MS / 60000} minutes`, success: false, timestamp: Date.now() }],
          duration: Date.now() - startTime,
        });
      }, Agent.TASK_TIMEOUT_MS);
    });

    try {
      return await Promise.race([this._executeTaskUnified(task, startTime), timeoutPromise]);
    } finally {
      // Always clear the 5-minute timer so it doesn't keep the process alive
      // and hold a closure reference to this Agent instance after the task ends.
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      this.taskExecutionLocked = false;
    }
  }

  /**
   * v0.8.1 unified pipeline — blind-first by construction; vision is the
   * fallback, not a competing default. Decomposer splits compound tasks
   * into subtasks, each of which runs its own full pipeline cycle.
   *
   * Routes through: classify → router → knowledge → sense (a11y) →
   * text-agent (no screenshots) → vision-agent (fallback).
   *
   * Model-agnostic: LLM clients are injected from the live provider
   * config. No premium retry tier, no per-model escape hatch. If vision
   * also fails, the MCP client is free to retry with a different strategy.
   *
   * Lazy-loaded so import cost is paid on first task, not at startup.
   */
  private async _executeTaskUnified(task: string, startTime: number): Promise<TaskResult> {
    if (!this.pipelineUnified) {
      const { Pipeline } = await import('./pipeline');
      const { getPlatform } = await import('../platform');
      const adapter = await getPlatform();
      // Pass the resolved CLI overlay so flags supplied at boot time
      // (--text-model, --base-url, --api-key, ...) are honoured even
      // when no .clawdcursor-config.json exists on disk. Without this
      // the runtime ignores CLI flags and falls back to disk-only,
      // producing `models=text=off vision=disabled` and short-circuiting
      // every ladder rung.
      const pipelineConfig = loadPipelineConfig(this.resolvedConfig);

      const hasTextModel   = !!(pipelineConfig?.layer2.model && pipelineConfig.layer2.baseUrl);
      const hasVisionModel = !!(pipelineConfig?.layer3?.model && pipelineConfig?.layer3?.baseUrl);

      // Build direct LLM configs for the unified agent. The agent uses
      // native tool_use (Anthropic) / tool_calls (OpenAI) via
      // callLLMWithTools — so we pass baseUrl/model/apiKey/isAnthropic
      // rather than wrapping callTextLLM / callVisionLLM.
      const textConfig = hasTextModel && pipelineConfig
        ? {
            baseUrl: pipelineConfig.layer2.baseUrl,
            model: pipelineConfig.layer2.model,
            apiKey: pipelineConfig.layer2.apiKey || pipelineConfig.apiKey || '',
            isAnthropic: isAnthropicEndpoint(pipelineConfig.layer2.baseUrl),
            maxTokens: 1024,
          }
        : undefined;

      const visionLayer = pipelineConfig?.layer3;
      const visionConfig = hasVisionModel && visionLayer && pipelineConfig
        ? {
            baseUrl: visionLayer.baseUrl,
            model: visionLayer.model,
            apiKey: visionLayer.apiKey || pipelineConfig.apiKey || '',
            isAnthropic: isAnthropicEndpoint(visionLayer.baseUrl),
            maxTokens: 1024,
          }
        : undefined;

      // Prefer resolved config values; fall back to env vars for backward compat
      // when agent is constructed without a ResolvedConfig (e.g. tool server).
      const disableVision   = this.resolvedConfig?.disableVision
                           ?? (process.env.OPENCLAW_DISABLE_VISION   === '1' || process.env.CLAWD_DISABLE_VISION   === '1');
      const disableVerifier = this.resolvedConfig?.disableVerifier
                           ?? (process.env.OPENCLAW_DISABLE_VERIFIER === '1' || process.env.CLAWD_DISABLE_VERIFIER === '1');

      this.pipelineUnified = new Pipeline({
        adapter,
        llm: {
          text: textConfig,
          vision: visionConfig,
        },
        disableVision,
        // Ground-truth verifier is on by default — every successful agent
        // rung is post-checked against actual screen state, and failed
        // verification demotes the rung so the ladder climbs. Opt-out
        // mirrors the vision-disable pattern.
        disableVerifier,
      });

      if (!hasTextModel && !hasVisionModel) {
        console.log('⚡ No AI model configured — only router/playbook tasks will run.');
        console.log('   Run `clawdcursor doctor` to configure an AI provider (any OpenAI-compatible endpoint).');
      }
      // Otherwise the new logger's header block prints the full task banner
      // (task + correlationId + models) when pipeline.start fires.
    }

    this.state = { ...this.state, status: 'thinking', currentTask: task, stepsCompleted: 0, stepsTotal: 0 };

    const result = await this.pipelineUnified.run({
      task,
      isAborted: () => this.aborted,
    });

    const steps: StepResult[] = result.trace.length > 0
      ? result.trace.map(t => ({
          action: (t.action as any).type ?? 'unknown',
          description: t.result.text,
          success: t.result.success,
          timestamp: Date.now(),
          layer: result.path === 'text-agent' ? 'ocr' as const : 'unified' as const,
          method: (t.action as any).type,
          latencyMs: t.durationMs,
        }))
      : [{
          action: result.success ? 'done' : 'error',
          description: result.text,
          success: result.success,
          timestamp: Date.now(),
          layer: result.path === 'router' ? 'router' as const : 'unified' as const,
        }];

    // The new logger emits a `pipeline.done` footer block (path + cost +
    // duration, framed in a divider) so we skip the legacy double banner.
    // Final free-text evidence still goes to stdout for the MCP / REST client.
    if (result.text) {
      console.log(`   ${result.text}`);
    }

    this.state.status = 'idle';
    return {
      success: result.success,
      steps,
      duration: Date.now() - startTime,
    };
  }

  abort(): void {
    this.aborted = true;
    this.state = { status: 'idle', stepsCompleted: 0, stepsTotal: 0 };
  }

  getState(): AgentState {
    return { ...this.state };
  }

  getDesktop(): NativeDesktop {
    return this.desktop;
  }

  getA11y(): AccessibilityBridge {
    return this.a11y;
  }

  disconnect(): void {
    this.desktop.disconnect();
  }
}
