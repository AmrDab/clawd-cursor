/**
 * compose-send playbook.
 *
 * App-agnostic keyboard choreography for "fill a compose form and submit":
 *   1. open a new compose window (mod+n is the cross-app convention)
 *   2. type the To value (the first field auto-focuses on every mail client)
 *   3. Tab past optional Cc/Bcc rows — count is platform-aware (see TAB_BUDGET)
 *   4. type the Subject (or skip if empty — but still advance one Tab to body)
 *   5. type the Body
 *   6. mod+Return to submit (cross-app send shortcut)
 *
 * Naming: this is named for the CAPABILITY, not for any specific app. The
 * same choreography works for any "compose with To/Subject/Body fields and
 * submit on mod+Return" form. The first-class path for email is
 * open_uri(mailto: ...) — use this playbook only when:
 *   - the user explicitly wants to compose inside the app's native UI, OR
 *   - the URI handler is broken / not registered on the user's machine.
 *
 * Zero app-specific branches. Zero title-bar matching.
 *
 * v0.9.1 fix: previous version hard-coded TWO Tabs after the recipient
 * (assuming Cc/Bcc are always visible) AND coupled the post-subject Tab
 * to `if (subject)`. On macOS Mail.app's default layout (Cc/Bcc collapsed)
 * the doubled Tab overshoots Subject and lands on Body; if the user task
 * had no explicit subject (e.g. "send an email introducing yourself") the
 * subject-step was skipped entirely AND so was its advance Tab — so body
 * got typed wherever focus happened to be, often the Body field directly,
 * but also frequently collided with Subject if Cc/Bcc were enabled. Both
 * cases were caught by the trailing summary's empty `subject=` field but
 * the playbook still returned success=true unconditionally and the
 * pipeline was exempting playbooks from the verifier (separate fix in
 * pipeline.ts). Result: false-positive "✅ done" on a broken send. Real
 * user report on macOS 12+/Apple Mail.
 */

import type { PlaybookArgs, PlaybookResult } from './index';

const COMPOSE_MOUNT_WAIT_MS = 1_000;
const POST_SUBMIT_WAIT_MS = 400;

/**
 * Number of Tab keys needed to advance from the To field to the Subject
 * field, by platform / default app behavior.
 *
 *   - **macOS** (Mail.app default): Cc/Bcc are collapsed by default in the
 *     compose window. Tab order: To → Subject → Body. ONE Tab after To.
 *     (If the user has "Always show Cc/Bcc" enabled in Mail prefs the count
 *     is wrong — there's no clean way to detect that from here. Users in
 *     that minority case should toggle the pref or use the mailto: route.)
 *
 *   - **Windows** (Outlook desktop default): Cc/Bcc visible inline. Tab
 *     order: To → Cc → Bcc → Subject → Body. THREE Tabs after To.
 *     Note: Windows usually hits this playbook via Strategy 1 (mailto:)
 *     in pipeline.ts which pre-fills everything via the URI; Strategy 2
 *     (this in-app path) is a fallback when mailto fails.
 *
 *   - **Linux/Wayland** (Thunderbird default): Tab order matches macOS.
 *     ONE Tab after To.
 *
 * The web variants (Gmail web, Outlook web) are a wildcard — different
 * apps in different browsers behave differently. The verifier (re-enabled
 * for playbooks in v0.9.1) catches false-success regardless.
 */
function tabsAfterRecipient(): number {
  return process.platform === 'win32' ? 3 : 1;
}

export async function composeSend(args: PlaybookArgs): Promise<PlaybookResult> {
  const { adapter, input } = args;
  const send    = args.send ?? true;
  const to      = input.to ?? input.recipient ?? '';
  const subject = input.subject ?? '';
  const body    = input.body ?? input.text ?? '';
  const steps: PlaybookResult['steps'] = [];
  const tabsToSubject = tabsAfterRecipient();

  // 1) New compose window. mod+n is the cross-app convention.
  await adapter.keyPress('mod+n');
  steps.push({ type: 'key', key: 'mod+n', description: 'new compose window' });
  await sleep(COMPOSE_MOUNT_WAIT_MS);
  steps.push({ type: 'wait', description: `wait ${COMPOSE_MOUNT_WAIT_MS}ms for compose to mount` });

  // 2) Recipient — first field auto-focuses on every mail compose UI.
  if (to) {
    await adapter.typeText(to);
    steps.push({ type: 'type', description: `typed recipient: ${to}` });
    // Advance from To to Subject. Tab count is platform-aware (see TAB_BUDGET).
    for (let i = 0; i < tabsToSubject; i++) {
      await adapter.keyPress('Tab');
      steps.push({ type: 'key', key: 'Tab', description: `advance to subject (${i + 1}/${tabsToSubject})` });
    }
  }

  // 3) Subject — type if we have one. EITHER WAY advance ONE Tab to body so
  //    if there's no subject the body still lands in the right field. This
  //    decoupling is the v0.9.1 fix for the "subject empty → body lands in
  //    subject field" failure mode.
  if (subject) {
    await adapter.typeText(subject);
    steps.push({ type: 'type', description: `typed subject: ${subject}` });
  }
  await adapter.keyPress('Tab');
  steps.push({
    type: 'key',
    key: 'Tab',
    description: subject ? 'advance from subject to body' : 'advance past empty subject to body',
  });

  // 4) Body
  if (body) {
    await adapter.typeText(body);
    steps.push({ type: 'type', description: `typed body (${body.length} chars)` });
  }

  // 5) Submit. mod+Return is the cross-app send shortcut on every modern
  // mail client. We attempt it once and let the verifier decide success —
  // the playbook itself cannot tell from inside whether a "no subject"
  // confirmation dialog intercepted, whether the message stuck in Outbox,
  // or whether anything was actually delivered. That judgement now belongs
  // to the pipeline's ground-truth verifier (v0.9.1 unbypass).
  //
  // Skip the submit entirely for draft-only tasks (send=false): the user
  // asked to compose, not send, so leave the filled form for review.
  if (send) {
    await adapter.keyPress('mod+Return');
    steps.push({ type: 'key', key: 'mod+Return', description: 'submit (mod+Return)' });
    await sleep(POST_SUBMIT_WAIT_MS);
  } else {
    steps.push({ type: 'wait', description: 'draft-only: left compose filled, did NOT submit' });
  }

  return {
    // success=true here just means "we executed the choreography without
    // throwing." The pipeline's verifier is the ground-truth gate that
    // decides whether the chain advances. See pipeline.ts.
    success: true,
    text: `compose-send: to=${to || '(none)'} subject=${subject || '(none)'} body=${body.length}ch tabs-after-to=${tabsToSubject} ${send ? 'sent' : 'draft-only'}`,
    steps,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
