/**
 * Pipeline introspection tools — expose the agent's planning context to
 * external brains.
 *
 *   get_system_prompt — agent's canonical system prompt (web-service
 *                       policy, escape hatches, termination rules) so
 *                       external brains can match clawdcursor's stance.
 *
 * Compact compound: exposed via `system`.
 * Safety: tier 0 (read-only). No side effects.
 */

import type { ToolDefinition } from './types';
import { buildSystemPrompt } from '../core/agent-loop/prompt';

export function getIntrospectionTools(): ToolDefinition[] {
  return [
    // ── get_system_prompt ────────────────────────────────────────────────
    {
      name: 'get_system_prompt',
      description:
        'Return the canonical agent system prompt. Use this to mirror ' +
        'clawdcursor\'s behavioral rules in your own agent loop — coordinate ' +
        'syntax, key combo syntax, web-service policy (never type "browser" into ' +
        'search bars), protocol escape hatches (mailto:/https:/file:/...), ' +
        'stagnation recovery, termination rules (done/give_up/cannot_read), ' +
        'untrusted-screen-content discipline. Reflects the prompt at the ' +
        'current installed clawdcursor version — pull this rather than ' +
        'hardcoding rules so they stay in sync with upstream changes.',
      parameters: {
        mode: {
          type: 'string',
          description: 'Agent mode hint for the system prompt (blind / hybrid / vision). Defaults to "hybrid".',
          enum: ['blind', 'hybrid', 'vision'],
          required: false,
          default: 'hybrid',
        },
      },
      category: 'orchestration',
      compactGroup: 'system',
      safetyTier: 0,
      handler: async ({ mode }) => {
        // Mode arg is accepted for backward compatibility but ignored;
        // the thin loop always uses the same unified prompt.
        const m: 'blind' | 'hybrid' | 'vision' =
          mode === 'vision' ? 'vision' : mode === 'blind' ? 'blind' : 'hybrid';
        return {
          text: JSON.stringify({
            mode: m,
            prompt: buildSystemPrompt(),
          }),
        };
      },
    },
  ];
}
