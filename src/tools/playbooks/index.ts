/**
 * Playbook registry.
 *
 * Playbooks are app-AGNOSTIC keyboard choreographies for known capability
 * shapes the vision loop would otherwise re-discover on every run. They
 * are NOT app-specific shortcuts. Each playbook implements ONE capability
 * (e.g. "compose+submit a form with To/Subject/Body fields") and works
 * across every app that follows the same UX convention.
 *
 * Dispatch: matchPlaybook routes by CAPABILITY (the user's intent),
 * never by app name. This is the key rule: if the same user intent
 * routes to two different playbooks because the active app changed,
 * the playbooks should be merged.
 *
 * Dispatched by the pipeline as a first-class Strategy ('playbook') sitting
 * between the router and the LLM ladder; NOT exposed on the public MCP
 * surface. compose-send specifically prefers the OS protocol-handler path
 * (mailto://, tel://, slack://, vscode://, ...) via
 * resolveSchemeHandlerExecutable + launchHandlerAndVerify; the in-app
 * keyboard choreography here is the fallback when no protocol handler is
 * registered or the dispatched window never appears.
 *
 * Each playbook is a pure function over PlatformAdapter + args. No
 * per-playbook state, no retries (that's the verifier's job).
 */

import type { PlatformAdapter } from '../../platform/types';
import { composeSend } from './compose-send';
import { findReplace } from './find-replace';

export interface PlaybookResult {
  success: boolean;
  /** One-line description for logs + verifier context. */
  text: string;
  /** Trace of executed steps for skill-cache recording. */
  steps: Array<{ type: 'click' | 'type' | 'key' | 'scroll' | 'wait'; description: string; [k: string]: unknown }>;
}

export interface PlaybookArgs {
  adapter: PlatformAdapter;
  /** Free-form args (recipient, subject, body, findText, etc.). */
  input: Record<string, string | undefined>;
  /** Whether to fire the submit/send keystroke at the end. Defaults to true
   *  (backward-compatible). compose-send passes false for draft-only tasks
   *  (the user asked to compose, not send) so the form is left for review. */
  send?: boolean;
}

export type Playbook = (args: PlaybookArgs) => Promise<PlaybookResult>;

/**
 * Capability-keyed playbook registry. Keys describe the INTENT, not the
 * app. New playbooks SHOULD be added if they generalize across apps;
 * playbooks that name an app are an antipattern and should be merged
 * into a capability-keyed sibling.
 */
export const PLAYBOOKS: Record<string, Playbook> = {
  'compose-send': composeSend,
  'find-replace': findReplace,
};

/**
 * Match a task to a playbook name by CAPABILITY ONLY. activeApp is
 * intentionally not consulted \u2014 if the same intent needs two different
 * playbooks for two different apps, merge them. The first-class path
 * for email is open_uri(mailto: ...); we offer compose-send as the
 * in-UI fallback when the user explicitly wants to compose in-app.
 *
 * Returns null when nothing matches \u2014 caller proceeds with the
 * text-agent's normal a11y-driven flow.
 */
export function matchPlaybook(task: string, _activeApp: string): string | null {
  const t = task.toLowerCase();

  // Compose + submit form (mail, message, or any compose-style flow).
  // Matches any intent that asks to compose AND send/submit AND has a
  // recipient-like noun. Pure regex \u2014 no app names.
  if (/\bsend\b.*\b(email|message|mail|note|invite)\b|\bcompose\b.*\b(email|message|mail)\b|\bsend\s+to\s+\S+@/i.test(t)) {
    return 'compose-send';
  }

  // Find & replace \u2014 universal across text editors, IDEs, browsers, docs.
  if (/\bfind\s+and\s+replace\b|\breplace\s+all\b/i.test(t)) {
    return 'find-replace';
  }

  return null;
}

export { composeSend, findReplace };
