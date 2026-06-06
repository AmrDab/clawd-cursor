/**
 * `batch` — the autonomous loop's action-list executor (Phase 3).
 *
 * Lets the cheap text brain (Haiku) plan SEVERAL known next actions and run them
 * in ONE turn instead of one tool-call per LLM round-trip. Same shape and
 * guarantees as the MCP-side `batch` (src/tools/batch.ts) but over the agent-loop
 * machinery: UnifiedTool catalog, AgentToolContext, and the loop's own
 * `safety.evaluate` chokepoint. Declarative + guarded:
 *
 *   - Each step { name, args, expect? } is a normal agent-loop tool call.
 *   - Optional `expect` ({window}|{element}) is re-checked by PERCEIVING the
 *     a11y tree before the step — so an action can't fire into the wrong window.
 *   - Halts on the first guard miss / safety stop / step failure and returns a
 *     trace; the loop continues (or the morph ladder escalates) from real state.
 *
 * The token A/B (scripts/measure-batch-tokens.ts) shows this collapses the
 * per-turn catalog/perception re-reads — the win grows with task length.
 */
import type { UnifiedTool, UnifiedToolResult, AgentToolContext } from './types';
import { buildUnifiedTools } from './tools';
import { evaluate as safetyEvaluate, isAllowed } from '../safety';

interface AgentBatchStep {
  name: string;
  args?: Record<string, unknown>;
  expect?: { element?: string; window?: string };
  label?: string;
}

const MAX_STEPS = 10;

/** Re-perceive the a11y tree (lower-cased) for guard checks. */
async function perceiveTree(ctx: AgentToolContext): Promise<string> {
  const rs = buildUnifiedTools().find(t => t.name === 'read_screen');
  if (!rs) return '';
  try { return ((await rs.execute({}, ctx)).text || '').toLowerCase(); } catch { return ''; }
}

export function buildBatchTool(): UnifiedTool {
  return {
    name: 'batch',
    description:
      'Run SEVERAL known next actions in ONE call instead of one per turn (saves round-trips). ' +
      'steps = JSON array of {"name","args","expect"?}. Each step is a normal tool call (e.g. ' +
      '{"name":"type","args":{"text":"hi"}}). Optional "expect" is a precondition re-checked by ' +
      'perceiving before the step: {"window":"notepad"} (that window must be focused) or ' +
      '{"element":"Send"} (that a11y element must exist). The batch STOPS at the first failed ' +
      'precondition, safety stop, or step error and returns a per-step trace so you continue from ' +
      'real state. Use it for deterministic stretches (open -> focus -> type -> save). Do NOT put ' +
      'perception-only reads or terminal tools (done/give_up/cannot_read) in a batch.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'string', description: 'JSON array of {name, args, expect?} steps (max 10).' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    changesScreen: true,
    async execute(args, ctx): Promise<UnifiedToolResult> {
      let steps: AgentBatchStep[];
      const raw = args.steps;
      try { steps = typeof raw === 'string' ? JSON.parse(raw) : (raw as AgentBatchStep[]); }
      catch { return { success: false, text: 'batch: `steps` must be a JSON array of {name, args, expect?}.' }; }
      if (!Array.isArray(steps) || steps.length === 0) {
        return { success: false, text: 'batch: `steps` must be a non-empty array.' };
      }

      const byName = new Map(buildUnifiedTools().filter(t => t.name !== 'batch').map(t => [t.name, t]));
      const trace: string[] = [];
      let done = 0;
      const halt = (msg: string): UnifiedToolResult => ({ success: false, text: `${msg}\n${trace.join('\n')}` });

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const label = step.label || `${step.name}${step.args?.action ? '.' + String(step.args.action) : ''}`;

        if (i >= MAX_STEPS) { trace.push(`  ${i}. [skipped] ${label}`); return halt(`batch: ${done}/${steps.length} done — capped at ${MAX_STEPS}; submit the rest as a new batch.`); }

        const tool = byName.get(step.name);
        if (!tool) { trace.push(`  ${i}. [unknown] ${label}`); return halt(`batch halted: tool "${step.name}" is not available in this mode.`); }

        if (step.expect) {
          const tree = await perceiveTree(ctx);
          if (step.expect.window && !tree.includes(step.expect.window.toLowerCase())) {
            trace.push(`  ${i}. [guard_failed] ${label} — window "${step.expect.window}" not focused`);
            return halt(`batch halted at step ${i}: precondition failed (window "${step.expect.window}" not focused) — re-plan from current state.`);
          }
          if (step.expect.element && !tree.includes(step.expect.element.toLowerCase())) {
            trace.push(`  ${i}. [guard_failed] ${label} — element "${step.expect.element}" not present`);
            return halt(`batch halted at step ${i}: precondition failed (element "${step.expect.element}" not present) — re-plan from current state.`);
          }
        }

        const a = step.args ?? {};
        const targetLabel = typeof a.name === 'string' ? a.name : typeof a.target === 'string' ? a.target : undefined;
        const decision = safetyEvaluate({ tool: step.name, args: a, targetLabel, activeApp: ctx.activeApp, userTaskText: ctx.task });
        if (!isAllowed(decision)) {
          trace.push(`  ${i}. [${decision.decision}] ${label}`);
          const why = 'reason' in decision ? decision.reason : decision.tier;
          return halt(`batch halted at step ${i}: safety ${decision.decision} (${why}).`);
        }

        let res: UnifiedToolResult;
        try { res = await tool.execute(a, ctx); }
        catch (e) { res = { success: false, text: `threw: ${e instanceof Error ? e.message : String(e)}` }; }
        if (!res.success) {
          trace.push(`  ${i}. [error] ${label} — ${(res.text || '').slice(0, 100)}`);
          return halt(`batch halted at step ${i} (${label}): ${(res.text || '').slice(0, 120)}`);
        }
        trace.push(`  ${i}. [ok] ${label} — ${(res.text || '').slice(0, 80)}`);
        done++;
      }
      return { success: true, text: `batch: all ${steps.length} steps completed.\n${trace.join('\n')}` };
    },
  };
}
