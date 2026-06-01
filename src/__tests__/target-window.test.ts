/**
 * Regression tests for resolveSubtaskTargetWindow — the stay-in-window anchor.
 *
 * Born from a real run (task 2fa91233): a subtask got anchored to a stale
 * "Settings" window (the foreground at subtask start) and the agent thrashed
 * trying to stay there. The anchor must be GROUNDED in the survey and must
 * never pin the agent to our own console, a terminal, or an OS shell surface.
 *
 * Pure + OS-agnostic: WindowInfo/DesktopSurvey are plain data.
 */
import { describe, it, expect } from 'vitest';
import { resolveSubtaskTargetWindow } from '../core/pipeline';
import type { DesktopSurvey } from '../core/desktop-survey';
import type { WindowInfo } from '../platform/types';

const win = (title: string, processName: string): WindowInfo => ({
  title, processName, processId: 1,
  bounds: { x: 0, y: 0, width: 100, height: 100 }, isMinimized: false,
});

const edge = win('Wikipedia, the free encyclopedia - Microsoft Edge', 'msedge.exe');
const notepad = win('Untitled - Notepad', 'notepad.exe');
const settings = win('Settings', 'ApplicationFrameHost.exe');
const ownConsole = win('Clawd Cursor - Task Console', 'WindowsTerminal.exe');
const powershell = win('Windows PowerShell', 'powershell.exe');

const survey = (openWindows: WindowInfo[], handlers: DesktopSurvey['handlers'] = {}): DesktopSurvey => ({
  openWindows, handlers,
});

describe('resolveSubtaskTargetWindow', () => {
  it('REGRESSION: does NOT anchor a web subtask to a stale Settings foreground', () => {
    const s = survey([settings, edge], { browser: { name: 'msedge', openWindow: edge } });
    // Foreground is Settings, but the subtask is about the Wikipedia page →
    // must resolve to the BROWSER window, never Settings.
    const t = resolveSubtaskTargetWindow('select and copy a sentence from the Wikipedia page', s, settings);
    expect(t?.processName).toBe('msedge.exe');
  });

  it('REGRESSION: never anchors to Settings/own-console even with no better match', () => {
    const s = survey([settings, ownConsole, powershell]);
    // Non-web subtask, no named app open, foreground is Settings → undefined,
    // NOT Settings. (Generic stay-in-window guidance applies instead.)
    expect(resolveSubtaskTargetWindow('copy the selected text', s, settings)).toBeUndefined();
    expect(resolveSubtaskTargetWindow('do the thing', s, ownConsole)).toBeUndefined();
    expect(resolveSubtaskTargetWindow('do the thing', s, powershell)).toBeUndefined();
  });

  it('anchors to a browser window for web intent (OS-resolved handler)', () => {
    const s = survey([edge], { browser: { name: 'msedge', openWindow: edge } });
    expect(resolveSubtaskTargetWindow('copy a sentence from the page', s, null)?.processName).toBe('msedge.exe');
  });

  it('web intent uses GENERIC content nouns, not site names (article/video/post)', () => {
    const s = survey([edge], { browser: { name: 'msedge', openWindow: edge } });
    // No "wikipedia/youtube/reddit" needed — generic web-content nouns resolve
    // to the OS-default browser for ANY site.
    expect(resolveSubtaskTargetWindow('copy a sentence from the article', s, null)?.processName).toBe('msedge.exe');
    expect(resolveSubtaskTargetWindow('like the video', s, null)?.processName).toBe('msedge.exe');
    expect(resolveSubtaskTargetWindow('upvote the post', s, null)?.processName).toBe('msedge.exe');
  });

  it('anchors to an open app the subtask names by process', () => {
    const s = survey([settings, notepad]);
    expect(resolveSubtaskTargetWindow('paste the text into notepad and save', s, settings)?.processName)
      .toBe('notepad.exe');
  });

  it('uses the foreground when it IS a real, targetable app window', () => {
    const word = win('Document1 - Word', 'winword.exe');
    const s = survey([word]);
    expect(resolveSubtaskTargetWindow('type a heading', s, word)?.processName).toBe('winword.exe');
  });

  it('returns undefined for launch/navigate subtasks (target emerges after)', () => {
    const s = survey([edge], { browser: { name: 'msedge', openWindow: edge } });
    expect(resolveSubtaskTargetWindow('navigate to https://en.wikipedia.org in the browser', s, edge)).toBeUndefined();
    expect(resolveSubtaskTargetWindow('open notepad', s, edge)).toBeUndefined();
  });

  it('does not anchor to a terminal even if the subtask name overlaps', () => {
    // "powershell" appears in the task, but terminals are never a GUI target.
    const s = survey([powershell]);
    expect(resolveSubtaskTargetWindow('run the powershell command', s, powershell)).toBeUndefined();
  });
});
