/**
 * Cross-rung agent handoff.
 *
 * When the morph ladder escalates one rung to the next (blind → hybrid →
 * vision, or any reflector-driven jump), the next agent should CONTINUE from
 * where the previous one left off — not restart from zero. This builds a
 * concise, GENERIC, task-agnostic note from the finishing agent's own trace:
 * what it accomplished, what it last observed/reasoned, and why it handed off.
 * The next agent re-perceives the live screen itself; the handoff just tells it
 * the story so far so the two agents (text and vision) effectively talk to each
 * other across the escalation.
 *
 * Pure + deterministic — NO LLM, no task-specific strings, no app-specific
 * logic. Works for any task on any OS.
 */

import type { AgentResult, AgentMode, AgentStep } from './types';

/** Max characters of the handoff note — keep it cheap to carry forward. */
const MAX_HANDOFF_CHARS = 700;
/** How many recent successful actions to list. */
const MAX_ACTIONS = 6;

/** Tools that only perceive — not worth reporting as "accomplished" work. */
const PERCEPTION_TOOLS = new Set([
  'read_screen', 'screenshot', 'list_windows', 'get_active_window',
  'wait', 'cannot_read', 'give_up', 'done',
]);

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** One short line describing an action step, e.g. `click(x=649,y=546) → ok`. */
function describeStep(step: AgentStep): string {
  const args = Object.entries(step.toolArgs ?? {})
    .filter(([, v]) => typeof v !== 'object')
    .map(([k, v]) => `${k}=${clip(String(v), 24)}`)
    .join(',');
  const sig = args ? `${step.toolName}(${args})` : step.toolName;
  return clip(`${sig} → ${step.result.text}`, 120);
}

/** Exit-reason-specific guidance for the receiving agent. */
function whyHandedOff(result: AgentResult): string {
  switch (result.exit) {
    case 'cannot_read':
      return 'The accessibility tree could not describe the target (canvas / custom-rendered / sparse a11y). Drive it by the screenshot instead.';
    case 'give_up':
      return 'The previous approach stopped making progress. Try a DIFFERENT method than the actions listed above.';
    case 'stagnation':
      return 'The screen stopped changing for the previous agent. Re-check focus and try a different target or gesture.';
    case 'max_turns':
      return 'The previous agent ran out of turns mid-task. Continue the remaining steps from the state above.';
    case 'llm_error':
    case 'parse_error':
      return 'The previous agent was interrupted. Continue the task from the state above.';
    default:
      return 'Continue the task from the state above.';
  }
}

/**
 * Build a handoff note from a finishing agent's result. Returns `undefined`
 * when there is nothing useful to pass on (e.g. the agent did literally
 * nothing) so callers can skip injecting an empty note.
 */
export function summarizeForHandoff(result: AgentResult, mode: AgentMode): string | undefined {
  if (!result || !Array.isArray(result.steps) || result.steps.length === 0) return undefined;

  // Actions the previous agent actually performed (successful, non-perception).
  const actions = result.steps
    .filter(s => s.result?.success && !PERCEPTION_TOOLS.has(s.toolName))
    .slice(-MAX_ACTIONS)
    .map(describeStep);

  // The agent's last substantive reasoning — usually explains the blocker.
  const lastThought = [...result.steps]
    .reverse()
    .map(s => s.thought)
    .find(t => t && t.trim().length > 0);

  // If the agent neither did anything nor reasoned, there's nothing to hand off.
  if (actions.length === 0 && !lastThought) return undefined;

  const lines: string[] = [];
  lines.push(`PRIOR ATTEMPT — ${mode} agent (exited: ${result.exit}). You are continuing the SAME task; do not restart from scratch.`);
  if (actions.length > 0) {
    lines.push(`Already done (do NOT repeat): ${actions.join(' | ')}`);
  } else {
    lines.push('Already done: nothing took effect.');
  }
  if (lastThought) lines.push(`Last reasoning: "${clip(lastThought, 200)}"`);
  lines.push(`Why handed to you: ${whyHandedOff(result)}`);

  // Preserve the line structure (more readable for the receiving agent);
  // truncate by length only.
  const note = lines.join('\n');
  return note.length > MAX_HANDOFF_CHARS ? note.slice(0, MAX_HANDOFF_CHARS - 1) + '…' : note;
}
