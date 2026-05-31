/**
 * Desktop-survey tests. Pure + OS-agnostic: all platform access is injected,
 * so these run identically on any OS with no real windows or handlers.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  surveyDesktop, renderSurveyForPrompt, distinctOpenAppCount,
} from '../core/desktop-survey';
import { decomposeWithLlm } from '../core/decompose/llm-decomposer';
import type { WindowInfo } from '../platform/types';

const win = (title: string, processName: string): WindowInfo => ({
  title, processName, processId: 1,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  isMinimized: false,
});

describe('surveyDesktop', () => {
  it('resolves capability handlers and links them to open windows', async () => {
    const survey = await surveyDesktop({
      listWindows: async () => [win('Inbox - Outlook', 'olk.exe'), win('GitHub — Edge', 'msedge.exe')],
      resolveHandler: async (scheme) =>
        scheme === 'mailto' ? 'C:\\Program Files\\olk.exe'
        : scheme === 'https' ? 'C:\\msedge.exe'
        : null,
    });
    expect(survey.openWindows).toHaveLength(2);
    expect(survey.handlers.mail?.name).toBe('olk');
    expect(survey.handlers.browser?.name).toBe('msedge');
    // linked to the matching open window (by process basename)
    expect(survey.handlers.mail?.openWindow?.title).toBe('Inbox - Outlook');
    expect(survey.handlers.browser?.openWindow?.title).toBe('GitHub — Edge');
  });

  it('degrades gracefully when no handler is resolvable (non-Windows path)', async () => {
    const survey = await surveyDesktop({
      listWindows: async () => [win('Untitled - Notepad', 'notepad.exe')],
      resolveHandler: async () => null, // mirrors uri-handler returning null off-Windows
    });
    expect(survey.openWindows).toHaveLength(1);
    expect(survey.handlers.mail).toBeUndefined();
    expect(survey.handlers.browser).toBeUndefined();
  });

  it('never throws — a failing window probe yields an empty open-window list', async () => {
    const survey = await surveyDesktop({
      listWindows: async () => { throw new Error('a11y bridge down'); },
      resolveHandler: async () => null,
    });
    expect(survey.openWindows).toEqual([]);
  });

  it('does not link a handler with no matching open window', async () => {
    const survey = await surveyDesktop({
      listWindows: async () => [win('Untitled - Notepad', 'notepad.exe')],
      resolveHandler: async (s) => (s === 'mailto' ? '/usr/bin/thunderbird' : null),
    });
    expect(survey.handlers.mail?.name).toBe('thunderbird');
    expect(survey.handlers.mail?.openWindow).toBeUndefined(); // not running
  });
});

describe('distinctOpenAppCount', () => {
  it('counts distinct processes, ignoring multiple windows of one app', async () => {
    const survey = await surveyDesktop({
      listWindows: async () => [
        win('Doc1 - Word', 'winword.exe'),
        win('Doc2 - Word', 'WINWORD.EXE'), // same app, different case
        win('Edge', 'msedge.exe'),
      ],
      resolveHandler: async () => null,
    });
    expect(distinctOpenAppCount(survey)).toBe(2);
  });
});

describe('renderSurveyForPrompt', () => {
  it('lists open windows + resolved default apps with already-open markers', async () => {
    const survey = await surveyDesktop({
      listWindows: async () => [win('Inbox - Outlook', 'olk.exe')],
      resolveHandler: async (s) =>
        s === 'mailto' ? 'olk.exe' : s === 'https' ? 'msedge.exe' : null,
    });
    const text = renderSurveyForPrompt(survey);
    expect(text).toMatch(/DESKTOP CONTEXT/);
    expect(text).toMatch(/Inbox - Outlook/);
    expect(text).toMatch(/Default mail app: olk — already open/);
    expect(text).toMatch(/Default browser: msedge/); // resolved but not open → no marker
    expect(text).not.toMatch(/Default browser: msedge — already open/);
  });

  it('returns empty string when there is nothing to report', () => {
    expect(renderSurveyForPrompt({ openWindows: [], handlers: {} })).toBe('');
  });
});

describe('decomposeWithLlm desktop grounding', () => {
  it('prepends the desktop context to the task in the user prompt', async () => {
    const callTextLlm = vi.fn(async () => JSON.stringify({ subtasks: ['do it'] }));
    await decomposeWithLlm('send an email and tweet about it', { callTextLlm },
      'DESKTOP CONTEXT:\nOpen windows right now:\n  - "Inbox - Outlook" [olk.exe]');
    const userPrompt = callTextLlm.mock.calls[0][1];
    expect(userPrompt).toMatch(/DESKTOP CONTEXT/);
    expect(userPrompt).toMatch(/Inbox - Outlook/);
    expect(userPrompt).toMatch(/TASK:\nsend an email and tweet about it/);
  });

  it('passes the bare task through when no context is supplied (back-compat)', async () => {
    const callTextLlm = vi.fn(async () => JSON.stringify({ subtasks: ['x'] }));
    await decomposeWithLlm('open notepad', { callTextLlm });
    expect(callTextLlm.mock.calls[0][1]).toBe('open notepad');
  });
});
