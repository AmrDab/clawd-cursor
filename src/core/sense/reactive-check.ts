/**
 * Layer C — reactive step discipline. After a consequential action, verify the
 * agent-stated expected effect (hard) or a tolerant "did anything change" net
 * (soft), so the agent never blindly proceeds on an action that didn't take.
 * Pure over its inputs + PlatformAdapter reads (OS-agnostic, unit-testable).
 * See docs/superpowers/specs/2026-06-07-ui-state-compiler-layer-c-design.md.
 */
import type { PlatformAdapter } from '../../platform/types';
import { parseAssertions, checkAssertions, renderReport } from '../verify/assertions';

export interface ReactiveInput {
  /** Raw `expect` arg from the tool call (assertions array), or undefined. */
  expect: unknown;
  /** The tool's own result text + success, to fold the note into. */
  toolText: string;
  toolSuccess: boolean;
  /** Whether the tool is screen-changing (consequential). */
  changesScreen: boolean;
  /** Whether the loop observed a change after the action (fingerprint/pixel). */
  observedChange: boolean;
  adapter: PlatformAdapter;
  /** Lazy OCR reader for ocr_contains assertions; omit when unavailable. */
  ocrText?: () => Promise<string>;
}

/** A modified result (success/text) to replace the tool's, or null = leave as-is. */
export interface ReactiveOutcome { success: boolean; text: string; }

export async function reactiveCheck(input: ReactiveInput): Promise<ReactiveOutcome | null> {
  const hasExpect = input.expect !== undefined && input.expect !== null;

  if (hasExpect) {
    const parsed = parseAssertions(input.expect);
    if ('error' in parsed) {
      return { success: false, text: `${input.toolText}\nexpect rejected: ${parsed.error}` };
    }
    const report = await checkAssertions(parsed.assertions, { adapter: input.adapter, ocrText: input.ocrText });
    if (report.ok) {
      return { success: input.toolSuccess, text: `${input.toolText} — verified ${report.passed} check(s)` };
    }
    return {
      success: false,
      text: `${input.toolText}\nDEVIATION: ${report.failed}/${report.outcomes.length} expected check(s) failed — the action did not achieve its effect; adapt (re-find, retry, or a different approach) before continuing:\n${renderReport(report)}`,
    };
  }

  // No expect: tolerant soft net — only for a SUCCESSFUL consequential action
  // that produced no observable change. Never fails the action.
  if (input.changesScreen && input.toolSuccess && !input.observedChange) {
    return { success: true, text: `${input.toolText}\n⚠ no observable change — verify it took (pass \`expect\`) or try another approach.` };
  }

  return null;
}
