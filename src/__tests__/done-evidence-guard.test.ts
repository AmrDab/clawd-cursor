/**
 * Tests for the `done` tool's evidence guard.
 *
 * The original symptom: agent in blind mode never observed screen state,
 * called `done(evidence: "The email should have been sent...")` — note
 * "should", a hedge — and the pipeline accepted it. The user got a
 * "success" response while no email had actually been sent. These tests
 * lock down the evidence-validation rules so future tweaks don't regress
 * the obvious cases.
 *
 * The guard is intentionally narrow: it rejects only the unambiguous "I'm
 * guessing" phrasings. Concrete-observation language stays allowed even if
 * it includes filler words.
 */

import { describe, it, expect } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';

function getDoneTool() {
  const tools = buildUnifiedTools();
  const done = tools.find(t => t.name === 'done');
  if (!done) throw new Error('done tool missing from blind catalog');
  return done;
}

async function runDone(evidence: string) {
  const done = getDoneTool();
  // The done tool's execute() doesn't read ctx — pass {} cast.
  return done.execute({ evidence }, {} as any);
}

describe('done tool — evidence guard', () => {
  describe('accepts concrete observations', () => {
    it('window-title evidence', async () => {
      const r = await runDone('Window title shows "Untitled - Notepad"');
      expect(r.success).toBe(true);
      expect(r.terminalExit).toBe('done');
    });

    it('on-screen text evidence', async () => {
      const r = await runDone('Calculator displays the result 391');
      expect(r.success).toBe(true);
    });

    it('focused-element evidence', async () => {
      const r = await runDone('Send button is now disabled and the inbox is shown');
      expect(r.success).toBe(true);
    });

    it('multiple concrete signals separated by commas', async () => {
      const r = await runDone('Compose closed, "Sent" folder selected, latest message visible at top');
      expect(r.success).toBe(true);
    });
  });

  describe('rejects hedging language', () => {
    it('rejects "should have been sent"', async () => {
      const r = await runDone('The email should have been sent to user@example.com');
      expect(r.success).toBe(false);
      expect(r.text).toMatch(/hedging|GUESSING/i);
    });

    it('rejects "should be"', async () => {
      const r = await runDone('Calculator should be open now');
      expect(r.success).toBe(false);
    });

    it('rejects "might have" / "may have"', async () => {
      expect((await runDone('The file might have been saved')).success).toBe(false);
      expect((await runDone('The button may have triggered the action')).success).toBe(false);
    });

    it('rejects "probably"', async () => {
      const r = await runDone('Outlook probably sent the message');
      expect(r.success).toBe(false);
    });

    it('rejects first-person uncertainty', async () => {
      expect((await runDone('I think the form was submitted')).success).toBe(false);
      expect((await runDone('I believe the file is now saved')).success).toBe(false);
      expect((await runDone('I assume the email reached the recipient')).success).toBe(false);
    });

    it('rejects "appears to" / "seems to"', async () => {
      expect((await runDone('The compose window appears to be closed')).success).toBe(false);
      expect((await runDone('It seems to have worked')).success).toBe(false);
    });

    it('rejects "if successful" / "if it worked"', async () => {
      const r = await runDone('If successful the message is in the Sent folder');
      expect(r.success).toBe(false);
    });
  });

  describe('rejects empty / trivial evidence', () => {
    it('rejects empty string', async () => {
      const r = await runDone('');
      expect(r.success).toBe(false);
      expect(r.text).toMatch(/empty|too short/i);
    });

    it('rejects "ok"', async () => {
      const r = await runDone('ok');
      expect(r.success).toBe(false);
      expect(r.text).toMatch(/empty|too short/i);
    });

    it('rejects whitespace-only', async () => {
      expect((await runDone('   ')).success).toBe(false);
    });
  });

  describe('does not false-positive on legitimate words', () => {
    it('"shoulder" is not "should"', async () => {
      const r = await runDone('Note the shoulder of the form is highlighted blue');
      expect(r.success).toBe(true);
    });

    it('"mighty" is not "might"', async () => {
      const r = await runDone('A mighty long error message visible at the bottom');
      expect(r.success).toBe(true);
    });

    it('"appearance" is not "appears to"', async () => {
      const r = await runDone('The dialog has a modern appearance with the title "Settings"');
      expect(r.success).toBe(true);
    });

    it('a sentence about "showing" / "displayed" is fine', async () => {
      const r = await runDone('Title bar showing "Sent - Outlook"');
      expect(r.success).toBe(true);
    });
  });
});
