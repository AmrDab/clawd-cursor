# Guide JSON System — End-to-End Audit (v0.9.0)

Audit branch: `claude/v0.9.0` @ `c25e2df`. Read-only investigation; no code changed.

The TL;DR up front: there are **two parallel guide systems** in this tree — a
v0.9 "knowledge loader" that is correctly wired into the agent's system prompt,
and a v0.7-era "guide-loader" that is functionally dead end-to-end. Where they
overlap they corrupt each other's data shape. The user's hypothesis #1 about
`[object Object]` is real — but it only fires inside the dead path, so today's
agent runs are not actually broken by it. The biggest live problem is **coverage**:
the live path ships JSONs for exactly three apps.

---

## Schema (what's in the JSON)

There are two co-existing schemas for the same file extension.

### Schema A — the v0.9 "knowledge" shape (live)

Defined as `AppGuide` / `AppWorkflow` in `src/core/pipeline-types.ts:89-115`.
Files live in `src/llm/knowledge/guides/*.json`. Bundled to `dist/` by
`src/postbuild.ts:34-36`.

```ts
interface AppGuide {
  app: string;                              // "gmail"
  name: string;                             // "Gmail"
  shortcuts?: Record<string, string>;       // "compose": "c"
  workflows?: Record<string, AppWorkflow>;  // typed step arrays
  tips?: string[];
  domainHints?: string[];                   // ["mail.google.com", ...]
}

interface AppWorkflow {
  name: string;
  steps: Array<
    | { type: 'pressKey';    key: string;     note?: string }
    | { type: 'typeAtFocus'; field: string;   note?: string }
    | { type: 'click';       target: string;  note?: string }
    | { type: 'wait';        ms: number;      note?: string }
    | { type: 'verify';      name: string;    note?: string }
  >;
}
```

Three files exist on disk in this shape:
`src/llm/knowledge/guides/{gmail,outlook,slack}.json`.

### Schema B — the v0.7-era "shortcut guide" shape (used to be live, now half-orphan)

Defined as `AppGuide` *inside* `src/llm/guide-loader.ts:15-22`.

```ts
interface AppGuide {
  app: string;
  processNames: string[];          // ["EXCEL", "excel"]
  workflows: Record<string, string>;  // free-text description, NOT step arrays
  shortcuts: Record<string, string>;
  layout: Record<string, string>;
  tips: string[];
}
```

Files in this shape live in `guides/` (repo root, eleven files) — keyed by
Windows process name. Some carry a `learnedWorkflows` block that was written
by the legacy `learn_app` flow (e.g. `guides/EXCEL.json:297`,
`guides/notepad.json:39`, `guides/ApplicationFrameHost.json:7`).

The `guides/README.md` describes this shape and tells contributors to add files
there. **No code currently reads from that directory.**

The two schemas collide because both `src/llm/guide-loader.ts:36` and
`src/llm/knowledge/loader.ts:30` resolve their "guides dir" to the *same*
on-disk path: `src/llm/knowledge/guides/`. The legacy loader's TypeScript
interface and the JSONs in that directory therefore disagree about whether
`workflows` is `Record<string,string>` (Schema B's claim) or
`Record<string,AppWorkflow>` (Schema A — what's actually on disk).

---

## Data flow (where it goes)

### Live path — used by every agent run

```
preprocess(task, {activeWindowTitle})        src/core/preprocessor/preprocessor.ts:111
  └─> getWorkflowForTask(task, urlOrTitle)   src/llm/knowledge/loader.ts:80
        ├─> detectApp(urlOrTitle)            src/llm/knowledge/domain-map.ts:68
        ├─> loadGuide(app)                   src/llm/knowledge/loader.ts:45
        │     reads src/llm/knowledge/guides/<app>.json  (user override at
        │     $CLAWD_HOME/.clawdcursor/ui-knowledge/<app>.json wins if present)
        ├─> matches task keywords → workflow key (compose_and_send, reply, …)
        └─> returns { guide, workflow, promptFragment }   loader.ts:138
              │
              └─ promptFragment is rendered string of typed steps, e.g.:
                  "APP KNOWLEDGE — GMAIL:
                   Use this EXACT sequence for "compose and send an email":
                   1. pressKey c (open compose window)
                   2. wait 800ms (compose window appears; …)
                   3. typeAtFocus — the recipient (then press Tab …)
                   …
                   Known shortcuts: compose=c, send=mod+Return, …
                   Tips: …
                   Follow this sequence precisely. Prefer keyboard over mouse."

preprocess returns decision.hints.guide = { appName, promptFragment }
                                                          │
Pipeline.runAgent(...)                       src/core/pipeline.ts:1070
  passes decision.hints.guide → AgentInput.guide
                                                          │
runAgent → buildSystemPromptWithGuide(input) src/core/agent-loop/agent.ts:743
  appends:  "\n\n--- APP KNOWLEDGE (from bundled guide / user override) ---\n"
          + input.guide.promptFragment
  to the system prompt produced by buildSystemPrompt(mode).
```

That fragment is human-readable text the LLM can actually reason over —
`pressKey c (open compose window)` is in the model's context. The
preprocessor's `if (workflow) … else if (appKey) …` fallback at
`preprocessor.ts:113-124` also handles the "we know the app but the keywords
didn't pick a workflow" case by emitting `APP: Gmail\nKnown shortcuts: …`.
That branch is also live.

Tests pinning this behavior:
- `src/__tests__/knowledge.test.ts:102-134` — fragment contains `pressKey c`,
  `mod+r`, "Prefer keyboard over mouse", etc.
- `src/__tests__/preprocessor.test.ts:80-101` — preprocessor attaches
  `hints.guide` when the active window title matches.

### Dead path — `src/llm/guide-loader.ts`

`loadGuide` here scans `src/llm/knowledge/guides/`, indexes by `processNames`,
and exports `formatGuideForPrompt`, `getGuidePrompt`, and `saveLesson`.

Static callers across the repo:

| symbol                  | callers                                                  |
|-------------------------|----------------------------------------------------------|
| `loadGuide` (this file) | `src/tools/extras.ts:909` (inside `learn_app` handler)   |
| `saveLesson`            | `src/tools/extras.ts:909` (inside `learn_app` handler)   |
| `formatGuideForPrompt`  | only `getGuidePrompt` (line 143) inside the same file    |
| `getGuidePrompt`        | **nobody**                                               |

So the formatter is not on the production agent prompt path at all. The only
live consumer of this file is the `learn_app` MCP tool, which uses
`loadGuide` + `saveLesson` to write into `src/llm/knowledge/guides/` (extras.ts
line 916 confirms the destination is the *Schema A* directory, not the root
`guides/` one).

### Orphaned: the root `guides/` directory

No TypeScript source resolves `path.join(repoRoot, 'guides')` or otherwise
reads `<repo>/guides/*.json` at runtime. The README describing it
(`guides/README.md`) and its eleven JSONs (`ApplicationFrameHost.json`,
`Discord.json`, `EXCEL.json`, `Figma.json`, `Slack.json`, `Spotify.json`,
`msedge.json`, `mspaint.json`, `notepad.json`, `olk.json`) are dead weight
held over from before the loader path was moved to `src/llm/knowledge/guides/`.

There is also `src/llm/guide-registry.ts` — a CLI (`clawdcursor guides
install …`) that *writes* Schema-B-shaped JSONs into the live Schema-A
directory (`GUIDES_DIR = path.join(__dirname, 'knowledge', 'guides')`). That
data would be loadable by `loadGuide`, but with no `workflows` and a tip-only
`tips` array, it would fall straight through `getWorkflowForTask`'s keyword
gate at `loader.ts:107-112` and only surface via the `else if (appKey)`
shortcuts fallback in the preprocessor.

---

## Confirmed bugs

### 1. `formatGuideForPrompt` stringifies workflow values as `[object Object]`

`src/llm/guide-loader.ts:92-97`:

```ts
if (guide.workflows && Object.keys(guide.workflows).length > 0) {
  lines.push('WORKFLOWS:');
  for (const [name, steps] of Object.entries(guide.workflows)) {
    lines.push(`  ${name}: ${steps}`);   // ← coerces the workflow object
  }
}
```

Schema A's `workflows` values are objects (`{name, steps[]}`). Template-literal
coercion turns each into `[object Object]`. Repro inside this audit:

```
$ node -e "const g={workflows:{compose_and_send:{name:'…',steps:[{…}]}}};
           for(const [n,s] of Object.entries(g.workflows))
             console.log(\`  \${n}: \${s}\`)"
  compose_and_send: [object Object]
```

**The bug is real, but the function is unreachable.** Nothing calls
`getGuidePrompt`, so the corrupted output never reaches an LLM. The same code
path would also misformat the Schema-B `workflows` (which *are* strings) — it
would print them correctly. So when this code was alive in a v0.7-era pipeline
it worked; the dataset shape moved on, the code didn't, and nothing routes
through it anymore.

Same bug exists for `learnedWorkflows` at lines 100-106 (printed as
`[object Object]` if a future writer stores objects there). For now,
`saveLesson` stores them as joined strings (`workflowSteps`), so the live
data shape happens to match what the printer expects.

### 2. Two `AppGuide` interfaces in the codebase — one of them lies

`src/llm/guide-loader.ts:15-22` declares its own local `AppGuide` claiming
`workflows: Record<string, string>` and `processNames: string[]` etc. The
canonical type in `src/core/pipeline-types.ts:89` says
`workflows: Record<string, AppWorkflow>` and `domainHints?: string[]`. Files
on disk under `src/llm/knowledge/guides/` follow the canonical pipeline-types
shape. The interface in `guide-loader.ts` is therefore wrong about what it
loads. TS doesn't catch it because the local interface shadows the import.

### 3. `learn_app` writes Schema-B fields into Schema-A files

When `saveLesson` (guide-loader.ts:188-219) finds an existing guide for a
process name, it adds `learnedWorkflows[key] = workflowSteps` (a flat string)
to it, then writes back. The canonical `AppGuide` type has no
`learnedWorkflows` field and no reader respects it. So a successful learning
event mutates the on-disk gmail.json / outlook.json / slack.json with a
non-canonical field that the live loader doesn't surface. No data loss, but
no payoff either.

If no existing guide is found (the common case — `learn_app` is process-name
keyed against the canonical loader which keys on web-app names), `saveLesson`
creates a new file at `src/llm/knowledge/guides/<processName>.json` with
Schema-B fields only and no `domainHints`. The canonical loader can read it
by key but `detectApp(processName)` will fail unless the process name happens
to match one of the title fallbacks at `domain-map.ts:51-62`. Net effect:
learned data for, say, `Notepad` lands on disk and is then never recalled.

### 4. The `guides/` root README points at a dead directory

`guides/README.md` tells contributors to "create a `{process-name}.json` file
in this directory" and promises automatic loading at runtime. No code path
reads that directory. New contributions there are inert.

---

## What's working

- `detectApp` resolves URL and title hints correctly. Tests confirm Gmail,
  Outlook, Slack, Figma, GitHub, Notion (`knowledge.test.ts:13-34`).
- `loadGuide` (the v0.9 one) correctly loads bundled guides and prefers a
  user override at `$CLAWD_HOME/.clawdcursor/ui-knowledge/`.
- `getWorkflowForTask` correctly resolves task keywords → workflow key and
  renders typed steps as a readable prompt fragment that includes literal
  shortcuts and notes. Output is what the LLM needs to reason: text, not JSON.
- `buildSystemPromptWithGuide` (`agent.ts:743`) appends the fragment with a
  clear `--- APP KNOWLEDGE ---` delimiter so the LLM can locate it.
- The "no workflow matched but we know the app" fallback at
  `preprocessor.ts:115-123` still gives the agent shortcuts.
- `postbuild.ts` copies the bundled guides into `dist/` so installed copies
  see them.

---

## Gaps

- **Bug (confirmed):** `formatGuideForPrompt` produces `[object Object]` for
  Schema-A workflows. Cosmetic only — function is unreachable. Should be
  deleted or fixed.
- **Coverage:** `APP_ALIASES` table covers 39 user-facing app keys
  (`activity monitor`, `calc`, `calculator`, `chrome`, `cmd`, `code`,
  `cursor`, `discord`, `edge`, `excel`, `explorer`, `figma`, `file explorer`,
  `finder`, `firefox`, `google chrome`, `iterm`, `mail`, `microsoft edge`,
  `microsoft outlook`, `mspaint`, `notepad`, `notes`, `outlook`, `paint`,
  `powershell`, `safari`, `settings`, `slack`, `spotify`, `system settings`,
  `task manager`, `teams`, `terminal`, `textedit`, `vscode`, `wezterm`,
  `word`, `xcode`). `DOMAIN_MAP` knows about 24 web apps (`amplitude`,
  `asana`, `box`, `canva`, `discord`, `figma`, `github`, `gmail`,
  `google-calendar`, `google-docs`, `google-drive`, `google-sheets`, `gusto`,
  `hex`, `linear`, `monday`, `notion`, `office`, `outlook`, `posthog`,
  `sharepoint`, `slack`, `teams`, `vscode`). Shipped guide JSONs: **3**
  (gmail, outlook, slack). Apps in `APP_ALIASES` with **no** guide: 36 of 39.
  Apps in `DOMAIN_MAP` with **no** guide: 21 of 24.
- **Integration:** agent system prompt sees the human-readable
  `promptFragment`, not the raw step JSON. That's actually correct for an
  LLM-reasons-over-text design.
- **`learnedWorkflows` write/read asymmetry:** there is a write path
  (`learn_app` → `saveLesson`) but no read path. Field is dropped on the
  floor by the live loader.
- **Doc drift:** `guides/README.md` and the 11 root-level JSONs describe a
  loader that no longer exists.
- **Duplicate type:** local `AppGuide` in `guide-loader.ts` shadows the
  canonical one and disagrees about the workflow value shape.

---

## Minimum-change recommendation

The user wants the agent to **reason** over guide data (not run it as a
template), wants clawdcursor to stay app-agnostic in code, and wants more
apps covered. The existing live path already satisfies (a) and (b). It just
needs to be: (i) cleaned of the dead duplicate, (ii) given more data, and
(iii) made discoverable to the model.

A small change set:

1. **Delete `src/llm/guide-loader.ts` and re-home `learn_app`'s persistence**
   into the canonical loader. Steps:
   - In `src/llm/knowledge/loader.ts`, add `saveLearnedSteps(app, workflowKey,
     workflow: AppWorkflow): void` that writes back to the same on-disk file
     `loadGuide(app)` reads from, using the canonical `AppGuide` shape.
   - Update `getWorkflowForTask` to also consult `guide.learnedWorkflows` as
     a *typed* `Record<string, AppWorkflow>` after the hand-crafted match
     misses.
   - Rewire `src/tools/extras.ts:909` to import from `loader.ts` instead of
     `guide-loader.ts`. Also derive an `app` key from `processName` via the
     existing `detectApp` (extend `TITLE_FALLBACKS` for the common desktop
     process names so `Notepad`, `Discord`, etc. resolve).
   - Delete `src/llm/guide-loader.ts`. The dead bug at line 95 goes with it.

2. **Move the eleven root-level `guides/*.json` files into
   `src/llm/knowledge/guides/`, translating them to Schema A.**
   - Each file gains a `name`, optional `domainHints` (or rely on title
     fallback), and its `workflows: Record<string,string>` becomes
     `workflows: Record<string, AppWorkflow>` with one `pressKey` /
     `typeAtFocus` step per directive in the string. Where the existing
     string is too vague to translate, drop it; the LLM has the prompt-level
     fallback already.
   - Delete `guides/` and `guides/README.md`. Add a contributor pointer in
     `docs/app-knowledge.md` (or a new `src/llm/knowledge/guides/README.md`)
     to the new location and Schema A.

3. **Surface the structured workflow alongside the rendered fragment.**
   Right now `getWorkflowForTask` returns `{guide, workflow, promptFragment}`
   but only `promptFragment` makes it past `preprocessor.ts:114`. Forward
   `workflow` (the typed steps) through `decision.hints.guide` →
   `AgentInput.guide` → `buildSystemPromptWithGuide` as an additional
   JSON-tagged block, e.g.:

   ```
   --- APP KNOWLEDGE (from bundled guide / user override) ---
   <readable prompt fragment, as today>

   STRUCTURED WORKFLOW (reference, not a script):
   <JSON of workflow.steps>
   ```

   The agent still reasons; the structured block lets it disambiguate when
   the readable rendering is ambiguous, and gives downstream telemetry (and
   future deterministic-path code) a stable handle on which workflow the
   model was given. Costs one extra block of context.

4. **Loosen workflow keyword matching.** `loader.ts:95-104` is hard-coded to
   eight keys; adding apps means adding entries here. Replace with: read
   `workflow.name` from each workflow, lowercase-match the task against
   either the key or any whitespace-stripped synonym list inside the workflow
   itself. Keeps the data inside the JSON, where the user wants app behavior
   to live.

Nothing above replaces the LLM-as-planner. (1) and (2) consolidate code +
data. (3) gives the planner one more well-typed signal. (4) makes adding the
next app a one-file change.

Optional fast follow: kill `formatGuideForPrompt` + `getGuidePrompt` outright
in (1) and stop bundling `src/llm/guide-registry.ts`'s downloaded shortcuts
into a directory the canonical loader reads from — they have no
`domainHints` and will only match by process-name title fallback, so they
mostly add noise.
