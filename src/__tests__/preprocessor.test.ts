/**
 * Preprocessor tests — strategy decisions per task shape.
 *
 * Phase 3 (marketplace) moved most curated guides to seed-registry/. Point
 * the loader's bundled dir at the seed copy for the duration of the suite
 * so the gmail/outlook/etc. knowledge-injection assertions still resolve.
 * Also disable the remote registry so prefetchGuideForApp doesn't try to
 * hit the network during tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { preprocess, requiresLlm, usesVision } from '../core/preprocessor/preprocessor';

const SEED_REGISTRY = path.resolve(__dirname, '../../seed-registry/guides');
const ORIG_BUNDLED  = process.env.CLAWD_BUNDLED_GUIDES_DIR;
const ORIG_OFF      = process.env.CLAWD_GUIDES_REGISTRY_OFF;
beforeAll(() => {
  process.env.CLAWD_BUNDLED_GUIDES_DIR = SEED_REGISTRY;
  process.env.CLAWD_GUIDES_REGISTRY_OFF = '1';
});
afterAll(() => {
  if (ORIG_BUNDLED === undefined) delete process.env.CLAWD_BUNDLED_GUIDES_DIR;
  else process.env.CLAWD_BUNDLED_GUIDES_DIR = ORIG_BUNDLED;
  if (ORIG_OFF === undefined) delete process.env.CLAWD_GUIDES_REGISTRY_OFF;
  else process.env.CLAWD_GUIDES_REGISTRY_OFF = ORIG_OFF;
});

describe('preprocess — strategy selection', () => {
  it.each([
    ['open notepad',              'router'],
    ['launch Chrome',             'router'],
    ['go to github.com',          'router'],
    ['navigate to https://x.com', 'router'],
    ['focus Slack',               'router'],
    ['switch to Outlook',         'router'],
  ])('%s → router', (task, expected) => {
    expect(preprocess(task).strategy).toBe(expected);
  });

  it.each([
    'draw a square on the canvas',
    'sketch a house',
    'drag the icon to the trash',
    'paint the background red',
  ])('%s → vision (spatial)', (task) => {
    expect(preprocess(task).strategy).toBe('vision');
  });

  // Regression: drag gestures phrased with "into"/"onto" (not just "to")
  // must still morph to vision. The strategy classifier's drag rule had
  // drifted out of sync with the capability classifier, sending these to
  // blind — where a screenshot-less text-agent can't compute drag coords.
  it.each([
    'drag the file into the folder',
    'drag the icon onto the desktop',
    'drag and drop the photo into the album',
    'drag the card into the Done column',
  ])('%s → vision (drag into/onto)', (task) => {
    expect(preprocess(task).strategy).toBe('vision');
  });

  it.each([
    'click the blue button in the top right',
    'click the red area at the bottom left',
  ])('%s → hybrid (visual wording)', (task) => {
    expect(preprocess(task).strategy).toBe('hybrid');
  });

  it.each([
    'type hello world',
    'click Send',
    'compute 5 plus 7 in calculator',
    'summarize this screen',
    'fill out the registration form',
  ])('%s → blind', (task) => {
    expect(preprocess(task).strategy).toBe('blind');
  });

  it.each([
    'send email to bob@x.com',
    'send an email to alice@example.org with subject Hello',
    'compose an email to team@corp.com',
    'send message to support@vendor.io introducing yourself',
  ])('%s → playbook(compose-send)', (task) => {
    const r = preprocess(task);
    expect(r.strategy).toBe('playbook');
    expect(r.hints.playbookName).toBe('compose-send');
  });

  it.each([
    'find and replace foo with bar',
    'replace all "old" with "new"',
  ])('%s → playbook(find-replace)', (task) => {
    const r = preprocess(task);
    expect(r.strategy).toBe('playbook');
    expect(r.hints.playbookName).toBe('find-replace');
  });
});

describe('preprocess — subtasks', () => {
  it('splits compound tasks when each part has an action verb', () => {
    const r = preprocess('open notepad and type hello');
    expect(r.subtasks).toEqual(['open notepad', 'type hello']);
  });

  it('keeps non-splittable compound as one task', () => {
    const r = preprocess('scroll through all emails and the unread ones');
    expect(r.subtasks).toEqual([]); // kept as one — executor runs whole
  });
});

describe('preprocess — knowledge injection', () => {
  it('attaches Gmail guide when active window is Gmail', () => {
    const r = preprocess('send email to bob@acme.com', {
      activeWindowTitle: 'mail.google.com - Inbox',
    });
    expect(r.hints.appKey).toBe('gmail');
    expect(r.hints.guide).toBeDefined();
    expect(r.hints.guide?.promptFragment).toMatch(/gmail/i);
  });

  it('attaches Outlook guide when active window is Outlook', () => {
    const r = preprocess('reply to the last email', {
      activeWindowTitle: 'Inbox — Outlook',
    });
    expect(r.hints.appKey).toBe('outlook');
  });

  it('no guide when app is unknown', () => {
    // Use a fictional app name that no detectApp rule matches. Real apps like
    // 'Notepad' now resolve to a bundled guide, so they can't stand in for "unknown".
    const r = preprocess('type something', {
      activeWindowTitle: 'SomeObscureNicheApp_v3.2.1',
    });
    expect(r.hints.guide).toBeUndefined();
  });
});

describe('preprocess — hints include telemetry reason', () => {
  it('router pick carries reason', () => {
    expect(preprocess('open chrome').hints.reason).toMatch(/router-pattern/i);
  });
  it('spatial pick carries reason', () => {
    expect(preprocess('draw a circle').hints.reason).toMatch(/spatial/i);
  });
  it('default pick carries reason', () => {
    expect(preprocess('summarize the article').hints.reason).toMatch(/default/i);
  });
});

describe('requiresLlm / usesVision predicates', () => {
  it('router is the only no-LLM strategy', () => {
    expect(requiresLlm('router')).toBe(false);
    expect(requiresLlm('blind')).toBe(true);
    expect(requiresLlm('hybrid')).toBe(true);
    expect(requiresLlm('vision')).toBe(true);
  });
  it('vision and hybrid use screenshots', () => {
    expect(usesVision('vision')).toBe(true);
    expect(usesVision('hybrid')).toBe(true);
    expect(usesVision('blind')).toBe(false);
    expect(usesVision('router')).toBe(false);
  });
});
