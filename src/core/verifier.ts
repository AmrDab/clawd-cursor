/**
 * GroundTruthVerifier — independent verification using actual screen state.
 *
 * Signals (combined with weighted voting):
 *   1. Pixel diff:       did the screen change at all?
 *   2. Window state:     did windows open/close/focus change?
 *   3. Focused element:  did keyboard focus move?
 *   4. OCR delta:        did visible text change?
 *   5. Task assertions:  did task-specific conditions hold?
 *   6. Anti-signals:     known failure patterns absent?
 *
 * The verdict is a weighted sum, NOT an LLM self-report.
 */

import sharp from 'sharp';
import type { PlatformAdapter } from '../platform/types';
import type {
  Verifier,
  VerifyOptions,
  VerifyResult,
  VerifySignal,
  StateSnapshot,
  TaskType,
  ReflectionFeedback,
  Cause,
} from './verifier-types';

export class GroundTruthVerifier implements Verifier {
  constructor(private platform: PlatformAdapter) {}

  async captureState(ocrText: string): Promise<StateSnapshot> {
    const [screenshot, windows, activeWindow, focusedElement, clipboard] = await Promise.all([
      this.platform.screenshot({ maxWidth: 1280 }),
      this.platform.listWindows(),
      this.platform.getActiveWindow(),
      this.platform.getFocusedElement().catch(() => null),
      this.platform.readClipboard().catch(() => ''),
    ]);
    return {
      timestamp: Date.now(),
      screenshot,
      windows,
      activeWindow,
      focusedElement,
      ocrText,
      clipboard,
    };
  }

  async verify(opts: VerifyOptions): Promise<VerifyResult> {
    const signals: VerifySignal[] = [];

    // Run all signals in parallel.
    const [pixel, windowSig, focus, ocrDelta, taskSig, antiSig] = await Promise.all([
      this.signalPixelDiff(opts),
      this.signalWindowChange(opts),
      this.signalFocusChange(opts),
      this.signalOcrDelta(opts),
      this.signalTaskAssertions(opts),
      this.signalAntiPatterns(opts),
    ]);

    signals.push(pixel, windowSig, focus, ocrDelta, taskSig, antiSig);

    // Weighted vote.
    const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
    const passWeight = signals.filter(s => s.value).reduce((s, x) => s + x.weight, 0);
    const confidence = totalWeight > 0 ? passWeight / totalWeight : 0;

    // Hard rules:
    //  - If anti-pattern fired, fail regardless of other signals.
    //  - For tasks that mutate the screen, at least ONE structural-change
    //    signal must have fired (drawing requires pixel change, typing
    //    requires pixel or focus, etc.). Without this gate, a "done" call
    //    that did nothing would coast on a confidence vote.
    //  - For IDEMPOTENT tasks (open/create/new/setup/launch) the goal
    //    state may already match: opening an already-open app, creating
    //    a new canvas in just-launched Paint, opening a tab in a fresh
    //    browser. Pixel/window/focus all stay the same and that's CORRECT.
    //    For these, we trust task_assertions + the agent's textual evidence
    //    and skip the structural-change requirement.
    const inferredTaskType = opts.taskType ?? this.inferTaskType(opts.task);
    const isIdempotentTask = isLikelyIdempotent(opts.task);
    let pass = confidence >= 0.6;
    if (!antiSig.value) pass = false;
    if (inferredTaskType === 'draw') {
      // Draw: require ANY pixel change (per the lower threshold in
      // signalPixelDiff). Window/focus reasonably stay still.
      if (!pixel.value) pass = false;
    } else if (isIdempotentTask) {
      // Open/create/new/setup verbs: zero structural change is legitimate
      // when the goal state already holds. task_assertions + anti-pattern
      // carry the verdict; pixel/window/focus are advisory only.
      // (No additional hard gate.)
    } else if (inferredTaskType === 'type_text' || inferredTaskType === 'compose_message') {
      // Text-content tasks: typing/pasting into an already-focused field changes
      // little structurally (no window/focus change, sub-threshold pixel diff),
      // so the structural-change gate would false-reject a successful paste (the
      // live "paste the copied sentence" bug). POSITIVE text evidence (the field
      // gained the content) is authoritative — accept it even with no structural
      // change. But a FAILED text assertion is NOT decisive (the literal
      // extractor is heuristic and can misfire on "type a sentence about X"), so
      // fall back to the normal structural gate rather than hard-failing.
      if (taskSig.value) {
        pass = antiSig.value;
      } else if (!pixel.value && !windowSig.value && !focus.value) {
        pass = false;
      }
    } else {
      if (!pixel.value && !windowSig.value && !focus.value) pass = false;
    }

    const reason = pass
      ? `Verified: ${signals.filter(s => s.value).map(s => s.name).join(', ')}`
      : `Failed: ${signals.filter(s => !s.value).map(s => `${s.name} (${s.detail})`).join('; ')}`;

    return { pass, confidence, reason, signals };
  }

  /**
   * Run all verification signals and return structured ReflectionFeedback.
   *
   * Translates raw VerifySignal failures into typed Cause[] so the pipeline
   * can make an informed escalation decision rather than just climbing the
   * ladder blindly. `suggestedStrategy` is derived from the dominant cause:
   *
   *   webview_blind      → 'vision'         (skip blind/hybrid; pixels moved but a11y silent)
   *   modal_intercept    → 'wait_and_retry' (dismiss the dialog then retry the same rung)
   *   wrong_window_focus → 'change_target'  (refocus then retry blind)
   *   everything else    → undefined        (let the default ladder pick)
   */
  async verifyWithFeedback(opts: VerifyOptions): Promise<ReflectionFeedback> {
    const result = await this.verify(opts);
    const causes = await this.buildCauses(opts, result.signals);

    const hint = result.pass
      ? 'Verification passed.'
      : this.buildHint(causes, result);

    const suggestedStrategy = result.pass
      ? undefined
      : this.pickStrategy(causes);

    return {
      pass: result.pass,
      confidence: result.confidence,
      causes,
      hint,
      suggestedStrategy,
    };
  }

  // ─── Reflector helpers ─────────────────────────────────────────────

  /**
   * Translate raw VerifySignal failures into structured Cause[].
   * Each Cause kind maps to at most one entry — there's no double-counting.
   */
  private async buildCauses(opts: VerifyOptions, signals: VerifySignal[]): Promise<Cause[]> {
    const causes: Cause[] = [];
    const signalMap = new Map(signals.map(s => [s.name, s]));

    // 1. no_pixel_change — pixel_diff signal fired false.
    const pixelSig = signalMap.get('pixel_diff');
    if (pixelSig && !pixelSig.value) {
      causes.push({ kind: 'no_pixel_change' });
    }

    // 2. wrong_window_focused — the active window changed to a different
    //    title between before and after. This is a cause regardless of
    //    whether window_change "passed" (a focus change IS a window change,
    //    and we're saying it changed to the WRONG target). We only emit
    //    this when the verdict is failing overall — if the task passed,
    //    a window focus change is expected and correct.
    //
    //    Note: we check the raw snapshot fields rather than the signal
    //    value because the signal fires `true` (change detected = pass)
    //    even when the new focus is wrong for the task goal.
    const winSig = signalMap.get('window_change');
    void winSig; // referenced below for other guards; suppress unused-var lint
    const beforeTitle = opts.before.activeWindow?.title ?? '';
    const afterTitle = opts.after.activeWindow?.title ?? '';
    // Only emit when the window actually changed to a different app and
    // the verification is failing (a passing verdict means the focus move
    // was the intended outcome).
    if (afterTitle && beforeTitle !== afterTitle) {
      causes.push({
        kind: 'wrong_window_focused',
        expected: beforeTitle || undefined,
        actual: afterTitle,
      });
    }

    // 3. modal_intercept — OCR text contains dialog-like phrases that weren't
    //    in the before snapshot. We look for common dialog markers that suggest
    //    an unexpected modal interrupted the action.
    const MODAL_PATTERNS = [
      /\b(?:ok|cancel|yes|no|retry|ignore|abort)\b.*\b(?:ok|cancel|yes|no|retry|ignore|abort)\b/i,
      /\bdialog\b/i,
      /\bconfirm\b/i,
      /\bare you sure\b/i,
      /\bwarning[:\s]/i,
      /\bdo you want to\b/i,
      /\bwould you like to\b/i,
    ];
    const afterOcr = opts.after.ocrText;
    const beforeOcr = opts.before.ocrText;
    if (afterOcr && afterOcr !== beforeOcr) {
      for (const pattern of MODAL_PATTERNS) {
        if (pattern.test(afterOcr) && !pattern.test(beforeOcr)) {
          // Extract the relevant excerpt (first 120 chars for brevity).
          const excerpt = afterOcr.slice(0, 120).trim();
          causes.push({ kind: 'modal_intercept', text: excerpt });
          break;
        }
      }
    }

    // 4. a11y_target_missing — task_assertions fired false, and the task
    //    mentions a specific element we tried to target. We extract the target
    //    from the task string as a best-effort approximation.
    const taskSig = signalMap.get('task_assertions');
    if (taskSig && !taskSig.value) {
      const target = this.extractTargetFromTask(opts.task);
      if (target) {
        causes.push({ kind: 'a11y_target_missing', target });
      }
    }

    // 5. webview_blind — pixels changed (pixel_diff passed) but no a11y
    //    signal changed (window_change + focus_change + task_assertions all
    //    false). This is the signature of a WebView2/Electron app where the
    //    DOM updated visually but the accessibility tree is silent.
    const focusSig = signalMap.get('focus_change');
    const pixelPassed = pixelSig?.value === true;
    const a11ySilent = (!winSig || !winSig.value)
                    && (!focusSig || !focusSig.value)
                    && (!taskSig || !taskSig.value);
    if (pixelPassed && a11ySilent) {
      causes.push({ kind: 'webview_blind' });
    }

    // 6. partial_text_match — ocr_delta fired false but OCR did capture
    //    text. This means we found some text change, but the task-expected
    //    keywords weren't fully present (partial keyword match detected by
    //    the task assertions check against the OCR output).
    const ocrSig = signalMap.get('ocr_delta');
    if (ocrSig && ocrSig.value && taskSig && !taskSig.value) {
      // Extract what we expected vs what was observed.
      const keywords = this.extractTaskKeywords(opts.task);
      const observed = afterOcr.slice(0, 80).trim();
      if (keywords.length > 0 && observed) {
        causes.push({
          kind: 'partial_text_match',
          expected: keywords.join(', '),
          observed,
        });
      }
    }

    return causes;
  }

  /**
   * Compute the dominant cause and return the suggested escalation strategy.
   * Called only on failure (pass=false).
   */
  private pickStrategy(causes: Cause[]): ReflectionFeedback['suggestedStrategy'] {
    for (const cause of causes) {
      if (cause.kind === 'webview_blind') return 'vision';
      if (cause.kind === 'modal_intercept') return 'wait_and_retry';
      if (cause.kind === 'wrong_window_focused') return 'change_target';
    }
    // no_pixel_change, a11y_target_missing, partial_text_match → default ladder
    return undefined;
  }

  /** Build a one-line human-readable summary of the primary failure cause. */
  private buildHint(causes: Cause[], result: import('./verifier-types').VerifyResult): string {
    if (causes.length === 0) {
      return `Verification failed (confidence ${(result.confidence * 100).toFixed(0)}%): ${result.reason}`;
    }
    const primary = causes[0];
    switch (primary.kind) {
      case 'no_pixel_change':
        return 'No significant pixel change — the action may not have taken effect (or had no visible result).';
      case 'wrong_window_focused':
        return `Wrong window in focus: expected "${primary.expected ?? 'original'}", got "${primary.actual}".`;
      case 'modal_intercept':
        return `Unexpected dialog intercepted the action: "${primary.text.slice(0, 60)}".`;
      case 'a11y_target_missing':
        return `Accessibility target not found: "${primary.target}".`;
      case 'webview_blind':
        return 'Pixels changed but accessibility tree is silent — likely a WebView2/Electron app.';
      case 'partial_text_match':
        return `Expected "${primary.expected}" on screen but found only partial match.`;
    }
  }

  /**
   * Best-effort extraction of the element or target the task is referring to.
   * Used to populate `a11y_target_missing.target`.
   */
  private extractTargetFromTask(task: string): string | null {
    // Patterns like: "click <target>", "press <target>", "find <target>",
    // "the <target> button", quoted strings.
    const quoted = task.match(/["'](.+?)["']/);
    if (quoted) return quoted[1];
    const afterVerb = task.match(
      /(?:click|press|find|select|invoke|focus|type\s+(?:in|into)?)\s+(?:the\s+)?([a-z0-9 _-]{2,30}?)(?:\s+(?:button|field|link|checkbox|element|menu|item)|$)/i,
    );
    if (afterVerb) return afterVerb[1].trim();
    return null;
  }

  // ─── SIGNALS ──────────────────────────────────────────────────────

  /**
   * Did the pixels change at all?
   *
   * Threshold is per-task-type: spatial / drawing tasks change MUCH less
   * pixels than window opens. A stick figure on a 1280×720 canvas might
   * paint ~300 pixels (~0.03%); the default 0.5% threshold (tuned for
   * window opens / dialog pops) rejects that as noise.
   *
   * For `'draw'` we use 0.05% (10× lower) — caught by the actual
   * Paint-stick-figure run that produced 0.08% pixels-changed and was
   * wrongly rejected by the universal threshold.
   */
  private async signalPixelDiff(opts: VerifyOptions): Promise<VerifySignal> {
    try {
      const diff = await this.computePixelDiff(opts.before.screenshot.buffer, opts.after.screenshot.buffer);
      const taskType = opts.taskType ?? this.inferTaskType(opts.task);
      const threshold = taskType === 'draw' ? 0.0005 : 0.005; // 0.05% for drawings, 0.5% otherwise
      const value = diff > threshold;
      return {
        name: 'pixel_diff',
        weight: 0.15,
        value,
        detail: `${(diff * 100).toFixed(2)}% pixels changed (threshold ${(threshold * 100).toFixed(2)}%)`,
      };
    } catch (err: any) {
      return { name: 'pixel_diff', weight: 0, value: false, detail: `error: ${err.message}` };
    }
  }

  /** Did the window state change (open/close/focus)? */
  private async signalWindowChange(opts: VerifyOptions): Promise<VerifySignal> {
    const before = opts.before;
    const after = opts.after;

    const beforeKeys = new Set(before.windows.map(w => `${w.processId}:${w.title}`));
    const afterKeys = new Set(after.windows.map(w => `${w.processId}:${w.title}`));

    const opened = [...afterKeys].filter(k => !beforeKeys.has(k));
    const closed = [...beforeKeys].filter(k => !afterKeys.has(k));
    const focusChanged = before.activeWindow?.title !== after.activeWindow?.title
                       || before.activeWindow?.processId !== after.activeWindow?.processId;

    const changed = opened.length > 0 || closed.length > 0 || focusChanged;
    const detail = changed
      ? `+${opened.length} window(s), -${closed.length} window(s)${focusChanged ? ', focus moved' : ''}`
      : 'no window changes';

    return { name: 'window_change', weight: 0.2, value: changed, detail };
  }

  /** Did keyboard focus move to a different element? */
  private async signalFocusChange(opts: VerifyOptions): Promise<VerifySignal> {
    const beforeFocus = opts.before.focusedElement;
    const afterFocus = opts.after.focusedElement;

    if (!beforeFocus && !afterFocus) {
      return { name: 'focus_change', weight: 0.1, value: false, detail: 'no focus info' };
    }

    const changed = beforeFocus?.name !== afterFocus?.name
                  || beforeFocus?.controlType !== afterFocus?.controlType;

    return {
      name: 'focus_change',
      weight: 0.1,
      value: changed,
      detail: changed ? `focus moved to "${afterFocus?.name ?? 'unknown'}"` : 'focus unchanged',
    };
  }

  /** Did visible text on screen change? */
  private async signalOcrDelta(opts: VerifyOptions): Promise<VerifySignal> {
    const beforeText = opts.before.ocrText.toLowerCase();
    const afterText = opts.after.ocrText.toLowerCase();

    if (!beforeText || !afterText) {
      return { name: 'ocr_delta', weight: 0, value: false, detail: 'no OCR data' };
    }

    // Simple Jaccard distance on words.
    const beforeWords = new Set(beforeText.split(/\s+/).filter(w => w.length > 2));
    const afterWords = new Set(afterText.split(/\s+/).filter(w => w.length > 2));
    const intersection = new Set([...beforeWords].filter(w => afterWords.has(w)));
    const union = new Set([...beforeWords, ...afterWords]);
    const similarity = union.size > 0 ? intersection.size / union.size : 1;
    const delta = 1 - similarity;

    const value = delta > 0.05; // >5% word change
    return {
      name: 'ocr_delta',
      weight: 0.15,
      value,
      detail: `${(delta * 100).toFixed(1)}% text changed`,
    };
  }

  /** Task-type-specific assertions. */
  private async signalTaskAssertions(opts: VerifyOptions): Promise<VerifySignal> {
    const taskType = opts.taskType ?? this.inferTaskType(opts.task);
    const after = opts.after;

    const checks: { name: string; pass: boolean }[] = [];

    switch (taskType) {
      case 'send_email': {
        // Real user-reported false-positive (Kimi-driven, v0.9.0): a
        // confirmation popup grabbed foreground after a click, so the
        // active-window title became the popup's title (which doesn't
        // match composeKeywords) and `compose_closed` falsely passed.
        // The compose window was still there underneath, unsent.
        //
        // Fix: check the FULL WINDOW LIST. The compose window must be
        // absent from ALL visible windows of the mail-app process —
        // not just absent from the foreground. A popup can't hide the
        // compose window from `windows`; only a real close can.
        const composeKeywords = /(new message|compose|untitled|draft|reply)/i;
        const composeStillOpen = (after.windows ?? []).some(w =>
          !w.isMinimized && composeKeywords.test(w.title ?? '')
        );
        checks.push({ name: 'compose_closed', pass: !composeStillOpen });

        // "Back in inbox/sent" check stays — but it accepts BOTH a
        // modal-intercept case (active window is a popup like "Message
        // sent" / "Saving to drafts") AND the post-send normal case
        // (active window is the mailbox view). The popup form is
        // verified by the second OCR check below if a recipient was
        // mentioned; without that we can't tell a "sent" popup from a
        // "draft saved" popup.
        const inboxKeywords = /(inbox|sent|mailbox|all mail|messages|sent items|conversation history)/i;
        const successKeywords = /(message sent|email sent|sent successfully|your message has been sent)/i;
        const inMailContext =
          inboxKeywords.test(after.activeWindow?.title ?? '') ||
          inboxKeywords.test(after.ocrText) ||
          successKeywords.test(after.ocrText);
        checks.push({ name: 'in_inbox_or_sent', pass: inMailContext });

        // The recipient address must be visible somewhere if the task mentioned one.
        const emailMatch = opts.task.match(/[\w.-]+@[\w.-]+\.\w+/);
        if (emailMatch) {
          const recipientVisible = after.ocrText.toLowerCase().includes(emailMatch[0].toLowerCase());
          checks.push({ name: 'recipient_visible', pass: recipientVisible });
        }

        // Anti-signal: if a draft-save indicator is visible, the user
        // didn't send — they closed/saved. Verifier should REJECT
        // unless the success keyword is also present.
        const draftSaved = /(draft saved|saved to drafts|outbox|queued to send)/i.test(after.ocrText);
        const successNotice = /(message sent|email sent|sent successfully)/i.test(after.ocrText);
        if (draftSaved && !successNotice) {
          checks.push({ name: 'not_just_saved_as_draft', pass: false });
        }
        break;
      }

      case 'compose_message': {
        // For a composed (but not sent) message, content must appear in screen.
        const taskBody = this.extractQuotedContent(opts.task);
        if (taskBody) {
          const visible = after.ocrText.toLowerCase().includes(taskBody.toLowerCase().slice(0, 30));
          checks.push({ name: 'body_visible', pass: visible });
        }
        break;
      }

      case 'navigate_url': {
        // URL or domain should appear in active window title or OCR.
        const urlMatch = opts.task.match(/(?:https?:\/\/)?([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)/i);
        if (urlMatch) {
          const domain = urlMatch[1];
          const inTitle = after.activeWindow?.title.toLowerCase().includes(domain.toLowerCase());
          const inOcr = after.ocrText.toLowerCase().includes(domain.toLowerCase());
          checks.push({ name: 'url_visible', pass: !!(inTitle || inOcr) });
        }
        break;
      }

      case 'open_app': {
        // The app's window must exist.
        const appMatch = opts.task.match(/open\s+(?:the\s+)?([a-z0-9 ]+?)(?:\s+app)?$/i);
        if (appMatch) {
          const appName = appMatch[1].trim().toLowerCase();
          const found = after.windows.some(w =>
            w.processName.toLowerCase().includes(appName) ||
            w.title.toLowerCase().includes(appName),
          );
          checks.push({ name: 'app_window_present', pass: found });
        }
        break;
      }

      case 'type_text': {
        const text = this.extractQuotedContent(opts.task);
        if (text) {
          // Either the text appears on screen, or it's in the focused element value, or in clipboard.
          const visible = after.ocrText.toLowerCase().includes(text.toLowerCase().slice(0, 25))
                       || (after.focusedElement?.value?.toLowerCase().includes(text.toLowerCase().slice(0, 25)) ?? false);
          checks.push({ name: 'text_appeared', pass: visible });
        } else {
          // No literal in the task (a PASTE, or "type a sentence about X"). The
          // proof is that the focused field GAINED text, or the clipboard's
          // content is now visible in the field/screen. Pasting changes little
          // structurally (no window/focus change, tiny pixel diff), so this
          // value-delta — not the structural vote — is the real signal.
          const beforeVal = opts.before.focusedElement?.value ?? '';
          const afterVal = after.focusedElement?.value ?? '';
          const grew = afterVal.length > beforeVal.length;
          const clip = (after.clipboard ?? '').trim();
          const pastedVisible = clip.length > 0 && (
            afterVal.toLowerCase().includes(clip.toLowerCase().slice(0, 30)) ||
            after.ocrText.toLowerCase().includes(clip.toLowerCase().slice(0, 30))
          );
          // Only push a PASS when we have positive evidence; absence of evidence
          // leaves the assertion unrun (weight 0) rather than a false reject.
          if (grew || pastedVisible) checks.push({ name: 'text_entered', pass: true });
        }
        break;
      }

      case 'search': {
        // Search results must appear: presence of 'results', '1-10 of', 'showing', etc.
        const resultIndicators = /(\d+\s+results?|showing\s+\d+|about\s+[\d,]+|search results)/i;
        checks.push({ name: 'results_shown', pass: resultIndicators.test(after.ocrText) });
        break;
      }

      case 'copy': {
        // A real copy leaves a NEW, non-empty clipboard value.
        const beforeClip = opts.before.clipboard ?? '';
        const afterClip = after.clipboard ?? '';
        const changed = afterClip.length > 0 && afterClip !== beforeClip;
        checks.push({ name: 'clipboard_populated', pass: changed });
        // Provenance: the copied text should be visible in the source view
        // (we copied it FROM there). Cheap substring check against OCR.
        if (changed && after.ocrText) {
          const probe = afterClip.toLowerCase().slice(0, 40);
          checks.push({ name: 'clipboard_in_source', pass: after.ocrText.toLowerCase().includes(probe) });
        }
        // The decisive fabrication guard is the anti-pattern hard-fail
        // (signalAntiPatterns) — using write_clipboard for a copy task is
        // authoring, not copying — so it isn't repeated here.
        break;
      }

      case 'draw': {
        // Drawing tasks have no text-based proof. The cheapest signal is
        // "did meaningful pixels actually change?" — same as the pixel-diff
        // signal, but at the same lower 0.05% threshold (consistent with
        // signalPixelDiff's per-task-type threshold above). Without this,
        // 'draw' tasks would have ZERO task assertions and degrade to
        // weight=0 (no positive contribution to verdict).
        try {
          const diff = await this.computePixelDiff(
            opts.before.screenshot.buffer,
            opts.after.screenshot.buffer,
          );
          // Same threshold as signalPixelDiff for 'draw' — they reinforce
          // each other rather than double-counting (each has its own weight).
          checks.push({ name: 'canvas_changed', pass: diff > 0.0005 });
        } catch {
          // If the pixel diff itself errored, leave the task assertion
          // unchecked rather than auto-failing — the pixel signal will
          // also have zeroed weight, so the verdict relies on other signals.
        }
        break;
      }

      case 'generic':
      default: {
        // Generic: at least one keyword from the task appears on screen.
        // BUT — when no OCR data is available (the unified-pipeline path
        // currently passes empty `ocrText` for latency reasons), the
        // keyword check is structurally guaranteed to fail. That isn't a
        // signal; it's missing data. Return weight=0 so it doesn't drag
        // the weighted verdict down. Same idiom signalOcrDelta uses.
        if (!after.ocrText) {
          return {
            name: 'task_assertions',
            weight: 0,
            value: false,
            detail: '[generic] skipped — no OCR data available',
          };
        }
        const keywords = this.extractTaskKeywords(opts.task);
        const matches = keywords.filter(k => after.ocrText.toLowerCase().includes(k));
        const ratio = keywords.length > 0 ? matches.length / keywords.length : 1;
        checks.push({ name: 'keywords_visible', pass: ratio >= 0.5 });
        break;
      }
    }

    if (checks.length === 0) {
      return { name: 'task_assertions', weight: 0, value: false, detail: 'no assertions for task type' };
    }

    const passed = checks.filter(c => c.pass).length;
    const allPass = passed === checks.length;
    const detail = checks.map(c => `${c.name}=${c.pass ? '✓' : '✗'}`).join(' ');

    return {
      name: 'task_assertions',
      weight: 0.3, // task assertions are the biggest signal
      value: allPass,
      detail: `[${taskType}] ${detail} (${passed}/${checks.length})`,
    };
  }

  /** Anti-patterns: explicit signs of failure. Returns TRUE if no failure detected. */
  private async signalAntiPatterns(opts: VerifyOptions): Promise<VerifySignal> {
    const after = opts.after.ocrText.toLowerCase();
    const failures: string[] = [];

    // Common error indicators on screen.
    const errorPatterns: { pattern: RegExp; label: string }[] = [
      { pattern: /draft\s+saved/i, label: 'draft saved (not sent)' },
      { pattern: /(?:unable|failed|cannot)\s+to\s+send/i, label: 'send failed' },
      { pattern: /cannot\s+send\s+(?:the\s+)?message/i, label: 'cannot send message' },
      { pattern: /delivery\s+failed|message\s+not\s+(?:sent|delivered)/i, label: 'delivery failed' },
      { pattern: /server\s+(?:rejected|refused|error)/i, label: 'server error' },
      { pattern: /\berror\s*(?:[:!]|occurred|encountered)/i, label: 'error message' },
      { pattern: /try\s+again|retry/i, label: 'retry prompt' },
      { pattern: /permission\s+denied|access\s+denied/i, label: 'permission denied' },
      { pattern: /not\s+responding/i, label: 'app not responding' },
      { pattern: /invalid\s+(?:email|address|recipient)/i, label: 'invalid recipient' },
      { pattern: /authentication\s+(?:failed|required)/i, label: 'auth failed' },
    ];

    for (const { pattern, label } of errorPatterns) {
      if (pattern.test(after)) failures.push(label);
    }

    // Fabrication guard for copy tasks: a genuine copy pulls text from the
    // source with a ctrl+c; using write_clipboard to AUTHOR the clipboard is
    // faking the result. This is a hard fail (anti_patterns=false), which is
    // what blocked the live "We owe you an explanation." false positive — the
    // agent gave up selecting and wrote the sentence to the clipboard itself.
    const taskType = opts.taskType ?? this.inferTaskType(opts.task);
    if (taskType === 'copy' && (opts.toolTrace ?? []).includes('write_clipboard')) {
      failures.push('clipboard fabricated via write_clipboard (not copied from source)');
    }

    const value = failures.length === 0;
    return {
      name: 'anti_patterns',
      weight: 0.1, // small weight, but note: also a HARD failure if value=false
      value,
      detail: failures.length > 0 ? `detected: ${failures.join(', ')}` : 'no failure indicators',
    };
  }

  // ─── HELPERS ──────────────────────────────────────────────────────

  /** Compute fraction of pixels that differ between two PNG buffers. */
  private async computePixelDiff(a: Buffer, b: Buffer): Promise<number> {
    // Both should already be at the same resolution (1280px-wide). Decode and compare.
    const [aRaw, bRaw] = await Promise.all([
      sharp(a).raw().toBuffer({ resolveWithObject: true }),
      sharp(b).raw().toBuffer({ resolveWithObject: true }),
    ]);

    if (aRaw.info.width !== bRaw.info.width || aRaw.info.height !== bRaw.info.height) {
      // Different sizes — definitely changed.
      return 1.0;
    }

    const len = Math.min(aRaw.data.length, bRaw.data.length);
    const channels = aRaw.info.channels;
    const totalPixels = len / channels;
    let diffPixels = 0;
    const threshold = 30; // per-channel difference threshold

    for (let i = 0; i < len; i += channels) {
      const dr = Math.abs(aRaw.data[i] - bRaw.data[i]);
      const dg = Math.abs(aRaw.data[i + 1] - bRaw.data[i + 1]);
      const db = Math.abs(aRaw.data[i + 2] - bRaw.data[i + 2]);
      if (dr + dg + db > threshold * 3) diffPixels++;
    }

    return totalPixels > 0 ? diffPixels / totalPixels : 0;
  }

  /**
   * Heuristic task type inference from the task string. The pipeline can
   * also pass `taskType` explicitly via `VerifyOptions.taskType` (set
   * from the preprocessor's `capability` hint), in which case this is
   * never called. This is the fallback for direct verifier callers.
   *
   * Order matters — first match wins. `open_app` precedes `draw` so
   * "open paint" classifies as `open_app` (the verb "open" wins over
   * the noun "paint" — Paint the app vs. paint the action). For tasks
   * like "open paint and draw …" the pipeline splits subtasks before
   * verification, so "open paint" and "draw …" are checked separately.
   */
  private inferTaskType(task: string): TaskType {
    const t = task.toLowerCase();
    // `open_app` must come before `draw` so "open paint" classifies as
    // open_app — Paint the application, not paint the verb.
    if (/(?:^|\s)(?:open|launch|start)\s+(?:the\s+)?[a-z0-9 ]+?(?:\s+(?:app|application))?$/i.test(t)) return 'open_app';
    if (/send.*email|email.*to|reply.*to|forward.*email/.test(t)) return 'send_email';
    if (/compose|draft.*message|write.*message/.test(t)) return 'compose_message';
    // Drawing / spatial — `draw|sketch|annotate|illustrate|trace` are
    // unambiguous verbs. `paint` is dropped from the regex because it
    // doubles as the app name ("open paint") — the open_app case above
    // catches that, and a real "paint a thing" task still falls under
    // `draw` via the other verbs or via the pipeline's `capability`
    // hint mapped from `'spatial'`.
    if (/\b(draw|sketch|annotate|illustrate|trace|color\s+in|drag\s+\w+\s+(?:to|onto))\b/.test(t)) return 'draw';
    if (/navigate|go to.*\.|visit.*\.|open\s+(?:https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,})/.test(t)) return 'navigate_url';
    // Copy-to-clipboard, but NOT a paste task (paste is type_text-ish). A copy
    // subtask is "select and copy a sentence …"; "paste the copied text" is not.
    if (/\bcopy\b/.test(t) && !/\bpaste\b/.test(t)) return 'copy';
    if (/type|paste|enter.*text|write.*"|input/.test(t)) return 'type_text';
    if (/create.*file|save.*as|new\s+document/.test(t)) return 'create_file';
    if (/search|find|look up|google/.test(t)) return 'search';
    return 'generic';
  }

  /** Extract quoted text from a task (for type-text or compose tasks). */
  // (helper functions live below the class — see file end)

  private extractQuotedContent(task: string): string | null {
    const quoted = task.match(/["'](.+?)["']/);
    if (quoted) return quoted[1];
    // Fallback: text after "type" or "write"
    const after = task.match(/(?:type|write|enter)[: ]+(.+?)(?:$|\s+(?:then|and|to)\b)/i);
    return after?.[1].trim() ?? null;
  }

  /** Extract meaningful keywords from a task (skipping common verbs). */
  private extractTaskKeywords(task: string): string[] {
    const NOISE = new Set([
      'open', 'click', 'type', 'then', 'with', 'select', 'press', 'into',
      'from', 'that', 'this', 'should', 'make', 'please', 'text', 'field',
      'enter', 'write', 'app', 'application', 'and', 'the', 'a', 'an',
    ]);
    return task.toLowerCase()
      .replace(/[^\w\s@.-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !NOISE.has(w) && !/^\d+$/.test(w));
  }
}

/**
 * Heuristic: does this subtask describe an action whose goal state may
 * already be satisfied (zero structural change is legitimate)?
 *
 * Used by the verifier to relax its "at least one structural change must
 * have fired" hard rule. Without this, idempotent steps like
 *   "create a new canvas in Paint"   (Paint already opened with a blank canvas)
 *   "open a new tab in Chrome"       (Chrome already opened with a new tab)
 *   "create a new document"          (Word already opened blank)
 * get marked as failed because pixel/window/focus didn't change — even
 * though the goal IS met. The decomposer prompt now drops most of these,
 * but this guard catches the cases that slip through.
 *
 * Intentionally a flat regex, not a full grammar — false positives just
 * mean we trust the agent's done() claim a bit more for that subtask,
 * which is the right default anyway. (We still require anti_pattern=true
 * and confidence ≥ 0.6, so the agent can't lie its way to success.)
 */
function isLikelyIdempotent(task: string): boolean {
  const t = task.toLowerCase().trim();
  // Patterns: "create/open/start/launch a new <thing>" or "open <app>" or
  // "make sure <app> is open/running/ready"
  return (
    /^(?:create|open|start|launch|make|new)\s+(?:a\s+)?(?:new\s+)?(?:blank\s+)?(?:canvas|document|sheet|tab|file|window|workbook|spreadsheet|note|notebook|presentation|slide)\b/.test(t)
    || /\bnew\s+(?:canvas|document|sheet|tab|file|window|workbook|note|notebook|presentation)\b/.test(t)
    || /^(?:open|launch|start)\s+\w+$/.test(t)                            // "open paint", "launch excel"
    || /\b(?:already|make sure).+(?:open|running|ready|loaded)\b/.test(t) // "make sure paint is open"
    || /\bwait for\b.+\b(?:load|ready|open)\b/.test(t)                     // residual "wait for X to load"
  );
}
