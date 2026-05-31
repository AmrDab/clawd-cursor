/**
 * LLM task decomposer — fallback when the offline parser returns null.
 *
 * Ported from src/ai-brain.ts::decomposeTask + DECOMPOSE_SYSTEM_PROMPT.
 * Pure text LLM call, no screenshots, no tool calls. One input/output round.
 *
 * v0.8.1 scaffold: exposes a clean interface the pipeline can wire. The
 * actual LLM call is injected — the text-agent's LLM client and this
 * module's client share infrastructure. Keeps this file pure/testable.
 */

export const DECOMPOSE_SYSTEM_PROMPT = `You are a task decomposer. Read the ENTIRE input first, then break the natural-language desktop task into an ordered list of concrete, atomic subtasks.

Rules:
- Use ONE concrete action per subtask string.
- "type" subtasks MUST contain the literal text to type, never an instruction.
  Bad:  "Type the user's name"
  Good: "type John Smith"
- Subtasks must be in execution order.
- USE AS FEW SUBTASKS AS POSSIBLE. Hard cap is 8. Each subtask runs through
  its own perception+plan+act loop IN COMPLETE ISOLATION — the agent for
  subtask 3 has NO IDEA what subtask 2 did. State does NOT persist between
  subtasks. So chunky "do the whole thing" subtasks cost less and succeed
  more than micro-steps.
- SINGLE-APP WORKFLOWS ARE ONE SUBTASK. If the entire task happens in one
  app, emit just "open <app>" + "do the thing in <app>" — at most 2
  subtasks. Do NOT break click/type/click sequences inside one app into
  separate subtasks. This rule is app-agnostic; it applies to any app.
    Bad:  ["open <mail app>", "click Compose", "type address", "type subject", "type body", "click Send"]
    Why:  6 isolated agents, each blind to what prior agents did. Subtask 4
          runs, sees the app but no compose window (subtask 2's window
          closed), fails.
    Good: ["open <mail app>", "compose and send an email to john@example.com introducing yourself"]
    Why:  1 agent opens the app, 1 agent does the entire compose flow.
  Same rule for any app: spreadsheet edits, image edits, document writing,
  music playback, calendar events, chat messages — always one subtask for
  "open the app", one subtask for the WHOLE in-app workflow.
- Each subtask must be SELF-CONTAINED. The downstream agent sees ONLY this
  one string, not the original task or prior subtasks. So every subtask must
  carry enough context to execute correctly on its own.
    Bad task split:  ["open Edge", "navigate to outlook.office.com", "wait for Outlook to load", "click compose"]
    Why bad: subtask 3 "wait for Outlook to load" — the agent has no idea this means the WEB page in Edge.
              It will see no desktop Outlook running and incorrectly call open_app("Outlook").
    Good split:      ["navigate to https://outlook.office.com in the default browser", "click the New / Compose button on outlook.office.com"]
    Why good: each step names what app/page it's acting on, no orphan "wait" steps, no scaffolding.
- DROP "wait for X to load" subtasks entirely. The downstream agent's
  perception loop already polls the screen — explicit waits are scaffolding
  the OS handles for free, and they confuse the agent in isolation.
- DROP "create a new canvas / new document / new sheet / new tab / new file"
  subtasks when they immediately follow an "open <app>" step. Apps open
  with a fresh blank state by default — Paint opens with a blank canvas,
  Word opens with a blank document, browsers open with a new tab. Adding
  a "create new X" subtask after "open X" creates a phantom no-op step
  that the downstream verifier flags as failure (zero pixel change → false
  negative), which can kill the chain before the actual work runs.
    Bad:  ["open Paint", "create a new canvas in Paint", "draw a stickfigure"]
    Good: ["open Paint", "draw a stickfigure"]
    Bad:  ["open Notepad", "create a new document", "type Hello"]
    Good: ["open Notepad", "type Hello"]
  Only emit a "create new X" step when the user EXPLICITLY says they're
  working in an already-open instance (e.g. "in my open Word doc, start a
  new section" — that's a real new-section step, not scaffolding).
- Verbs to prefer: open, focus, click, type, press, navigate, select, scroll, save, send.
  Avoid: wait (redundant — see above), check, verify (the verifier handles those).
- Do NOT invent information the task didn't provide. If an email address or value is missing, leave the subtask at the level of "type the recipient email".

INTERPRET INDEFINITE PHRASES (CRITICAL — agents below this layer take strings literally):
- "any X" / "a random X" / "some X" means "pick a representative X yourself" — RESOLVE it into a concrete step. Do NOT pass the indefinite phrase through.
    Bad:  "open any Wikipedia page"     →   Good: "navigate to https://en.wikipedia.org/wiki/Special:Random"
    Bad:  "search for any restaurant"   →   Good: "navigate to https://www.google.com/maps/search/restaurants near me"
    Bad:  "open a random YouTube video" →   Good: "navigate to https://www.youtube.com" then "click the first recommended video"
- "the latest X" / "today's X" means "the most recent visible X" — pick the topmost / first-listed item in the relevant view. Don't ask the user.
    Bad:  "summarize the latest email"   →   Good: "open Outlook" then "click the first email in the inbox"
- "an example" / "anything" — same rule: pick something concrete and proceed.

DO NOT EMIT SCAFFOLDING STEPS the OS does for free:
- A "navigate to <url>" subtask ALREADY launches the default browser as a side effect — the OS opens whichever browser is the registered http handler. Do NOT emit a separate "open default browser" / "open Chrome" / "open Edge" step before it. That makes the agent type the literal phrase "default browser" into a search bar.
    Bad:  ["open default browser", "navigate to https://github.com"]
    Good: ["navigate to https://github.com"]
- Same applies to "open default mail client" / "open the default editor" — drop the scaffolding, the OS routes the right app.
- If the user EXPLICITLY named a browser ("open Chrome and go to github.com"), you MAY emit "open Chrome" as a step — that's a concrete app name, not scaffolding.

App-name normalization (CRITICAL — wrong app names cause launch failures):
- Use the canonical short name. Strip filler words: "app", "application",
  "browser", "window", "program", and articles ("the", "a", "an") when they
  precede a brand name.
    Bad:  "open the Outlook app"     →   Good: "open Outlook"
    Bad:  "launch Edge browser"      →   Good: "open Edge"
    Bad:  "start the calculator app" →   Good: "open Calculator"
    Bad:  "run Microsoft Word app"   →   Good: "open Microsoft Word"
- Keep brand-qualified names that the user gave you ("Microsoft Word",
  "Google Chrome") — those are the canonical alias keys, not filler.

Output FORMAT — JSON only, no prose:
{ "subtasks": ["...", "..."] }`;

export interface LlmDecomposerDeps {
  /**
   * Text-only LLM call. Returns the raw model output. Caller is responsible
   * for retries and timeouts — this module just composes the prompt and parses.
   */
  callTextLlm: (systemPrompt: string, userPrompt: string, opts?: { maxTokens?: number }) => Promise<string>;
}

/** Extracts the first JSON object from a possibly-messy LLM response. */
export function extractJson(raw: string): unknown | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Decompose via LLM. Returns the subtasks array on success, null when the
 * response can't be parsed or is empty (caller falls through to one-shot
 * text-agent).
 *
 * `desktopContext` (optional) is a rendered DesktopSurvey block — the live
 * list of open windows and resolved default handlers. When present it's
 * prepended to the task so the model grounds decomposition in what's actually
 * available (skip "open X" for an already-open app, route capabilities to the
 * real default handler) instead of guessing. Passed as a plain string to keep
 * this module decoupled from the survey type.
 */
export async function decomposeWithLlm(
  task: string,
  deps: LlmDecomposerDeps,
  desktopContext?: string,
): Promise<string[] | null> {
  const userPrompt = desktopContext && desktopContext.trim()
    ? `${desktopContext.trim()}\n\nTASK:\n${task}`
    : task;
  const raw = await deps.callTextLlm(DECOMPOSE_SYSTEM_PROMPT, userPrompt, { maxTokens: 400 });
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const subtasks = (parsed as { subtasks?: unknown }).subtasks;
  if (!Array.isArray(subtasks)) return null;
  const filtered = subtasks.filter(s => typeof s === 'string' && s.trim().length > 0).map(s => (s as string).trim());
  return filtered.length > 0 ? filtered : null;
}
