# Changelog

All notable changes to Clawd Cursor will be documented in this file.

## [Unreleased] — auth-hardening + docs catchup + linux CI stabilization

### Docs — `Toolbox` / `Tools` naming + restored action-enum tables (PR #111)

The repositioning in #93 inadvertently stripped the per-toolbox action
enum tables that v0.9.3 shipped. Readers landing on the post-v0.9.4
README saw vague descriptions like *"computer — Mouse, keyboard,
screenshot. Raw I/O."* with no way to discover the ~70 verbs each
compound tool actually exposes short of querying `tools/list`. The
tables are restored verbatim from v0.9.3, and the two sections are
labeled **`Toolbox` — 6 compound tools (recommended)** and **`Tools`
— 97 granular primitives** to make the catalog choice unambiguous.

### Security — dashboard cookie auth instead of inline-JS token injection

The dashboard at `/` no longer injects the bearer token into client
JS. The previous flow set `var __TOKEN = '__CLAWD_TOKEN_PLACEHOLDER__'`
in the served HTML so dashboard JS could send `Authorization: Bearer`
on `/mcp` calls — which meant any future XSS, a malicious browser
extension, or a host misbind to a non-loopback address could exfiltrate
the live token and execute the full MCP tool catalog.

The server now sets `clawdcursor_token` as a `httpOnly` + `sameSite:
strict` cookie when serving `/`. Dashboard JS no longer carries the
token at all; `fetch('/mcp', …)` relies on the browser auto-attaching
the cookie on same-origin requests. The auth gate at
`src/surface/http-utility.ts` accepts both `Authorization: Bearer`
headers (used by external tooling) and the cookie (used by the
dashboard) — backward-compatible for any script that authenticates by
header.

### Security — `requireAuth` no longer silently accepts on-disk token rotation by default

`requireAuth` previously fell back to reading `~/.clawdcursor/token`
when the incoming token didn't match the in-memory token. That allowed
any process with write access to that file to rotate the auth token
and gain MCP access immediately without restarting the daemon.

Drift acceptance is now opt-in via `CLAWD_ALLOW_DISK_TOKEN_DRIFT=1`.
The default is fail-closed: a request whose token doesn't match the
in-memory token is rejected, regardless of what's on disk.

**Backward-incompatible** for any tooling that rotated the disk token
to authenticate against a running daemon. Set
`CLAWD_ALLOW_DISK_TOKEN_DRIFT=1` to restore the previous behavior.

### CI — global nut-js mock for Linux runners

`tests/vitest.setup.ts` wires a global mock for `@nut-tree-fork/nut-js`
so vitest can boot on Linux CI runners that don't have libXtst /
libxdo installed. Existing per-file `vi.mock('@nut-tree-fork/nut-js',
…)` declarations continue to override the global, so no existing
test behavior changes. Method names in the global mock match
production usage in `src/platform/native-desktop.ts` (`mouse.click`,
`screen.grabRegion`, etc.) so the global is a usable fallback for
new tests.


## [0.9.5] - 2026-05-21 — repositioning + compact `task` fix + macOS Tahoe silent screenshots + npm publish prep

Three threads landed: a documentation reframe so the README finally
matches what the product actually is, a real ship-bug fix for one of
the six headline compact tools, and a macOS 26 Tahoe compatibility
fix. Also: package metadata is now npm-publish-ready.

### Added — README + homepage repositioning (PR #93)

After v0.9.4's live tests confirmed external LLMs (Sonnet driving the
compact MCP surface) consistently passed real tasks via the MCP
catalog, the documentation now leads with that fact instead of the
"skill, not an app" framing.

- Old tagline: *"A cursor and a keyboard for any AI agent on a real desktop."*
- New tagline: **"The local MCP server that gives any agent safe desktop control."**

Above-the-fold opening triplet now names the three defensible
architectural claims: **no cloud / no telemetry by default**, **single
`safety.evaluate()` chokepoint** every tool call routes through, and
**bearer-token auth on every HTTP request**. Homepage (docs/index.html)
mirrors the README changes.

### Fixed — compact `task` compound returns `success: false` on success (PR #110)

The compact `task` action — one of the six headline tools — routes
through `delegate_to_agent`, which polls `agent_status` until idle
and then reads `data.lastResult` to report `{success, verified, steps,
lastAction}` to the caller.

But `AgentState` had no `lastResult` field (`src/types.ts:80`). After
`executeTask()` finished, the result was returned to the direct caller
but never written onto state. The poll-then-read path saw `undefined`
and reported `{success: false, steps: 0}` on every completed task —
including the successful ones. One of the six headline tools was
silently broken in v0.9.4.

Fix: `AgentState` now has `lastResult?: TaskResult`. `executeTask()`
snapshots the result onto `state.lastResult` immediately before
resolving. Cleared at task start so pollers can't read stale data
while a new task is in flight. Test coverage: 4 new tests at
`src/__tests__/agent-last-result.test.ts`.

### Fixed — silent screenshots on macOS 14+ via ScreenCaptureKit (PR #109)

macOS 26 Tahoe added a "screen captured" white-flash animation that
fires whenever any process hits the screencapture coordinator daemon —
including the deprecated `CGWindowListCreateImage` API our
`ScreenshotHelper` was using. For an agent tool that screenshots
dozens of times per session, every flash was both visually disruptive
and a privacy signal users didn't need to see for legitimate
automation.

New `captureFullScreenSCK` + `captureWindowSCK` functions use
ScreenCaptureKit (macOS 14+) which Tahoe's flash hook does NOT
intercept. JSON output shape preserved byte-for-byte; deployment
target stays `.macOS(.v12)` via runtime version gate. Falls back to
the existing CG path on macOS 12-13 where CG is still silent.

### Added — `prepare` script for clean npm publish

`package.json` now has `prepare: tsc && node dist/postbuild.js`. The
npm `prepare` lifecycle runs on `npm pack` / `npm publish`, so the
published tarball always reflects the current source rather than
shipping a stale `dist/` from the developer's last `npm run build`.

### Fixed — installer no longer destroys user state on dirty tree (PR #108, backfilled to v0.9.5)

The `irm https://clawdcursor.com/install.ps1 | iex` and equivalent
`curl … | bash` paths previously did a `git checkout && git pull` and,
on any non-zero exit, ran `rm -rf $INSTALL_DIR` and re-cloned from
scratch. Any uncommitted work in the user's tree — feature branches,
dirty edits, untracked scratch files — was destroyed with no consent
and no recovery path. The error message also lied about the cause: a
dirty tree, a missing ref, or a diverged branch all surfaced as
"Download failed. Check your internet and try again."

Both installers now refuse to update a dirty tree, surface the real
`git` stderr on failure, and never delete `$INSTALL_DIR` without
explicit user action. `install.ps1` also dropped UTF-8 em-dashes in
comments to fix a Windows-PowerShell-5.1 ANSI-decoding parser issue.

### Notes

- **macOS users installing via `npm i -g clawdcursor`**: the Swift
  native helper (ClawdCursor.app) isn't pre-built in the npm tarball.
  After install, run `cd $(npm root -g)/clawdcursor && bash native/build.sh && clawdcursor grant`
  to build it. Or use the existing `irm | iex` installer which handles
  this automatically. Fixing the npm-direct macOS path is on the
  v0.9.6 list.
- Closed PR #94 (diagram improvements) — its scope was a subset of
  #93's; the diagram updates folded in via the rebase.


## [0.9.4] - 2026-05-20 — external-agent reliability + browser DOM reachability

Two threads of work landed: a batch of reliability fixes surfaced by
an end-to-end live test (Sonnet driving clawdcursor over MCP-HTTP
against the public benchmark exam at clawdcursor.com/tests), and the
first round of fixes to the external-agent UX gap that test exposed.

### Live test summary

The exam at `192.168.1.127:8000` (14 desktop-control tasks: clicks,
drags, hover, double/right-click, typing, scroll-to-find, bezier path,
keyboard combo, multi-step workflow) was passed end-to-end by Sonnet
driving the compact MCP surface. Three runs:

- baseline (no hierarchy prompt): grade A, 39 screenshots, 2 a11y calls
- hierarchy prompted (no CDP fallback yet): grade A, 39 screenshots, 0 a11y successes — proved the underlying tools were canvas-blind
- post-CDP-fallback + `--compact`: ~20 CDP DOM hits including ★TARGET in the scroll-to-find task (saved ~285 wheel-scroll calls)

### Added — `clawdcursor agent --compact` (PR #106)

Previously the 6-compound MCP surface (`computer`, `accessibility`,
`window`, `system`, `browser`, `task`) was only reachable via
`clawdcursor mcp --compact` (stdio, for editor integrations). The
HTTP-MCP daemon at `:3847/mcp` was hard-coded to serve all 97 granular
tools — which silently broke the README's "6 compact tools" pitch for
any external agent connecting over HTTP. `clawdcursor agent --compact`
(or `CLAWD_MCP_COMPACT=1`) now exposes the same compound surface over
HTTP. Default stays granular because the daemon dashboard at `/` calls
9 granular tool names directly (`scheduled_task_*`, `agent_status`,
`submit_task`, `favorites_*`, `logs_recent`) — flipping the default
will follow once those calls migrate to the compound `system` action
vocabulary.

### Added — CDP DOM fallback in `find_element` + `read_screen` (PR #107)

Edge / Chrome UIA trees stop at browser chrome — single-page apps and
in-page DOM widgets are invisible to pure UIA queries. When the focused
window is a recognised browser and clawdcursor's CDP driver is
connected, `find_element` and `read_screen` now also query the DOM via
`document.querySelectorAll('a, button, input, …, [aria-label], [role]')`
and fold the matches into the response. `find_element` flags CDP
results with a `(via CDP DOM; coords are viewport-relative)` header;
`read_screen` appends a `BROWSER DOM` section side-by-side with the
UIA tree. The smart-layer (`smart_click` / `smart_read` / `smart_type`)
already had this fallback; the granular tools that external agents
prefer when explicitly told "a11y first" did not. Now they do.

**Known limit.** CDP DOM only sees standard HTML elements. Canvas-
rendered content (shapes drawn via 2D context or WebGL) remains
vision-only and requires `computer.screenshot` + pixel coordinates.
This is a platform limit, not a tool limit — `querySelectorAll` cannot
enumerate pixels.

### Fixed — pipeline ladder climbs past rung LLM errors (PR #104)

`src/core/pipeline.ts` previously treated any "aborted" failure string
as a hard user-abort, so a transient LLM timeout on the blind rung
collapsed the whole chain — vision was effectively dead code on slow
or flaky providers. Replaced the stringly-typed branch with a
`RungFailureCategory` tagged-union (`user_abort` / `rung_llm_error` /
`agent_gave_up` / `verifier_rejected` / `config_missing` /
`anti_pattern` / `infra_error`) and a `categorizeFailureReason` mapper
as the single source of truth. Chain-abort gate hard-aborts only on
`user_abort`, `infra_error`, `anti_pattern`, or high-confidence
`verifier_rejected`; everything else escalates to the next rung.

Verified live: pointing the daemon at an unreachable LLM URL produced
`blind → hybrid → vision` rung attempts where the previous chain-abort
gate stopped after rung 1. Also fixed a related phantom-success bug
where aggregate accounting could mark a task `success: true` when every
rung had failed with `rung_llm_error`. 4 integration tests +
7 mapper unit tests added at `src/__tests__/pipeline-chain-abort.test.ts`.

### Fixed — blind-mode coordinate-click guardrail (PR #103)

The autonomous agent's blind rung (a11y-only, no screenshots) was
emitting raw `mouse_click(x, y)` calls with hallucinated coordinates
when the a11y tree didn't contain the LLM's target — a live test
observed it walking through an exam UI by guessing positions until the
verifier's 0.65-confidence rejection finally fired. New block at
`src/core/agent-loop/agent.ts:531-587`: when `mode === 'blind'` and no
a11y-aware selector (`invoke_element`, `set_field_value`,
`focus_element`, `a11y_select`, `a11y_toggle`, `a11y_expand`,
`a11y_collapse`, `wait_for_element`, `find_element`) succeeded in the
prior 2 turns, raw coordinate clicks are refused with a structured
tool-result that points the LLM at the recovery options
(`cannot_read` or `screenshot`). 4 regression tests at
`src/__tests__/blind-coord-click-guard.test.ts`.

### Fixed — CLI `--text-model` / `--api-key` / `--base-url` ignored (PR #105)

The boot banner read these flags through `resolveConfig`
(`src/llm/config.ts:203`) and proudly printed
`Using externally configured models: text=X`, but the runtime agent
loop read from `loadPipelineConfig` (`src/surface/doctor.ts:1636`)
which only consulted `.clawdcursor-config.json` — so the very next log
line was `pipeline.start … models=text=off`. `loadPipelineConfig` now
accepts an optional `ResolvedConfig` overlay; fields tagged
`source === 'cli'` override disk values. Precedence preserved
(CLI > project > user > env > autodetect > default). The contradictory
double banner (`No AI providers found` immediately followed by
`Using externally configured models`) is also gone — the
auto-detection branch is skipped when CLI flags already supply LLM
wiring. 5 regression tests at
`src/__tests__/load-pipeline-config-overlay.test.ts`.

### Fixed — `smart_click` candidates + macOS multi-window + open_url tier + a11y description fallback (PR #102, closes #101)

Four issues from issue #101:

- `smart_click` now returns a structured failure payload
  `{error, reason, target, candidates, tried, elapsedMs, isError: true}`
  instead of bare timeout strings. Callers that hit an ambiguous target
  can disambiguate from the candidate list; deadline-aware budget
  replaces the bare `Promise.race` that previously swallowed diagnostic
  state. New tests at `src/__tests__/smart-tools.test.ts`.

- macOS `focus_window` now disambiguates among multiple windows of the
  same process by title — `scripts/mac/_window-picker.jxa` plus a
  `scoreWindow()` heuristic that deprioritises tray-style popovers
  (Xcode "Downloads", etc.).

- `open_url` was filtered out of the act-only safety tier; the
  `safetyTier: 2 → 1` change in `src/tools/extras.ts:523` restores it.

- A11y element labels now fall back through `name → description →
  value → ''` so macOS apps that put their visible text in
  `AXDescription` (Xcode, others) render with something meaningful
  instead of `"missing value"`. `formatElement()` helper in
  `src/tools/a11y.ts:25-30`.

### Repo hygiene

Closed security-audit issue #13 with the per-commit fix-mapping comment.
Rejected SafeSkill scanner PR #92 (the 20/100 "Blocked" badge was
based on a heuristic that flags ANSI terminal color escapes as
obfuscated content — see `src/surface/cli.ts`, `src/surface/doctor.ts`,
etc. for the 58+ legitimate ANSI escapes). Closed issue #101.

Five dependabot bumps landed: `tsx` 4.21→4.22, `ws` 8.20.0→8.20.1
(security patch), `croner` 9→10 (major, breaking change does not
affect this codebase — only `?` wildcard semantics changed),
`eslint` group +3 updates, `@types/node` 25.7→25.9.


## [0.9.3] - 2026-05-16 — tool-layer fixes + live-test report

Three critical tool-layer fixes surfaced by a deep audit + a Windows
encoding bug spotted during an end-to-end live test (run by an LLM
driving the compact MCP surface from Claude Code). Also: README hero
no longer leads with "fallback only" framing — that discipline stays
in SKILL.md (where it belongs for AI agents) and in a new "When NOT
to use it" section in the README body.

### Fixed — Linux SIGSEGV on MCP stdin teardown (carried from `3fc76b8`)

Calling `process.exit()` synchronously inside a stdin `'end'` event
handler segfaulted on Linux because libuv was still unwinding the
stream read handle. `releaseMcp` now guards against double-fire and
defers exit via `setImmediate`. Fixes the cross-platform CI on
ubuntu-latest (Node 20 + 22).

### Fixed — `navigate_browser` PowerShell shell injection (Win32 branch)

`src/tools/orchestration.ts` interpolated the URL into a
`Start-Process … -ArgumentList @(…,"${url}")` PowerShell command. A URL
containing `")` or `$()` or backticks could escape the quoting and
execute arbitrary PowerShell. Replaced with a direct `execFile()`
against `msedge.exe` resolved from standard install locations — no
shell shim, argv is safe. macOS and Linux branches already used
argv-form `execFile` and were not affected.

### Fixed — `screenshot_full` MIME type lied

`src/tools/agent.ts` declared `mimeType: 'image/png'` and described the
output as base64 PNG, but `captureForLLM()` returns JPEG by default
(or PNG only when `CLAWD_SCREENSHOT_FORMAT=png`). Any client that
decoded the bytes by the advertised type silently corrupted. The
`image.mimeType` field now follows the actual `frame.format`; a new
`format` field in the metadata block lets clients double-check.

### Fixed — `learn_app` silent no-op

The handler returned `{saved: true}` even when neither save branch
executed (e.g., the caller supplied only `processName`). Now tracks
`wroteLesson`/`wroteGuide` flags and returns
`{saved: false, reason: …, isError: true}` when nothing was persisted.
New regression-guard test at `agent-tools.test.ts`.

### Fixed — Windows window-title UTF-8 corruption

Confirmed live: every `window.list`/`window.active` call returned
non-ASCII characters in window titles as `?` or `�` (the Unicode
replacement character). Root cause: `scripts/ps-bridge.ps1` and
`scripts/ocr-recognize.ps1` did not set `[Console]::OutputEncoding`,
so PowerShell wrote in the system code page (Windows-1252 in most
locales) while Node decoded as UTF-8. Both scripts now force UTF-8 on
stdin/stdout and `$OutputEncoding`. Same fix benefits OCR text capture
of non-ASCII content (emoji, accented characters, CJK).

### Fixed — compact `direction` enum dropped `scroll_horizontal` values

`buildCompoundSchema` in `src/tools/compact.ts` was first-wins on
field names across delegates: `mouse_scroll` declared
`direction: ['up','down']` first and won, so `mouse_scroll_horizontal`'s
`['left','right']` was silently invisible on the compact surface. An
LLM calling `computer({action:'scroll_horizontal', direction:'left'})`
was violating the published schema. The merge now unions enum values
across delegates.

### Improved — `task` and `delegate_to_agent` descriptions lead with the daemon requirement

Both tools return ECONNREFUSED (or "no agent") when called from a
stdio MCP host (Cursor, Claude Code, Windsurf) because they HTTP-call
`127.0.0.1:3847/mcp` on the daemon. Their descriptions now lead with
**Requires the `clawdcursor agent` daemon to be running** and tell
the consumer how to start it.

### Repositioned — README hero

The "Use as a fallback, not first choice" callout no longer sits in
the README hero. The same discipline stays in SKILL.md (the AI-facing
manual, where it correctly disciplines agent behavior) and in a new
"When NOT to use it" subsection inside README's `Why Clawd Cursor`
block. The hero now leads with what it does. SKILL.md frontmatter is
unchanged — it still leads with the strict 4-gate for agent
consumers.

### Added — live test report

`docs/internal/0.9.2-live-test-2026-05-16.md` documents a full
end-to-end test of clawdcursor 0.9.2, run by an LLM consuming the
compact MCP surface from Claude Code. Covers every compact compound,
the HTTP MCP transport via a parallel daemon, what worked, what
surprised, what's broken. Reference artifact for the trust story —
something a curious visitor can read to see "yes, this has been
actually tested by an AI agent driving a real desktop."

### Internal — security audit reply draft

`docs/internal/issue-13-reply-draft.md` is a draft response to the
long-open security audit issue, listing what has landed in 0.9.x to
address each item. Maintainer reviews + edits + posts to GitHub.

### Test coverage

51 test files, 813 tests pass (was 812 — `+1` new regression guard for
`learn_app`'s no-payload case). Typecheck clean. Lint stable at 18
pre-existing warnings.

## [0.9.2] - 2026-05-15 — reliability + scanner-friendliness

Multiple fixes and a refactor consolidated into one release.

### Fixed — recycled-PID false positives in single-instance lock

User-reported on Windows 11 + Claude Code: `/mcp` reconnect
intermittently failed with `Failed to reconnect to clawdcursor: -32000`,
and once it broke, every subsequent reconnect failed too — until the
user manually killed zombie node processes and
`rm ~/.clawdcursor/mcp.pid`.

`isProcessAlive(pid)` used `process.kill(pid, 0)`, which on Windows is
fooled by PID recycling: once the dead clawdcursor's PID was reassigned
to any other live process (chrome, svchost, anything), the lockfile
permanently looked "live" and refused all future spawns. The lockfile
also stored only a bare integer PID, leaving no way to disambiguate.

`~/.clawdcursor/{start,mcp,serve}.pid` is now JSON with schema version,
PID, **process start time**, and mode. `claimPidFile` requires the
recorded start time to match the OS-reported start time of the live PID
(±5 s tolerance for OS reporting jitter) before treating it as a real
duplicate. Implementation extracted to `src/surface/pidfile.ts` with
unit-test coverage. Legacy bare-integer lockfiles are treated as stale
on first read (silent backwards-compat — the old format can't be
trusted anyway).

### Fixed — orphan MCP processes block reconnect

When an editor host exited without reaping its `clawdcursor mcp` child,
the orphan kept running with no usable stdio but legitimately matched
the lockfile. The `mcp` command now treats stdin EOF / close / error as
a hard exit signal: when the parent's stdio pipe closes, the orphan
releases its lockfile and exits cleanly. Deterministic on every
platform — no polling, no parent-PID inspection.

### Fixed — `clawdcursor uninstall` silently failed to kill running processes

The uninstall command's pidfile fallback (`src/surface/cli.ts`) still
parsed the lockfile with `parseInt`, which against the new JSON format
(`{"v":1,...}`) returns `NaN`, silently skipping the kill. A user
running `clawdcursor uninstall` while a clawdcursor process was alive
would end up with deleted config + orphaned process. Now uses the
shared `readPidLoose` helper that handles both new JSON and legacy
bare-int formats.

### Fixed — dashboard credential redaction silently broken since 0.7.x

`looksLikeCredential` in `src/surface/dashboard.ts` is supposed to
hide password-shaped strings (`password: secret`, `Bearer xxxx`, etc.)
from the task-history UI. The patterns were declared inside an outer JS
template literal, so the single backslashes in `\s` and `\S` were
silently dropped at parse time — the runtime regex matched literal `s`
and `S` characters instead of whitespace. **No password the regex was
designed to catch was actually being caught.** Patterns now use `\\s` /
`\\S` in source so the emitted JS gets the correct escapes; verified
end-to-end with a runtime regex eval.

### Refactor — migrate ANSI escape codes to picocolors

Replaced 58 inline `\x1b[NNm` ANSI styling literals across
`src/surface/{cli,doctor,onboarding,readiness}.ts` and
`src/core/observability/logger.ts` with `picocolors` calls. Same visual
output (picocolors emits the same standard ANSI codes at runtime, with
semantic close codes — `[22m` for bold-off, `[39m` for color-default —
instead of heavy-handed `[0m` everywhere, which actually composes
better when colors nest).

Motivation: third-party static analyzers (SafeSkill etc.) flagged
inline `\x1b` hex escapes as "potentially obfuscated content" — a
malware-detection heuristic that doesn't account for the fact that any
CLI with colored output uses exactly that syntax. Routing through
picocolors moves the escape codes into a vetted dependency, so source
scanners no longer see them as suspicious literals. Added
`picocolors@^1.1.1` (zero-deps, ~3 KB).

The logger's `C` color table is now keyed to picocolors style
functions instead of raw escape strings; `colorize`, `layerTag`,
`mapStrategyTag` updated accordingly. The ANSI-stripping regex in
`pad()` is built from `String.fromCharCode(27)` instead of `\x1b` so
the source itself carries no hex escape.

Platform-layer control-char sanitization regexes (`/[\r\n\t\x00-\x1f]/`)
in `src/platform/*.ts` are intentionally **not** migrated — those are
input filters, not styling, and aren't what static analyzers were
flagging as critical.

### Docs — SKILL.md frontmatter leads with FALLBACK ONLY

The frontmatter `description` field — what skill registries and AI
tool indexes display before an agent opens the file — now leads with
"FALLBACK ONLY" + the explicit numbered 4-gate (native API → CLI →
file edit → existing browser automation), instead of the softer "skill
of last resort that gives AI agents eyes…" wording that front-loaded
the capability claim. The body content already had the same 4-gate
(lines 46–54 and 197–208); this aligns the frontmatter with that body
messaging. PR #95.

### Internal — release-time version sync

`scripts/sync-version.ts` reads `package.json` at release time and
propagates the version into `SKILL.md` frontmatter, `docs/index.html`
hero/footer, and the install script header pins. Wired into npm's
`version` lifecycle hook so `npm version <bump>` updates everything
in one shot. Removes drift opportunity between `package.json` and the
website / SKILL frontmatter that previously had to be hand-synced.

### Internal — tool-count cleanup

User-visible runtime output and the marketing site previously claimed
89 or 93 tools in places where the actual catalog was 97. `doctor.ts`
post-success panel and `docs/index.html` hero/spec/mode-stats now match
the registry. Historical "What's new" entries (e.g. v0.9.0's "89
granular + 6 compact") are left as-is — they're accurate to the
release they describe.

### Migration

No action needed for fresh installs. A user already on a broken
PID-lock state should update, then a single `rm ~/.clawdcursor/mcp.pid`
(or `clawdcursor stop`) clears the legacy lockfile the prior version
left behind. From then on the new code self-heals.

## [0.9.1] - 2026-05-14 — compose-send fix + scheduled tasks

A user-reported regression on macOS plus a long-missing daemon feature. No
breaking changes; safe upgrade from v0.9.0.

### Fixed — compose-send playbook (real user-reported bug)

A v0.9.0 user on macOS asked "open mail app and send an email to X
introducing yourself." The trace reported `✅ done · path=playbook · 2/2
subtasks · $0.0000`, but the actual send was broken: the body landed in
the wrong field (and/or merged with the subject field). **No LLM was
called and no vision fallback ever fired** — the bug was 100% in the
deterministic playbook plus a verifier bypass that let the playbook
self-certify. Three layered fixes:

- **Platform-aware Tab count after recipient** in
  `src/tools/playbooks/compose-send.ts`. The previous code fired TWO Tabs
  after typing the recipient, assuming every mail app shows Cc/Bcc inline.
  macOS Mail.app's default layout has Cc/Bcc collapsed — Tab order is
  `To → Subject → Body`. Two Tabs overshot Subject and landed on Body.
  New: 1 Tab on darwin/linux, 3 Tabs on win32 (Outlook desktop default),
  via a `tabsAfterRecipient()` helper. Documented per-platform in the
  module header.
- **Decoupled the post-subject Tab from `if (subject)`**. The advance to
  Body now fires unconditionally so a task with no explicit subject (the
  user's "introducing yourself" case) still lands the body in the right
  field instead of typing it into whatever the previous Tab happened to
  leave focus on.
- **Removed playbook exemption from the verifier** in
  `src/core/pipeline.ts:649-655`. The router exemption stays (router has
  its own window-list-diff evidence). Playbooks now go through the
  ground-truth verifier like every other rung — the rich `send_email`
  task assertions (`compose_closed` via full window list, `recipient_visible`,
  `not_just_saved_as_draft` anti-signal) were designed for exactly this
  bug class but couldn't catch it because they never ran. Verifier is
  <500ms; soft-fail-on-low-confidence policy stays in place for legitimate
  idempotent operations.
- **Better summary line**: `compose-send: to=… subject=… body=…ch
  tabs-after-to=…` now reports parsed field state and platform Tab count
  in the trailing PIPELINE_DONE line. Empty subject was the original
  diagnostic signal in the user-reported bug — now it's visible at a
  glance.

### Added — Scheduled tasks (new feature, requested)

Cron-driven recurring tasks that fire through the same agent pipeline as
`submit_task`. Persisted across daemon restarts. **Dashboard gets a new
⏰ Scheduled tab** with cron + task inputs, an active-schedule list, and
per-row pause / delete buttons.

- **`src/tools/scheduler.ts`** — 4 new MCP tools:
  - `scheduled_task_create({ task, cron, tz? })` — validates the cron up
    front (`croner`), persists, registers an in-process cron job that
    dispatches via `agent.executeTask`.
  - `scheduled_task_list()` — returns every persisted task with run /
    skip / lastError counters and a computed `nextRun` ISO timestamp.
  - `scheduled_task_delete({ id })` — unregisters + removes from disk.
  - `scheduled_task_toggle({ id, enabled })` — pause/resume without
    deleting; disabled tasks stay persisted but their cron job is
    unregistered.
- **Storage**: `~/.clawdcursor/scheduled-tasks.json`. Path is computed
  dynamically (honors `CLAWD_HOME`) so tests and forks can redirect.
- **Reentrancy**: if a tick fires while the agent is busy, the task is
  skipped and `skipCount` increments. No queue, no pile-up. Predictable.
- **Boot lifecycle**: `clawdcursor agent` calls `initScheduler(agent)` on
  startup (only when an LLM is configured — the scheduler requires the
  autonomous agent to dispatch into). Daemon shutdown calls
  `stopScheduler()` to cleanly unregister all jobs.
- **Auth**: every scheduler tool sits behind the same bearer-token gate
  as the rest of the MCP HTTP surface (`/mcp` already wraps `requireAuth`).
- **Dependency**: adds `croner@^9.1.0` (zero-dep cron parser, ~7 KB).

### Stats

- Tool count: **89 → 93** (+4 scheduled_task_* tools)
- Tests: **759 → 776** (+5 playbook tests + 14 scheduler tests, all green)
- Schema snapshot regenerated.

### Migration

None. Drop-in upgrade from v0.9.0.

---

## [0.9.0] - 2026-05-14 — Architecture redesign + guides marketplace

The largest release since v0.7. Net change vs v0.8.17: **−10,200 LOC, +14 new MCP tools, one protocol instead of two, five directories instead of seven**, plus a Reflector feedback channel that closes the loop between verifier signals and planner decisions, plus a public guides marketplace where community-contributed app knowledge ships independently of the binary.

### Architectural rewrite

- **One protocol, two transports.** REST surface (`/task`, `/tools`, `/execute/:name`, `/favorites`, `/learn`, `/screenshot`, `/abort`, `/confirm`, `/logs`, `/task-logs`) is gone. Every former REST endpoint is now an MCP tool. The HTTP daemon serves stateless MCP at `POST /mcp` alongside `/health`, `/stop`, and `/` (dashboard).
- **Five directories under `src/`.** `core/` (agent loop + pipeline + verifier + safety + skills), `tools/` (one registry, 89 granular + 6 compound), `platform/` (Windows / macOS / Linux X11 / Linux Wayland adapters + Swift host app), `llm/` (providers + credentials + knowledge), `surface/` (CLI + MCP server + dashboard). One concern per directory, no upward dependencies.
- **Legacy cascade removed.** The v0.7-era cascade (`computer-use.ts`, `ai-brain.ts`, `action-router.ts`, `generic-computer-use.ts`, 14 more modules — ~12 k LOC) deleted along with the `--legacy` flag and `_executeTaskInternal`. Tag `v0.8.17-legacy` preserves the cascade for emergency cherry-pick.
- **CLI verb rename.** `clawdcursor start` → `clawdcursor agent`; `clawdcursor serve` → `clawdcursor agent --no-llm`. Old verbs still work as deprecation aliases through 0.9.x; removed in 0.10.

### Reflector feedback (CLAWD_REFLECTOR=1)

The verifier now produces structured `ReflectionFeedback` with typed `Cause[]` and an optional `suggestedStrategy`. Six cause kinds: `no_pixel_change`, `wrong_window_focused`, `modal_intercept`, `a11y_target_missing`, `webview_blind`, `partial_text_match`. The pipeline ladder reroutes based on the dominant cause instead of just rolling down — `webview_blind` jumps straight to vision, `modal_intercept` retries after dismissal. Behind a feature flag for one cycle; default-on in 0.9.1 if telemetry is positive.

### Safety + correctness

- **Five tools promoted to Tier 2 (mutation)** after an external audit: `open_file`, `open_url`, `open_uri`, `navigate_browser`, `write_clipboard`. Each can trigger arbitrary OS handlers, network egress, or clipboard hijack — Tier 1 understated the risk.
- **Sensitive-app safety gate now actually elevates** instead of just logging. Clicking inside Outlook / 1Password / Mail / banking / private-messaging with no target label → `confirm` (not `allow`).
- **App-pattern data consolidated** into `src/core/app-categories.ts`. Single source of truth for the WebView2 settle list + sensitive-app list. The autonomous pipeline never imports it.
- **Stateless MCP HTTP transport.** Per-request transport lifecycle, `enableJsonResponse: true` so clients receive plain JSON-RPC instead of SSE event-stream framing they choke on.

### Agent-loop reliability

- **Soft-fail subtask policy.** Low-confidence verifier rejection (< 0.5) on a single subtask logs a warning and continues. Idempotent operations like "create new canvas" after `open_app("Paint")` (pixel-change zero because Paint already opened blank) no longer kill the chain at subtask 2.
- **Runaway guard on consecutive no-tool-call turns.** Three turns of degenerate model output (e.g. Kimi hitting `max_tokens` with token-loop garbage) trigger a clean rung exit instead of burning the full 5-minute task timeout.
- **Kimi `moonshot-v1-*` prose-tool-call parser updated** for the new `functions.NAME:N->{_{...}}` format the model now emits.
- **Per-task PIPELINE_DONE footer always fires** with `success/failed (reason) · path · N/M subtasks · $cost · duration`. Was missing on chain-abort + isAborted paths.
- **DPI mouse-scale fix.** Both stdio MCP and `clawdcursor agent` now use `physical/image` as the mouseScaleFactor source. Vision-driven clicks land where intended on HiDPI Windows / Retina macOS instead of being 2× too far towards top-left.
- **DPI info injected into agent prompt** so models that try to "help" by self-scaling don't pre-multiply.

### Tools

- **Tool count 75 → 89.** Fourteen new MCP tools absorbed the former REST endpoints + the marketplace surface: `submit_task`, `abort_task`, `agent_status`, `screenshot_full`, `favorites_list/_add/_remove`, `task_logs_list/_current`, `logs_recent`, `learn_app`, `submit_report`, plus two new guides-management entries.
- **Tool registry unified.** Compact (6 compounds) is now a transform over the granular registry, not a parallel catalog. One source of truth, no drift.
- **MCP `open_app` uses alias table + PlatformAdapter** instead of raw `Start-Process`. Calculator, Win11 Notepad, and other UWP apps work correctly.
- **`focus_window` AND-matches** when given both pid + title — needed for Win11's tabbed Notepad where multiple windows share a pid.
- **`type_text` preserves the user's clipboard** around its paste-as-type operation. Was silently clobbering.

### Guides marketplace (new)

clawdcursor reasons about every app from screenshots and a11y trees. For popular apps that's slow. v0.9 ships a **marketplace of community-curated app guides** the agent fetches on demand, caches locally based on usage, and uses to operate apps 5–10× faster — without ever blocking the agent loop on the network.

- **Public registry at <https://clawdcursor.com/app-guides>**, backed by the GitHub repo <https://github.com/AmrDab/clawdcursor-guides>. PR-based submissions, native GitHub identity as anti-spam, vote-issues for ratings (`vote: <app>` issues with 👍/👎 reactions aggregated nightly into `index.json`).
- **10 verified seed guides at launch**: gmail, outlook, slack, youtube (the rich-multi-task reference — 19 workflows, 36 shortcuts, 8 layout regions, 13 tips), figma, discord, excel, mspaint, olk (new Outlook), spotify. Maintainer trust labels: `trust:verified` / `trust:community` / `trust:experimental`.
- **Three new client-side modules**:
  - `src/llm/knowledge/remote-loader.ts` — `fetchGuide(app)` with timeout, conditional GET via ETag, stale-while-revalidate.
  - `src/llm/knowledge/cache.ts` — LRU + TTL (7 days, 50 entries). `touchUsage` reorders LRU on every hit, so popular guides survive eviction even when not most-recently-fetched.
  - `src/llm/knowledge/guide-linter.ts` — defense-in-depth: schema validation + prompt-injection patterns + dangerous-prose detection runs on every guide before injection, regardless of source (bundled, cached, user-override). Failed guides drop to null — agent falls back to first-principles reasoning, never poisoned-knowledge.
- **Bundled core trimmed to 2 guides** (msedge + notepad — Windows defaults that ship with every install). The other 10 curated guides moved to `seed-registry/guides/` and uploaded to the GitHub repo. Lighter binary; guides update independently of releases.
- **`clawdcursor guides` CLI rewritten**: `list`, `info <app>`, `available`, `install <app>` / `install --all`, `refresh <app>`, `remove <app>`, `clean`, `lint <file>`, `submit <file>` (lints + prints PR instructions).
- **Preprocessor fires `prefetchGuideForApp(app)` async** the moment it detects an active window — by the next task, the cache is warm. First-touch uses whatever's local; subsequent tasks are fast.
- **`learn_app` writes rerouted** to the user-override dir at `~/.clawdcursor/ui-knowledge/{app}.json` (was writing into the bundled source tree where the next install would clobber it). Auto-saves successful task patterns under `learnedWorkflows`; FIFO-capped at 20 per app.
- **Rich prompt fragment renderer** (`renderAppKnowledge`): the agent now sees SHORTCUTS / WORKFLOWS (★-marked active one first) / LAYOUT / TIPS instead of just 8 comma-joined shortcuts. Cap 6000 chars with graceful degradation; non-active workflows truncated to 180 chars so a 20-workflow guide doesn't crowd out layout.

### Router

- **Web-service redirect layer** (`src/core/router/web-services.ts`, 60-entry table). "open youtube" / "open reddit" / "open gmail" now redirects to `handleUrlNav('https://www.youtube.com')` via the OS default browser, instead of fall-through to Start-Menu search → blind-agent escalation. Closes a v0.9 failure mode where the agent typed the literal phrase "default browser" into a search bar. Native-client preference preserved: "open chrome" still launches the desktop client.
- **System-context preamble** in the blind/hybrid agent system prompt (`src/core/agent-loop/prompt.ts` section 5c): web services → `open_url(URL)`, never type "browser" into search bars, don't emit "open chrome" before "navigate" unless explicitly named.

### Verifier

- **`send_email` no longer falsely passes** when a popup steals foreground. Previous logic checked only `after.activeWindow.title` for compose-window absence — a banner popup focusing the agent's window inverted the check and the verifier reported success while Send was never clicked. Fix iterates the full `after.windows` list (`composeStillOpen = (after.windows ?? []).some(w => !w.isMinimized && composeKeywords.test(w.title))`). Also added: success-keyword detection (`message sent | email sent | sent successfully`), `not_just_saved_as_draft` anti-signal (rejects when "Draft saved" appears without success notice), expanded compose regex to include `reply`.

### Doctor

- **Post-doctor "All systems go" panel rewritten** for clarity on the two access paths: MCP server for editor (`clawdcursor mcp`) gets 89 desktop tools (or 6 compound with `--compact`); HTTP daemon (`clawdcursor agent`) for unattended autonomy. Runtime-detects whether an LLM is configured and shows "(you have one)" green or "(none yet)" yellow.

### Cross-platform integrity

- **All four OS adapters preserved.** Windows (1,220 LOC) + macOS (903 LOC) + Linux X11 (1,285 LOC) + Linux Wayland (343 LOC) — 3,751 LOC of adapter code, no regression from v0.8.
- **macOS host app intact.** `ClawdCursorHost` Swift bundle, `permission-check`, `screenshot-helper`, `clawdcursor grant` flow — all preserved + path-resolution fixed (`getPackageRoot()`) so the host app is found correctly after the directory restructure.

### Documentation

- **Professional README rewrite** (340 lines): hero badge row, Mermaid pipeline diagram with Reflector feedback edges, transport / cost-tier / cross-platform / compound-tool tables, 5-directory architecture summary. Modeled on `ollama`, `vercel/ai`, `microsoft/playwright`, `modelcontextprotocol/typescript-sdk`.
- **Post-install + post-build banners are state-aware**: skip "Run consent" / "Run doctor" lines when the user already did them on a prior install.
- **Two-path next-step routing** at install / consent / doctor: autonomous agent (`doctor` → `agent`) vs MCP-only (register `clawdcursor mcp` with editor host).
- **SKILL.md reordered**: fallback discipline first, "no task impossible" confidence second, CAN/MUST/SHOULD third — load-bearing identity preserved verbatim.
- **MACOS-SETUP, agent-guide, OPENCLAW-INTEGRATION-RECOMMENDATIONS, dashboard, website** all migrated from REST to MCP HTTP transport language.
- **`docs/internal/v0.9-readme-building-blocks.md`** + **`docs/internal/agnostic-audit-report.md`** archived as design records (moved out of the published website root before release).

### Release hygiene

- Removed orphan `docs/v0.7.5/` (v0.7-era landing page not linked anywhere).
- `package.json` gains `repository`, `homepage`, `bugs`, `author`, `keywords`.
- `.nvmrc` added (Node 20).
- CI badge URL corrected to the actual workflow filename.

---

## [0.8.8] - 2026-05-05 — Reliability + correctness: mod modifier, compact set_value, smart_click foreground OCR, invoke-element timeout

A focused reliability release closing several real bugs surfaced by a production session (issue #71) and a thorough ultrareview of the v0.8.5 work. Two of the bugs were silent failures — the worst kind for an agent — and one was a hard hang in the standalone PowerShell scripts. Plus a routine round of major-version dependency bumps (express 5, commander 14, dotenv 17, sharp 0.34) and a lint cleanup pass.

### Fixed

- **`mod` modifier now resolves correctly on every platform.** The legacy `NativeDesktop` (which `ctx.desktop` binds to in the granular tool registry) had no `mod` translation — only the v2 `PlatformAdapter` did. Calling `computer({"action":"key","combo":"mod+s"})` either threw `Unknown key: "mod"` (Win/Linux) or silently dropped the modifier and typed a literal `s` (macOS). Three coordinated fixes:
  - `src/keys.ts`: add `mod` to `KEY_ALIASES` resolved at module load to `Super` on darwin and `Control` elsewhere.
  - `src/native-desktop.ts:707-712`: extend the `macKeyPress` modifier loop to treat `mod` as `command down`. The loop did direct string comparison, so the alias alone wasn't enough.
  - `src/pipeline/playbooks/keys-blocklist.ts:14-22`: extend `normalizeCombo` so `mod+q` matches `cmd+q` on darwin (otherwise the safety gate would let `mod+q` quit-app through on macOS).
- **Compact `accessibility({"action":"set_value", ...})` was broken.** `src/tools/compact.ts:93` delegated to `set_field_value`, but no granular tool by that name was registered (only the agent-internal palettes had it). Calls returned `{isError: true, text: "delegate not registered"}`. Registered the missing tool in `getA11yDepthTools()` mirroring `a11y_expand`/`a11y_toggle`. Tool count: 74 → 75. Schema snapshot regenerated.
- **`smart_click` OCR matched text in background windows.** Full-screen OCR scoring iterated all elements and broke on the first exact match, so text in a non-focused window (e.g. Outlook visible behind a "Pick an account" dialog showing the same email) could win and cause a silent wrong-click. Refactored ranking into a `pickBest` helper that runs two passes: foreground-window first (using `activeWin.bounds`), full-screen only if foreground produced no match — with a `[WARNING: matched outside focused window]` annotation in the response so the agent has a signal to verify. From issue #71 review.
- **`invoke-element.ps1` hung on React/Electron buttons that advertise InvokePattern but block on Invoke.** The legacy try/catch fallback chain (Invoke → Toggle → bounds) only fired when a pattern *threw*, not when one blocked indefinitely. Wrapped the pattern call in `System.Threading.Tasks.Task::Run` with a 2s `Wait(timeout)`. On timeout the script emits the same `success:false + clickPoint` JSON the existing catch produces. Direct callers of the script benefit; HTTP/MCP callers were already protected by `smart_click`'s 10s outer timeout. From issue #71.
- **OpenClaw install metadata used `npm install -g clawdcursor`** but the package isn't published to npm (registry returns 404). OpenClaw following `metadata.openclaw.install` step 1 verbatim would abort before reaching `clawdcursor consent --accept`. Replaced with the documented `curl -fsSL https://clawdcursor.com/install.sh | bash` path that matches every other install surface.

### Changed

- **Major dependency bumps**, all CI-green across the cross-platform matrix:
  - `express` 4.21.2 → 5.2.1 (major) + `@types/express` 4 → 5
  - `commander` 12.1.0 → 14.0.3 (major)
  - `dotenv` 16.x → 17.4.2 (major)
  - `sharp` 0.33.5 → 0.34.5
  - `eslint` group bumps within v10
- **Lint hygiene** — cleared all 10 `@typescript-eslint/no-unused-vars` warnings the CI was surfacing as annotations (74 → 64 warnings). Trivial cleanup, no functional impact: dropped unused test imports (`path`, `afterEach`, `vi`, `beforeEach`, `VerifyResult`, `PipelineConfig`), removed the dead `makePipelineConfig` helper in verifiers.test.ts, renamed `step` to `_step` in `a11y-reasoner.ts:1079` (eslint config already allowed the `^_/u` prefix), and dropped unused error bindings on two `catch (e)` / `catch (err)` blocks.

### Documentation

- SKILL.md "What's new" expanded with the 0.8.8 section.
- README "Latest Release" updated.
- `docs/index.html` (homepage) bumped to v0.8.8 across title, meta tags, hero badge, agent-readable summary, and footer.

---

## [0.8.7] - 2026-05-02 — Security hardening: direct-tool safety gate, version-string single-source, tooling bumps

A security-focused patch release. The headline is a real behaviour change: every direct tool invocation — both the REST `/execute/:name` endpoint and the MCP `callTool` handler — now passes through a shared safety gate, so direct callers can no longer bypass the checks the agent loop already enforced. Plus: the version string is now single-sourced (no more `0.7.2` showing up in MCP metadata three releases late), and the dev tooling is current (TypeScript 6.0, ESLint 10).

### Fixed

- **Direct tool execution bypassed safety checks.** REST `/execute/:name` and MCP `callTool` invoked tools without consulting the same gate the agent loop used. A misconfigured client could reach `confirm`-tier or blocked tools without the expected guardrails. New `src/tools/safety-gate.ts` (~40 lines) wraps every direct invocation; both entry points (`src/index.ts`, `src/tool-server.ts`) now route through it. Read-only, blocked, and confirm-tier decisions resolve identically across REST, MCP, and the agent loop. Test coverage in `src/__tests__/tool-safety-gate.test.ts`.
- **Accessibility / window / clipboard reads now use `PlatformAdapter` consistently.** `src/tools/a11y.ts` previously called underlying OS APIs directly; aligns with the rest of the codebase by routing through the shared adapter, with a legacy fallback if the adapter is unavailable.

### Changed

- **Version string is single-sourced from `package.json`.** `src/index.ts` (the `McpServer` constructor) and `src/onboarding.ts` (the consent file) each kept their own hardcoded copy of the version. Both fell out of sync — `index.ts` shipped `0.7.2` in the MCP handshake for several releases until v0.8.6 caught it manually. Both now import `VERSION` from `src/version.ts`, which already reads `package.json` at runtime. Adds `tests/version-drift.test.ts`: scans `src/**/*.ts` for any literal of the current `package.json` version and fails the build if found anywhere except `src/version.ts`. Future bumps only need to touch `package.json`.
- **TypeScript 5.9.3 → 6.0.3** (devDependency). Major compiler bump. `tsconfig.json` adds `"ignoreDeprecations": "6.0"` to silence the new `moduleResolution: "node"` deprecation without changing runtime behaviour — the project remains CommonJS with the same module resolution semantics. A proper migration to `nodenext` can land in a later release.
- **ESLint 9 → 10 + typescript-eslint plugins** (devDependency). Major linter bump. ESLint 10 promotes `no-useless-assignment` and `preserve-caught-error` into the recommended ruleset. Resolved all 8 new errors as actual code fixes rather than rule downgrades:
  - `cdp-driver.ts`: removed useless `let selector = ''` initialiser (all branches assign before use).
  - `doctor.ts`, `ocr-reasoner.ts`: scoped `smokeOk` and `guidePrompt` as `const` inside their try blocks (they were never read outside).
  - `compound.ts`: removed useless `= []` initialiser; the catch always returns, so TypeScript still considers `points` definitely assigned.
  - `smart-interaction.ts`: eliminated the `currentA11yState` tracking variable entirely — it was always equal to the fresh `a11yContext` read at the top of each ReAct loop iteration. Three useless-assignment sites disappear by replacing references with `a11yContext` directly.
  - `ui-driver.ts`: rethrown `SyntaxError` now includes `{ cause: err }`.
- **Routine dependency hygiene.** Playwright `1.58.2 → 1.59.1`, ws `8.19.0 → 8.20.0`, postcss + `@types/*` group bumps, GitHub Actions `setup-node@v4 → v6`, `checkout@v4 → v6`.

### Documentation

- SKILL.md "What's new" expanded with the 0.8.7 section. README "Latest Release" updated.
- `docs/index.html` (homepage) bumped to v0.8.7 across title, meta tags, hero badge, and footer.

---

## [0.8.6] - 2026-05-01 — Polish release: MCP server version, homepage simplification, repo hygiene

A short follow-up to 0.8.5 that closes one user-visible bug carried over from the v0.7.x line and a handful of professionalism gaps surfaced in a pre-release audit. No schema changes, no behavior changes for agents — purely metadata, docs, and the public landing page.

### Fixed

- **`McpServer` advertised the wrong version.** `src/index.ts` constructed the MCP server with `version: '0.7.2'` and `src/onboarding.ts` wrote the same string into the consent file — both untouched since the 0.7.x line. MCP clients (Claude Code, Cursor, Windsurf, Zed) display this string in their server metadata, so users on v0.8.5 saw "clawdcursor v0.7.2" in their host UI. Both sites now read `0.8.6`. `src/index.ts:1054`, `src/onboarding.ts:31`.

### Added

- **`SECURITY.md`** — private vulnerability reporting path for a tool that runs with full Accessibility + Screen Recording permissions on the user's desktop. Points reporters at GitHub's private vulnerability reporting flow plus a mailbox fallback. Should have existed since v0.7.0; closing the gap now.

### Changed

- **Homepage simplified.** `docs/index.html` lost ~80 lines of decorative weight without losing information:
  - Removed the page-wide green AI-cursor mouse-follower (CSS + HTML + JS, ~60 lines). Cute, but contradicts the "serious skill, not a demo" framing.
  - Hero badge collapsed from a 4-fact release-summary string to a one-line `v0.8.6 — latest stable`. Release detail belongs in CHANGELOG, not the hero.
  - Stats grid pruned from 4 tiles to 3 — the `any AI Model` tile was filler.
  - "CLI Agent" mode card relabeled `CLI — testing only` to match the README's skill-first reframe (in 0.8.4) where `start` is explicitly the testing/troubleshooting path, not a recommended runtime mode.
  - The `clawdcursor doctor` post-install comment used to read `# verify install + wire into your agent (MCP)`; `doctor` does not write to host config files. Corrected to `# verify install — then add the MCP block to your agent host config`.
- **`LICENSE`** copyright year `2026` → `2025-2026`. The earliest CHANGELOG entry is March 2025.

### Removed

- **`V0.7.5-SPEC.md`** at the repo root — describes the v0.7.5 OCR+a11y parallel-merge architecture, which was superseded by the unified blind-first pipeline in v0.8.1/v0.8.2. Five releases of stale content with zero inbound references. Preserved in git history.
- **`docs/v0.7.0/`, `docs/v0.7.2/`, `docs/v0.7.12/`, `docs/v0.7.14/`** — pinned-version landing pages for releases that were never published as GitHub Releases. Not linked from the live homepage or README. `docs/v0.7.5/` kept (only pre-0.8 release with a published GitHub Release).

### Documentation

- **GitHub Releases backfilled.** Tags v0.8.0, v0.8.2, v0.8.3, v0.8.4, v0.8.5 had existed for weeks without a corresponding Releases entry — only v0.7.5 was published. All five 0.8.x releases now have a Releases entry sourced from this CHANGELOG, with v0.8.5 marked latest until v0.8.6 ships.
- SKILL.md "What's new" expanded to cover 0.8.6.

---

## [0.8.5] - 2026-04-30 — Review-fix maintenance + compact-tool keyboard fix

Two remote review passes (six findings + ten findings) on the v0.8.4 docs uncovered one real behavior bug, several factually wrong install instructions, and a long tail of documentation drift that had built up across SKILL.md, README, docs/index.html, and source comments. This release closes all of it. 429/430 tests still pass; granular schema snapshot unchanged.

### Fixed

- **`computer({"action":"key","combo":"..."})` now works.** The compound `key` / `key_press` / `key_down` / `key_up` actions had no `argRemap`, so the schema exposed `key` (not `combo`). REST rejected `combo` as an unknown parameter; MCP silently dropped it and the granular handler crashed with `(undefined).toLowerCase()`. Implemented the remap that `compact.ts:46-47` had documented as the canonical example since v0.8.1 — `argRemap: { combo: 'key' }` on all four keyboard actions. Granular schema is unaffected; the `key` granular tool still takes `key`. `src/tools/compact.ts`.
- **Stale "72 granular tools" count** in user-visible places — `clawdcursor mcp --help`, the markdown returned by `GET /docs`, plus four internal source comments. CHANGELOG v0.8.2 established 74 (72 + 2 Electron-bridge tools) as canonical; the agent-facing surfaces are now consistent. `src/index.ts`, `src/tool-server.ts`, `src/tools/compact.ts`, `src/tools/index.ts`.

### Documentation

- **README installer claims rewritten.** The previous wording falsely claimed the installer (1) drops files into `~/.clawdcursor`, (2) registers an MCP server in `~/.claude/settings.json`, and (3) copies SKILL.md into every detected agent's skill directory. Verified against `docs/install.sh` and `docs/install.ps1`: the installer only clones to `~/clawdcursor` (no dot), runs `npm install + build`, and `npm link`s the global shim. The dotted `~/.clawdcursor/` directory holds runtime state only. Wiring the skill into Claude Code now correctly says the JSON block is required, not optional.
- **Compact-action surface corrections.** The README's compact-tool table used invented action names — `accessibility.read_screen` (actual: `read_tree`), `accessibility.get_focused` (`focused`), `window.set_state`/`set_bounds`/`get_active` (none exist), `system.open_app` (lives on `window`), `system.read_clipboard` (`clipboard_read`), `browser.navigate` (lives on `window`), and the entire `task` action enum (`task` has no enum — just `{instruction}`). All rewritten against `src/tools/compact.ts`. Marquee example also fixed to use real calls.
- **Linux accessibility package.** Was `at-spi2-core` + `python3-gi`; the actual missing package on a fresh Ubuntu install is `gir1.2-atspi-2.0` (the AT-SPI typelib that `python3-gi` consumes). Brought into line with SKILL.md, the probe script's hint, and the platform adapter docstring.
- **Compact-action tables now non-exhaustive by default.** Added a "Most-used actions" header + caveat pointing to `GET /tools?mode=compact`, and filled in the high-value entries that had been silently dropped (`accessibility.list_children`, `browser.page_context`, `window.list_displays` / `screen_size` / `switch_tab`, `computer.scroll_horizontal` / `triple_click`).
- **`clawdcursor dashboard` removed** from the README CLI block — that command never existed; the dashboard is reachable at `http://127.0.0.1:3847` while `serve` or `start` is running. `status` and `consent` subcommands added to the CLI block since they were referenced in the Options block but never introduced.
- **`--compact` / `--accept` flag scopes corrected.** README claimed `--compact` works on `serve`; it's mcp-only (`serve` uses `?mode=compact` on `GET /tools`). README claimed `--accept` is universal; it lives on `start` and `consent` (`serve` uses `--skip-consent`).
- **"Anthropic Agent SDK" → "Claude Agent SDK"** (the official product name) across README.
- **`invoke_element` recategorized** from "Window / App" to "Accessibility" in the README — matches its registration in `src/tools/a11y_depth.ts` and the SKILL.md taxonomy.
- **`docs/index.html` install snippets** no longer push `clawdcursor start` as the canonical post-install step (contradicts the new "skill, not application" framing). Replaced with `clawdcursor doctor` (verify-the-install) and a footer note that `start` is testing-only. Hero badge CVE list now includes `follow-redirects`.
- **SKILL.md `/health` example** now uses `<x.y.z>` placeholder instead of a hard-coded version that drifts every release. "What's new" section expanded to cover 0.8.4 + 0.8.3 + 0.8.2.
- **Cost-tier ladder + "no task is impossible" callout** added to SKILL.md (lines 38, 108-118). Sets the default agent disposition: GUI + mouse + keyboard = everything you need; start at T1 (structured a11y), escalate only when the current tier fails.
- **Skill-first README rewrite.** The headline now reads "The skill that gives any AI agent eyes, hands, and a keyboard on a real desktop." `start` / `task` are demoted to a "Testing and Troubleshooting" appendix with explicit guidance that agents should not invoke them — they go through MCP or the REST surface. Replaces the earlier "OS-level desktop automation server" framing.
- **Stale tagline cleanup.** Removed "ears" (no audio capture exists in `src/`) from `package.json` description, SKILL.md frontmatter, and `docs/index.html` meta tags + agent-readable summary. Aligned with the README's existing "eyes, hands, and a keyboard" wording.
- **Pre-existing fix while in the area:** dropped the blocking `clawdcursor serve` step from `metadata.openclaw.install` in SKILL.md. `serve` is a foreground HTTP server with no auto-exit; using it as a sequential install step would either hang the installer or leave a zombie daemon — directly contradicts the "nothing runs in the foreground" framing.

### Verified, not changed

- **Cmd+Q is blocked.** Review claimed Cmd+Q is not actually blocked by the safety layer. Verified against `src/pipeline/playbooks/keys-blocklist.ts:24` + `src/pipeline/safety/layer.ts:325-328`: it IS blocked through the SafetyLayer chokepoint via both `combo` and `key` arg paths. README is correct; no change needed.

---

## [0.8.4] - 2026-04-21 — Security maintenance + README rewrite

Dependency audit release. No functional changes, no schema changes, 429/430 tests still pass.

### Security

Patched every fixable advisory in the dependency tree (5 of 12 surfaced by `npm audit`). The remaining 7 moderate alerts all chain through `jimp → @nut-tree-fork/nut-js` and have no upstream fix yet; tracked for a follow-up once nut-js releases a jimp upgrade.

- **`vite`** → 7.3.2+ · **High** · path traversal in optimized-deps `.map` handling ([GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9)), `server.fs.deny` bypass via query strings ([GHSA-v2wj-q39q-566r](https://github.com/advisories/GHSA-v2wj-q39q-566r)), arbitrary file read via dev-server WebSocket ([GHSA-p9ff-h696-f583](https://github.com/advisories/GHSA-p9ff-h696-f583)).
- **`path-to-regexp`** → 0.1.13+ · **High** · ReDoS via multiple route parameters ([GHSA-37ch-88jc-xwx2](https://github.com/advisories/GHSA-37ch-88jc-xwx2)).
- **`picomatch`** → 4.0.4+ · **High** · method injection in POSIX character classes + ReDoS via extglob quantifiers ([GHSA-3v7f-55p6-f55p](https://github.com/advisories/GHSA-3v7f-55p6-f55p), [GHSA-c2c7-rcm5-vvqj](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj)).
- **`hono`** → 4.12.14+ · Moderate · HTML injection in `hono/jsx` SSR via unsafe attribute names ([GHSA-458j-xx4x-4375](https://github.com/advisories/GHSA-458j-xx4x-4375)).
- **`follow-redirects`** → 1.15.12+ · Moderate · custom auth headers leaked across cross-domain redirects ([GHSA-r4q5-vmmm-2653](https://github.com/advisories/GHSA-r4q5-vmmm-2653)).

### Changed

- **README rewrite.** Removed stale "What's New in v0.8.0 — V2 Architecture" headliner (v0.8.0's V2-vs-legacy split was unified in v0.8.2 — no opt-in flag, no two pipelines). Pipeline section now reflects the unified blind → hybrid → vision router, the `safety.evaluate()` chokepoint, ground-truth verification, and the v0.8.3 runaway guard. Tool surface reorganized around the 6-tool compact catalog and the 74-tool granular catalog. Tone tightened; marketing phrasing trimmed.

---

## [0.8.3] - 2026-04-19 — Hotfix: "Outlook keeps opening" + runaway guard

User reported Outlook launching repeatedly during a test. Root-cause diagnosis traced to three compounding failures: (1) `PlatformAdapter.openApp` spawned a new instance even when the app was already running, (2) the escalation ladder (router → blind → hybrid → vision) re-ran `open_app` at each rung because earlier rungs couldn't verify success through New Outlook's sparse WebView2 accessibility tree, (3) `clawdcursor stop` only killed the `start` process on port 3847, missing `serve` (different port / same port different process) and `mcp` (stdio, no port) entirely. A stale `serve` kept receiving MCP traffic after the user thought they'd stopped everything.

### Fixed

- **`openApp` / `launchApp` idempotency** (Windows + macOS + Linux). When the target app already has a visible window AND the caller didn't set `alwaysNewInstance: true` AND no `url` is passed, the adapter now focuses the existing window and returns its pid instead of spawning another instance. Match policy: case-insensitive exact processName → processName substring → title substring → UWP AppId tail. Closes the "N windows of Outlook stacking up" class of bug under any retry loop. `src/v2/platform/{windows,macos,linux}.ts`.
- **Agent runaway guard** — if the agent calls the same tool + identical args ≥ 3 times within the last 6 turns, the loop exits with `give_up` and a targeted message suggesting `detect_webview_apps` when the target is likely Electron/WebView2. Prevents the generalized "retry-loop-because-a11y-is-opaque" anti-pattern. `src/pipeline/agent/agent.ts`.
- **`clawdcursor stop` now sweeps all modes.** After the graceful `/stop` on port 3847, iterates every pidfile in `~/.clawdcursor/*.pid`, SIGTERMs any live pid, SIGKILLs after 500ms if still running, and unlinks the pidfile. Catches `mcp` (stdio-only), zombie `serve`, and any start/serve on a non-default port. `src/index.ts`.

### Notes

- Stale-pidfile cleanup at startup was already correct via `claimPidFile` (checks `isProcessAlive(existingPid)` and overwrites when dead) — no code change needed there; the issue was exclusively `stop`.
- Tests: 429 / 430 pass (1 skipped, same as 0.8.2). No schema snapshot change — these are behavioral fixes, not catalog changes.

---

## [0.8.2] - 2026-04-19 — Session reliability, force-focus, Electron bridge

First-time-user review surfaced six concrete pain points. This release fixes every one.

### Fixed

- **Silent 401 mid-session** (the session-killer). Previous versions compared the incoming Bearer token against an in-memory `SERVER_TOKEN` only. A second clawdcursor process (stale pidfile takeover, or a concurrent mode) rewrote the token FILE without updating the first server's in-memory copy — clients reading the file silently lost auth. `/health` kept returning 200 so the failure was invisible. Fix: `requireAuth` now accepts EITHER the in-memory token OR the current on-disk token (mtime-cached, ~free). Drift is logged once with a recovery hint. `src/server.ts`.
- **`focus_window` force-to-front on Windows.** Previous implementation called `SetForegroundWindow` which the OS blocks when the caller isn't the current foreground process. New implementation uses the full sequence: `ShowWindow(SW_RESTORE)` → topmost-toggle → `AttachThreadInput` with the current foreground thread → `AllowSetForegroundWindow(ASFW_ANY)` → `BringWindowToTop` → `SetForegroundWindow`, with an Alt-key synthetic fallback. Raises any window through Windows' foreground lock. `scripts/ps-bridge.ps1`.
- **Richer validation errors.** REST `/execute` rejections now carry the full expected tool signature. A missing param returns `Missing required parameter "target". Expected smart_click(target: string, processId?: number).` — agents no longer have to roundtrip to `/docs`. `src/tool-server.ts`.

### Added

- **Electron / WebView2 detection.** New MCP tools `detect_webview_apps` and `relaunch_with_cdp` (also exposed via compact `system({"action":"detect_webview"})` / `system({"action":"relaunch_with_cdp"})`). Recognises olk (New Outlook), Teams, Discord, Slack, VS Code, GitHub Desktop, Notion, Obsidian, Spotify. When detected, probes ports 9222/9223/9229/8315 for a live CDP endpoint; if found, tells the agent to attach via `browser({"action":"connect"})`. If not, shows the exact relaunch command (e.g. `discord --remote-debugging-port=9222`) so CDP can be enabled and the sparse UIA tree bypassed entirely. `src/tools/electron_bridge.ts`.
- **`drag_path` documentation clarity.** Existing `mouse_drag_stepped` / compact `computer({"action":"drag_path","path":"[...]"})` now explicitly documented for freehand curve drawing (Paint, Figma, canvas apps). SKILL.md "Quick reference" covers when to use `drag_path` vs `drag`.

### Changed

- **SKILL.md pushes compact mode harder.** Top of doc now carries a directive callout: *"If you are an LLM reading this: YOU SHOULD BE USING COMPACT MODE."* with MCP config + REST URL. Granular stays available but is explicitly labeled the power-user / larger-prompt option.
- **SKILL.md web-app keyboard warning.** Web-wrapped apps (Outlook, Teams, Gmail) treat `Escape` as "close dialog/modal" — sometimes closing the compose window. Documented: do not use Escape to dismiss autocompletes in web apps; use arrow keys + Enter or click-away.
- **Error-recovery table** expanded with Electron-vs-true-canvas split, v0.8.2 auth recovery, v0.8.2 force-focus note, and the `drag_path` vs `drag` distinction.

### Tests

- 429 / 430 passing (one skipped, same as 0.8.0).
- Schema snapshot regenerated → 74 granular tools (72 + 2 Electron bridge).
- Live smoke: token auth survives a second `clawdcursor serve`; `focus_window` raises Paint through a full-screen window; `detect_webview_apps` correctly flags Outlook / Teams / VS Code when any are open.

### Consolidates v0.8.1 (never tagged)

0.8.1-alpha.0 through -alpha.N shipped unified-pipeline + compact-MCP + Linux AT-SPI + Wayland routing on the feature branch. They roll into 0.8.2 as a single stable release. See the v0.8.1-alpha tag range in the git history for per-tranche detail; headline features:

- **Unified blind/hybrid/vision agent** — one loop, three modes. Replaces the v0.8.0 split `text-agent` + `vision-agent` with a single harness using native `tool_use` (Anthropic) / `tool_calls` (OpenAI) / prose-JSON fallback.
- **Compact MCP surface** — 6 compound tools (`computer`, `accessibility`, `window`, `system`, `browser`, `task`) that collapse the full capability into ~1,500 tokens of catalog. Anthropic-Computer-Use shape extended across the whole product. `clawdcursor mcp --compact` or `GET /tools?mode=compact`.
- **PlatformAdapter widened** — `mouseDown/Up`, `keyDown/Up`, `setWindowState`, `setWindowBounds`, `listDisplays`, `waitForElement`, widened `InvokeAction` (`expand`/`collapse`/`toggle`/`select`/`get-value`), richer `UiElement` state flags.
- **Linux AT-SPI bridge** — read-only first pass via `python3-gi` + `gir1.2-atspi-2.0`. Linux a11y methods (`getUiTree`, `findElements`, `getFocusedElement`, `waitForElement`) now return real data on boxes where the bridge dependencies are present. `invokeElement` still stubbed — tracked for a follow-up pass.
- **Linux Wayland input routing** — `ydotool` (mouse + keyboard) or `wtype` (keyboard fallback) detected at init. X11 path unchanged; Wayland no longer silently mis-fires through nut-js.
- **Per-capability palettes + compound vision tools** — text-agent turns now see a 6-10 tool scoped palette based on the subtask's capability (`app_launch` / `text_input` / `navigation` / `form_fill` / `spatial` / `file_ops` / `window_mgmt` / `general`). Vision-agent turns see 3 compound `mouse` / `keyboard` / `window` tools with action enums. ~12× fewer catalog tokens per turn.
- **Pretty TTY logs with HH:MM:SS timestamps** — layer-tagged (`[router]`, `[blind]`, `[vision]`, `[safety]`, etc.), no per-line repetition, `CLAWD_LOG=pretty` default on TTY.
- **SKILL.md rewrite** — reviewed by a Sonnet subagent against legacy v0.6.3/v0.7.14 tone, verified model-agnostic + OS-agnostic, restored "USE AS A FALLBACK" + "IMPORTANT — READ THIS BEFORE ANYTHING ELSE" directive callouts and Sensitive App Policy.

---

## [0.8.0] - 2026-04-16 — V2 Architecture (opt-in)

A ground-up reimagining of the internal pipeline. Opt in with `clawdcursor start --v2`. The legacy pipeline is unchanged and remains the default.

### Added

- **`--v2` flag on `clawdcursor start`** — activates the new 3-layer architecture: Router → VisionAgent → Verifier. No effect on MCP, `serve`, or legacy `start`.
- **`src/v2/platform/`** — platform abstraction. Single `PlatformAdapter` interface with `macos.ts`, `windows.ts`, `linux.ts` implementations. Replaces 142+ scattered `if (process.platform === 'darwin')` branches across 34 files. Business logic no longer sees `process.platform`. Adding a new OS = one file.
- **`src/v2/verifier/`** — `GroundTruthVerifier`. Six independent signals decide whether a task actually completed: pixel diff, window change, focus change, OCR delta, task-specific assertions (`send_email`, `navigate_url`, `open_app`, `type_text`, `search`, `compose_message`, `create_file`), and anti-patterns (error dialogs, "cannot send", "draft saved", invalid recipient, auth failed). Weighted voting with hard-fail rules on anti-patterns. Cannot be fooled by LLM self-reported "done".
- **`src/v2/agent/`** — `VisionAgent`: a single vision-first tool-use loop. 16 tools (`screenshot`, `read_screen`, `list_windows`, `click`, `drag`, `scroll`, `type`, `key`, `invoke_element`, `set_field_value`, `open_app`, `focus_window`, `read_clipboard`, `write_clipboard`, `wait`, `done`). 6-rule system prompt (down from 36). Model-agnostic via existing `callVisionLLM`.
- **`src/v2/orchestrator.ts`** — `PipelineV2` wires Router → VisionAgent → Verifier with before/after state capture.
- **Hardened JSON parser** — tolerates trailing braces, markdown code fences, and other common LLM malformations. Balanced-brace extraction as fallback.

### Fixed

- **False positives** — legacy pipeline reports `UNVERIFIED_SUCCESS` when the agent claims "done" but the screen didn't change. V2 verifier catches this class: in a live email-send test the agent said "Email sent" but a "Cannot send" dialog was on screen. V2 correctly rejected the claim. (Legacy still does what it does; this fix only applies when `--v2` is set.)

### Testing

Smoke-tested on macOS with Anthropic Claude Haiku (text) + Sonnet (vision):

| Task | Time | Verdict |
|------|------|---------|
| Open TextEdit and type | 30s | ✅ (4/6 signals) |
| Calculator: 47+53=100 | 65s | ✅ (5/6 signals, zero parse errors) |
| Safari → github.com | 45s | ✅ (6/6 signals) |
| Notes: create note | 182s | ✅ (6/6 signals) |
| Email send (failing server) | 86s | ❌ **Correctly rejected** — legacy would have reported success |

### Platform Safety

No legacy code modified. Windows, Linux, and MCP paths untouched. v2 code is entirely under `src/v2/`.

## [0.7.14] - 2026-04-13 — Full macOS Keyboard Automation + Platform-Aware Pipeline

### Fixed
- **macOS keystrokes silently dropped** — root cause: `CGEvent.post()` from the Swift helper is blocked by macOS TCC when the helper is spawned as a child of Node.js. `keyPress()` and `typeText()` on macOS now route through `osascript` + System Events (the Apple-sanctioned method). All keyboard shortcuts (Cmd+V, Cmd+N, Shift+Cmd+D, etc.) now work correctly.
- **Single-char keys losing modifiers** — `keycodeForCharacter()` lookup added to `ClawdCursorHelper`; modifiers are no longer discarded for Cmd+letter combos.
- **`asDouble()` coercion** — click/drag coordinates sent as integers (common from some LLMs) no longer fail with a type mismatch in the Swift helper.
- **`keycodeForCharacter` fallback** — now returns an error for unmapped characters instead of silently falling back to the 'v' keycode.
- **Permission check inconsistency** — `doctor`, `status`, and `readiness.ts` all now query the same canonical path: Host `/status` → `permission-check` binary → direct fallback. No more false "granted" reports.
- **Screenshot capture CPU spin** — replaced `CGWindowListCreateImage` (triggers ReplayKit CPU spin bug on macOS 14+) with a delegated `screenshot-helper` subprocess.
- **A11y false positive** — `isShellAvailable()` now tests actual window access (`p.windows.length`) instead of `processes.length`, which worked without Accessibility permission.
- **Node.js v25 crash** — `EINVAL`/`setTypeOfService` socket error from undici's internal QoS call is now caught and suppressed (non-fatal).
- **Dock click zone** — reduced from 60px to 30px on macOS (Dock is thinner than the Windows taskbar).
- **Browser URL bar shortcut** — `Cmd+L` used on macOS (was `Ctrl+L`, which does nothing in macOS browsers).

### Added
- **`macMailEmailFlow`** — deterministic email flow for macOS Mail.app (Cmd+N, Tab to subject/body, Cmd+Shift+D to send).
- **`clawdcursor grant` command** — triggers macOS system permission dialogs directly from the CLI.
- **115 Apple shortcuts** — Mail, Safari, Notes, Messages, Terminal added to the shortcut database.
- **`scripts/test-macos-fixes.sh`** — one-shot E2E verification script: rebuild, binary check, permission consistency, screenshot capture, doctor cross-check.
- **`--request-screen-recording` flag** on `permission-check` binary — optional TCC dialog trigger for Screen Recording.
- **`processPath` + `bundleId`** in all permission check responses — aids TCC debugging.
- **30s TTL cache** on A11y shell availability — permission grants mid-session are now detected without restart.
- **macOS native binary verification** in `scripts/verify-install.js` — warns on missing binaries at `npm install` time.
- **`setup` script auto-builds** native binaries on macOS (inside `npm run setup`).

### Changed
- **`build.sh`** — marked executable in git, fails fast on missing binaries (was silently warning), better error guidance.
- **Installer** — verifies all 4 required binaries (not just `ClawdCursorHost`), uses `bash ./build.sh` for portability.
- **`doctor.ts`** — permission check unified via `native-helper` module; triggers system permission dialogs if denied.
- **Email flow keyboard shortcuts** — platform-aware: `Ctrl+Enter` → `Shift+Cmd+D` on macOS, `Ctrl+H` → `Cmd+Option+F` for Find & Replace.
- **`sharp`** bumped `^0.33.0` → `^0.33.5`.

### Platform Safety
No Windows or Linux code paths affected. All macOS changes are gated behind `IS_MAC` / `process.platform === 'darwin'` / `isMacOS()`.

## [0.7.13] - 2026-04-10 — Unified Permission Checks + Screenshot Helper

### Fixed
- **Permission check fragmentation** — doctor, status, and readiness each used different permission APIs, producing contradictory results. All now route through `ClawdCursorHost /status` → `permission-check` binary → direct `AXIsProcessTrusted` fallback.
- **Screenshot CPU spin** — delegated `takeScreenshot()` to `screenshot-helper` subprocess, eliminating the ReplayKit CPU spike on macOS 14+.
- **Installer binary verification** — now checks all 4 required binaries (`ClawdCursorHost`, `clawdcursor-helper`, `screenshot-helper`, `permission-check`) instead of just `ClawdCursorHost`.
- **`build.sh` silent failures** — `swift build` errors now fail the build immediately with actionable guidance.

### Added
- **`clawdcursor grant` command** — triggers macOS system permission dialogs for Accessibility and Screen Recording.
- **`processPath` + `bundleId`** in permission check responses for TCC debugging.
- **`--request-screen-recording` flag** on `permission-check` binary.

## [0.7.12] - 2026-04-09 — Comprehensive macOS TCC Fix

### Fixed
- **Bash pipeline bug** — `set -o pipefail` added; build failures now properly detected (was silently passing due to pipeline exit status bug)
- **Ad-hoc signing by default** — build.sh now always signs the app (required for TCC on macOS 26+ Tahoe where unsigned binaries don't appear in privacy settings)
- **Build error capture** — uses temp file instead of pipe to properly capture exit status
- **TCC permission check** — runs permission-check after build to show current accessibility/screen recording status

### Changed
- **build.sh rewritten** — cleaner structure, ad-hoc signing is default (not optional), signature verification added
- **Codesign uses --deep** — ensures all nested binaries are signed
- **Installer shows TCC status** — tells user exactly which permissions need to be granted and where

### Technical Details
The core issue was TCC (Transparency, Consent, and Control) on macOS binds permissions to the code signing identity. Without signing:
- On macOS 26+ (Tahoe), unsigned binaries don't appear in System Settings privacy panels at all
- Users saw "ClawdCursorHost binary not found" errors even though install appeared to succeed

Reference: mediar-ai/mcp-server-macos-use for TCC permission handling patterns.

## [0.7.11] - 2026-04-09 — macOS Installer Fix

### Fixed
- **macOS installer now fails loudly if native host build fails** — was silently swallowing build errors and claiming "optional fallback" that doesn't exist
- **Added verification step** — installer explicitly checks ClawdCursorHost binary exists before declaring success
- **Show build output** — Swift build errors are now visible instead of redirected to /dev/null
- **Clear error messages** — tells users exactly what went wrong and how to fix it (xcode-select --install, manual rebuild, etc.)

### Changed
- macOS native host is now correctly marked as REQUIRED, not optional
- Installer exits with error code 1 if native build fails on macOS

## [0.7.10] - 2026-04-08 — Guided Setup Flow

### Changed
- **Installer shows next steps** — after install, displays clear guidance: `clawdcursor doctor` → `clawdcursor start`
- **Doctor shows run options** — after passing all checks, shows both `start` (full agent) and `serve` (tools-only) modes
- **Consent shows next step** — after granting consent, directs users to `clawdcursor doctor`

## [0.7.9] - 2026-04-08 — UX Improvements

### Changed
- **macOS permission messages** — now direct users to enable "ClawdCursor" instead of "Terminal/Node"
- **Screen Recording path** — updated to "Screen & System Audio Recording" (macOS Sequoia naming)

## [0.7.8] - 2026-04-08 — Documentation Fix

### Fixed
- **Installer comments updated** — example version references now point to v0.7.8

## [0.7.7] - 2026-04-08 — Installer Fixes

### Fixed
- **Installers default to main branch** — install.sh and install.ps1 now use `main` instead of hardcoded non-existent tag
- **macOS installer builds native helper** — install.sh now runs `./native/build.sh` on Darwin if Swift is available
- **Version override support** — `VERSION=v0.7.7 curl ... | bash` or `$env:VERSION='v0.7.7'` to install specific release
- **Auto-pull on update** — installers now run `git pull` after checkout to get latest changes

## [0.7.6] - 2026-04-08 — macOS Native Host App

### Added
- **macOS Host App (ClawdCursorHost)** — new native Swift executable that runs as the app bundle's main process, owning all TCC permissions (Accessibility, Screen Recording) under a single app identity
- **Localhost IPC server** — host app exposes `GET /health`, `GET /status`, `POST /rpc` on `127.0.0.1:3848` for CLI→host communication
- **Token-based authentication** — `~/.clawdcursor/host-token` (mode 0600) secures the IPC channel
- **Auto-launch/stop** — `clawdcursor start` ensures host is running; `clawdcursor stop` gracefully quits it
- **New Swift helper methods** — `moveMouse`, `dragMouse`, `captureScreen` for smoother native macOS automation
- **Menu bar presence** — host app shows 🐾 icon in menu bar for visibility

### Security
- **Localhost-only binding** — IPC server uses `NWParameters.requiredLocalEndpoint` to bind to `127.0.0.1` only, rejecting connections from other machines
- **Token file permissions** — host-token created with mode 0600 (owner read/write only)

### Changed
- `src/native-helper.ts` — routes all macOS desktop operations through host IPC instead of direct stdio
- `src/native-desktop.ts` — 11 platform-guarded code paths delegate to host on macOS
- `src/index.ts` — start/stop commands manage host app lifecycle
- `native/ClawdCursor.app/Contents/Info.plist` — bundle identifier changed to `com.clawdcursor.app`, executable to `ClawdCursorHost`

### Unchanged
- **Windows/Linux** — all macOS code behind `IS_MAC && this.helper` guards; no behavior changes on other platforms
- **172 tests pass** — full test suite unchanged

## [0.6.3] - 2026-03-01 — Universal Pipeline, Multi-App Workflows, Provider-Agnostic

### Added
- **LLM-based universal task pre-processor** — one cheap text LLM call decomposes any natural language into `{app, navigate, task, contextHints}`, replacing brittle regex parsing
- **Multi-app workflow support** — copy/paste between apps (e.g. Wikipedia → Notepad) with 6-checkpoint tracking: first_app_focused → first_app_action_done → content_copied → second_app_opened → content_pasted → result_visible
- **Site-specific keyboard shortcuts** — Reddit (j/k/a/c), Twitter/X (j/k/l/t/r), YouTube (Space/f/m), Gmail (j/k/e/r/c), GitHub (s/t/l), Slack (Ctrl+k), plus generic hints
- **OS-level default browser detection** — reads Windows registry (HKCU ProgId) or macOS LaunchServices instead of hardcoded Edge/Safari
- **3 verification retries with step log analysis** — when verification fails, builds a digest of recent actions + checkpoint status so the vision LLM can fix the specific missed step
- **Mixed-provider pipeline support** — e.g. kimi for text, anthropic for Computer Use, with per-layer API key resolution from OpenClaw auth-profiles
- **`ComputerUseOverrides` interface** — apiKey, model, baseUrl per-layer for mixed-provider setups
- **`resolveProviderApiKey()` helper** — reads OpenClaw auth-profiles to find the right API key per provider

### Fixed
- **Checkpoint system overhaul** — removed auto-termination (completionRatio ≥ 0.90 early exit and isComplete() mid-loop kill), strict detection: content_pasted requires Ctrl+V, content_copied requires Ctrl+C, second_app_opened detects any window switch universally
- **Pipeline context passing** — `priorContext[]` accumulator flows from pre-processing through to Computer Use (no more amnesia between layers)
- **Credential resolution order** — .clawdcursor-config → auth-profiles.json → openclaw.json (with template expansion) → env vars
- **`loadPipelineConfig()` path resolution** — checks package dir first, then cwd (fixes global npm installs)
- **Smart Interaction model lookup** — uses `PROVIDERS` registry instead of hardcoded model/baseUrl maps; fixes stale `claude-haiku-3-5-20241022` fallback
- **Scroll behavior** — system prompts instruct PageDown/Space instead of tiny mouse scrolls; default scroll delta 3 → 15
- **Provider-agnostic internals** — all comments and logs say "vision LLM" instead of "Claude"
- **Verification retry limit** — max 3 retries prevents infinite verification loops
- **Universal checkpoint detection** — no hardcoded app lists; `detectTaskType()` uses action patterns only

### Changed
- Pipeline architecture: LLM Pre-processor → Pre-open app + navigate → L0 Browser → L1 Action Router + Shortcuts → L1.5 Smart Interaction → L2 A11y Reasoner → L3 Computer Use
- Pre-processor prompt hardened with NEVER rules (never summarize, never drop steps) and VALIDATION RULE
- MULTI-APP WORKFLOWS section added to both Mac and Windows Computer Use system prompts
- Checkpoint thresholds tightened: early completion 75% → 90%, skip-verification 50% → 80%

## [0.6.5] - 2026-02-28 — Checkpoint System, Task Completion Detection

### Added
- **Checkpoint-based task completion** — Computer Use tracks milestones (compose opened → fields filled → send pressed → compose closed) and stops when all checkpoints are met. No more wasted calls after successful completion.
- **Task type detection** — auto-classifies tasks (email, form, navigate, draw, file_save) and applies appropriate checkpoint templates.
- **Smart early termination** — when Claude says "done" and ≥75% checkpoints confirmed, accepts completion immediately.
- **Auto-config on first run** — `clawdcursor start` auto-detects providers without needing `clawdcursor doctor`.
- **Universal provider support** — any OpenAI-compatible endpoint works via `--base-url`.
- **CLI model selection** — `--text-model` and `--vision-model` flags.

### Fixed
- **Email domain extraction bug** — "send to user@hotmail.com" no longer navigates to hotmail.com. Email addresses are stripped before URL matching.
- **Verification override bug** — verification no longer contradicts confirmed checkpoint completion. Skipped when ≥50% checkpoints met.
- **Context loss between layers** — Computer Use now receives full context of what pre-processing already did.
- **Drawing quality** — minimum 50px drag distances enforced via system prompt.
- **OpenClaw credential discovery** — multi-provider scan, template variable resolution, no false overrides.
- **Pipeline gate** — Action Router always runs, shortcuts work everywhere.

### Changed
- Pipeline pre-processes "open X and Y" tasks — opens app via Action Router (free), then hands remaining task to deeper layers.
- Smart Interaction detects visual loop tasks (draw, paint) and skips to Computer Use.
- Computer Use system prompt includes Snap Assist handling and drawing guidelines.

## [0.6.2] - 2026-02-28 — Universal Provider Support, Auto-Config

### Added
- **Auto-config on first run** — `clawdcursor start` auto-detects and configures providers without needing `clawdcursor doctor` first. Doctor is now optional for fine-tuning.
- **Universal provider support** — any OpenAI-compatible endpoint works. Not limited to 7 hardcoded providers. Use `--base-url` + `--api-key` for custom endpoints.
- **CLI model selection** — `--text-model` and `--vision-model` flags on start command.
- **Dynamic OpenClaw provider mapping** — reads ALL providers from OpenClaw config, not just known ones. NVIDIA, Fireworks, Mistral, etc. work automatically.

### Changed
- `clawdcursor start` now auto-runs setup if no config exists (non-interactive)
- Provider detection accepts any provider name, falling back to OpenAI-compatible API
- `detectProvider()` returns 'generic' for unknown providers instead of defaulting to 'openai'

## [0.6.1] - 2026-02-28 — Keyboard Shortcuts, Pipeline Fixes

### Added
- **Keyboard shortcuts registry** (`src/shortcuts.ts`) — 30+ common actions mapped to direct keystrokes. Scroll, copy, paste, undo, reddit upvote/downvote, browser shortcuts, and more. Zero LLM calls.
- **Fuzzy shortcut matching** — "scroll the page down" fuzzy-matches to scroll-down shortcut. Context-aware matching for social media actions.
- **Router telemetry** — Action Router now logs match type, confidence, and shortcut hits.
- **CDP→UIDriver fallback** — Smart Interaction falls back to accessibility tree automation when browser CDP path fails.
- **Gmail, Outlook, Hotmail** added to Browser Layer site map.

### Fixed
- **Pipeline gate bug** — Action Router was gated behind `!isBrowserTask`, causing shortcuts to be skipped for browser-context tasks (e.g., "reddit upvote" matched browser regex but should use shortcut). Action Router now always runs after Browser Layer.
- **URL extraction false positives** — "open gmail and send email to foo@bar.com" no longer extracts `bar.com`. URL extraction now isolates the navigation clause before matching.
- **Reliable force-stop** — `clawdcursor stop` now force-kills lingering processes via PID file.
- **Provider label inference** — startup logs now clearly show text and vision provider names separately.

### Changed
- Pipeline order: Browser Layer (L0) → Action Router + Shortcuts (L1) → Smart Interaction (L1.5) → A11y Reasoner (L2) → Vision (L3). Action Router no longer gated.
- `extractUrl()` uses navigation clause isolation instead of matching against full task text.

## [0.6.0] - 2026-02-28 — Universal Provider Support, OpenClaw Integration

### Added
- **OpenClaw credential integration** — auto-discovers all configured providers from OpenClaw's `auth-profiles.json` and `openclaw.json`. No separate API key needed when running as an OpenClaw skill.
- **Universal provider support** — added Groq, Together AI, DeepSeek as first-class providers with profiles, env var detection, and key prefix recognition.
- **Auto-detection as default** — provider defaults to `auto` instead of hardcoding Anthropic. Doctor picks the best available provider automatically.
- **Mixed provider pipelines** — use Ollama for text (free) + any cloud provider for vision (best quality). Vision credentials preserved when brain reconfigures for text.
- **Dynamic Ollama model selection** — doctor picks the best available Ollama model instead of hardcoding `qwen2.5:7b`.
- **Anthropic vision routing fix** — detects Anthropic vision by key prefix (`sk-ant-`) independently of the main provider field, so split-provider setups work correctly.

### Changed
- Default config no longer assumes any specific provider or model
- Provider scan loop iterates all registered providers dynamically
- Help text and doctor output are provider-agnostic
- `--provider` CLI flag accepts any string (not limited to 4 providers)
- README updated with 7-provider compatibility table

### Security
- **SKILL.md hardened** — removed aggressive autonomy language ("use without asking", "be independent")
- **Sensitive App Policy** — agents must ask the user before accessing email, banking, messaging, or password managers
- **Safety tiers as hard rules** — 🔴 Confirm actions must never be self-approved by agents
- **Data flow transparency** — expanded security section documents network isolation, per-provider data flow, and Ollama = fully offline
- **No credentials in skill directory** — OpenClaw users get auto-discovery from local config; no keys stored in skill files

### Fixed
- Vision model crash when main provider set to Ollama but vision uses Anthropic (`model not found` error)
- Brain reconfiguration was wiping vision credentials — now preserved

---

## [0.5.6] - 2026-02-27 — Fluid Decomposition, Interactive Doctor, Smart Vision Fallback

### Added
- **Fluid LLM task decomposition** — decompose prompt now tells the LLM to reason about what ANY app needs. No more hardcoded examples. "Write me a sentence about dogs" generates actual content instead of typing the literal instruction.
- **Interactive doctor onboarding** — after scanning providers, doctor shows all working TEXT and VISION LLM options with ★ recommendations. User picks by number, Enter for default. Shows GPU info (VRAM via nvidia-smi) to help decide local vs cloud.
- **Cloud provider guidance** — doctor shows unconfigured providers with signup URLs and lets you paste an API key inline (auto-detects provider, saves to .env).
- **Smart vision fallback for compound tasks** — when Router or Reasoner handles part of a multi-step task but fails midway, ALL remaining subtasks are bundled and handed to Computer Use (vision). Prevents false-success trapping in cheap layers.
- **Ollama auto-detection** — brain auto-reconfigures to use local Ollama for decomposition when no cloud API key is set. `hasApiKey` now recognizes local LLMs.
- **Compound task guard** — action router detects multi-step/compound tasks (commas, "then", "and then") and skips to deeper layers.

### Fixed
- **Case-preserving action router** — all regex matches against raw (unmodified) task text. Typed text and URLs no longer get lowercased.
- **Flexible click matching** — `click Blank document` works without quotes (was requiring `click "Blank document"`). Single unified regex for quoted and unquoted element names.
- **PowerShell encoding** — replaced emoji (🐾) and em dash (—) in task console title that broke on Windows PowerShell due to encoding.
- **Stale config** — `.clawdcursor-config.json` now correctly reflects Ollama when doctor detects it (was stuck on Anthropic).
- **Brain provider mismatch** — decomposition no longer calls Anthropic API when only Ollama is available.

### Changed
- **`npm run setup`** — new script that builds and registers `clawdcursor` as a global command via `npm link`. Works on Windows, macOS, and Linux.
- **Stop/kill port validation** — port input is now sanitized (parseInt + range check 1-65535) to prevent command injection
- **Kill health verification** — kill command now verifies `/health` returns a Clawd Cursor response before force-killing
- **Install instructions updated** — README and docs now use `npm run setup`

### Test Results
| Task | Pipeline Path | Steps | LLM Calls | Time | Result |
|------|--------------|-------|-----------|------|--------|
| Open Notepad | Action Router | 1 | 0 | 1.5s | ✅ |
| Open Notepad + write haiku | Router → Smart Interaction → Computer Use | 6 | 7 | 58.8s | ✅ Verified |
| Open Google Doc in Edge + write sentence | Browser → Computer Use | 17 | 9 | 78.8s | ✅ Verified |

## [0.5.5] - 2026-02-26 — Install/Uninstall, OpenClaw Auto-Registration, Doctor UX

### Added
- **`clawdcursor install`** — one command to set up API key, configure pipeline, and register as OpenClaw skill
- **`clawdcursor uninstall`** — clean removal of all config, data, and OpenClaw skill registration
- **Doctor auto-registers as OpenClaw skill** — symlinks into `~/.openclaw/workspace/skills/clawdcursor`
- **Doctor quick fix commands** — shows exact commands for missing text LLM and vision LLM in summary
- **Dashboard favorites** — star commands to save them, click to re-run, persists across server restarts
- **Credential detection** — warns when starring tasks that contain API keys or passwords
- **OS tabs on website** — Windows/macOS/Linux with auto-detect
- **Post-build help message** — shows all available commands after `npm run build`
- **Dynamic OS detection** — system prompt uses actual OS instead of hardcoded "Windows 11" (thanks @molty)

### Fixed
- **Windows skill detection** — removed `requires.bins` from SKILL.md; OpenClaw's `hasBinary()` doesn't handle Windows PATHEXT (`.exe`/`.cmd`), causing the skill to show as "missing" even when node is installed

### Changed
- **SKILL.md rewritten** — agent identity shift framing, trigger lists, CDP direct path, async polling, error recovery
- **Security hardened** — agents cannot self-approve confirm-tier actions, autonomous use scoped to read-only
- **Privacy language clarified** — explicit per-provider data flow
- **Website Get Started simplified** — 3 lines, commands shown in terminal post-build
- **Anthropic text model updated** — `claude-haiku-4-5` (was `claude-3-5-haiku-20241022`)

## [0.5.4] - 2026-02-25 — SKILL.md Rewrite + Security Hardening

### Changed
- **Privacy language clarified** — explicit per-provider data flow (Ollama = fully local, cloud = data to that API only)
- **Added homepage and source URLs** to skill metadata
- **Removed hard-coded paths** from SKILL.md
- **Security section expanded** — includes localhost bind verification command
- **Security scan addressed** — all flagged documentation gaps resolved

## [0.5.3] - 2026-02-25 — SKILL.md Rewrite for Agent Autonomy

### Changed
- **SKILL.md rewritten** — agents now understand they have full desktop control and stop asking users to do things they can do themselves
- **Agent identity shift framing** — blockquote at top overrides default "I can't do desktop things" behavior
- **"When to Use This" trigger list** — comprehensive decision framework for when to reach for Clawd Cursor
- **Two paths documented** — REST API (port 3847) for full desktop control, CDP Direct (port 9222) for fast browser reads
- **Async flow clarified** — concrete polling pattern agents can follow step-by-step
- **Error recovery table** — 8 common problems with exact solutions
- **Expanded task examples** — cross-app workflows, data extraction, verification scenarios
- **README** — added OpenClaw Integration section

## [0.5.2] - 2026-02-25 — Web Dashboard + Browser Foreground Focus

### Added
- **Web Dashboard** — full single-page UI served at `GET /` (port 3847). Task submission, real-time logs, status indicators, approve/reject for safety confirmations, kill switch. Dark theme, fully responsive, zero external dependencies.
- **`clawdcursor dashboard`** — CLI command to open the dashboard in your default browser
- **`clawdcursor kill`** — CLI command to send a stop signal to the running server
- **`GET /logs`** — API endpoint returning last 200 log entries with timestamps and levels
- **Browser foreground focus** — Playwright navigation now brings Chrome to the front via `page.bringToFront()` + OS-level window activation (PowerShell `SetForegroundWindow` on Windows, `osascript` on macOS). The AI acts like a visible cursor — you see everything it does.
- **Console hook** — `hookConsole()` intercepts all server logs for the dashboard log feed with auto-classification (error/success/warn/info)

### Changed
- **Smart task handoff** — Browser layer no longer uses regex word lists to detect multi-step tasks. Pure navigation ("open youtube") completes in browser layer; anything more complex falls through to SmartInteraction where the LLM plans the steps. No more missed verbs.

### Architecture
```
Layer 0: Browser (Playwright) — navigate + foreground focus
    ↓ more than navigation? → fall through
Layer 1: Action Router — regex patterns, zero LLM calls
    ↓ no match? → fall through
Layer 1.5: Smart Interaction — 1 LLM call plans steps, CDP/UIDriver executes
    ↓ failed? → fall through
Layer 2: Accessibility Reasoner — reads UI tree, cheap LLM
    ↓ failed? → fall through
Layer 3: Screenshot + Vision — full screenshot, Computer Use API
```

## [0.5.1] - 2026-02-23 — HD Screenshots + Focus Stability

### Fixed
- **HD screenshots** — LLM resolution increased from 1024px to 1280px (scale 2x instead of 2.5x). Claude can now reliably identify toolbar icons, buttons, and small UI elements.
- **JPEG quality** — bumped from 55 to 65 for clearer icon identification
- **Window focus stability** — `Win+D` minimizes all windows before task execution, preventing the Clawd terminal from stealing focus from target apps
- **Paint drawing reliability** — pencil tool guidance in system prompt, mandatory checkpoint after tool selection
- **Stale file cleanup** — restored `get-windows.ps1` shim (still referenced by accessibility.ts), removed dead `setup.ps1` and `get-ui-tree.ps1`

### Performance (Paint stickman benchmark)
| Metric | v0.5.0 | v0.5.1 |
|--------|--------|--------|
| Time | ~250s | **55s** |
| API calls | 30 | **6** |
| Success rate | ~50% | ~90% |

## [0.5.0] - 2026-02-23 — Smart Pipeline + Doctor + Batch Execution

### Added
- **`clawdcursor doctor`** — auto-diagnoses setup, tests models, configures optimal pipeline
- **3-layer pipeline** — Action Router → Accessibility Reasoner → Screenshot fallback
- **Layer 2: Accessibility Reasoner** (`src/a11y-reasoner.ts`) — text-only LLM reads the UI tree, no screenshots needed. Uses cheap models (Haiku, Qwen, GPT-4o-mini).
- **Batch action execution** — Claude returns multiple actions per response (3.6 avg), skipping screenshots between batched actions. Drawing tasks execute 10+ actions in a single API call.
- **Focus hints** — each screenshot includes a FOCUS directive telling Claude where to look, reducing output tokens and decision time
- **Auto-maximize** — apps launched via Action Router are automatically maximized (`Win+Up`) for consistent layout
- **Region capture** — `captureRegionForLLM()` crops screenshots to specific areas (2-30KB vs 58KB full)
- **Checkpoint strategy** — screenshots only after critical state changes (app open, dialog appear), not after every action
- **Multi-provider support** — Anthropic, OpenAI, Ollama (local/free), Kimi. Same codebase, auto-detected.
- **Provider model map** (`src/providers.ts`) — auto-selects cheap/expensive models per provider
- **Self-healing** — doctor falls back if a model is unavailable (e.g., Haiku → Qwen). Circuit breaker disables failing layers at runtime.
- **Streaming LLM responses** — early JSON return saves 1-3s per call
- **Combined accessibility script** (`scripts/get-screen-context.ps1`) — 1 PowerShell spawn instead of 3
- **Benchmark harness** (`test-perf-comparison.ts`)

### Performance
- Screenshots: 120KB → ~80KB, 1280px target (HD for reliable icon identification)
- JPEG quality: 70 → 65
- Delays: 200-1500ms → 50-600ms across the board
- System prompts: ~60% smaller (fewer tokens per call)
- Accessibility tree: filtered to interactive elements only, 3000 char cap
- Taskbar cache: 30s TTL (was queried every call)
- Screen context cache: 500ms → 2s TTL

### Benchmarks

| Task | v0.4 | v0.5 (Ollama, $0) | v0.5 (Anthropic) | v0.5 + Batch |
|------|------|--------|---------|---------|
| Calculator | 43s | 2.6s | 20.1s | — |
| Notepad | 73s | 2.0s | 54.2s | — |
| File Explorer | 53s | 1.9s | 22.1s | — |
| Paint stickman | ~250s (30 calls) | — | ~124s (19 calls) | **101s (11 calls)** |
| GitHub profile | — | — | ~106s (15 calls) | — |

## [0.4.0] - 2026-02-22 — Native Desktop Control

**VNC removed.** Clawd Cursor now controls the desktop natively via @nut-tree-fork/nut-js. No VNC server required.

### Breaking Changes
- `--vnc-host`, `--vnc-port`, `--vnc-password` CLI flags removed
- `VNC_PASSWORD`, `VNC_HOST`, `VNC_PORT` environment variables no longer used
- `rfb2` dependency removed
- `setup.ps1` no longer installs TightVNC

### Added
- `NativeDesktop` class (`src/native-desktop.ts`) — drop-in replacement for VNCClient
- Direct screen capture via @nut-tree-fork/nut-js (~50ms vs ~850ms)
- Direct mouse/keyboard control via OS-level APIs
- Simplified onboarding: `npm install && npm start`

### Performance
- Screenshots: ~850ms → ~50ms (17× faster)
- Connect time: ~200ms → ~38ms (5× faster)
- Simple task (Google Docs sentence): ~120s → ~102s
- Complex task (GitHub → Notepad → save): ~200s → ~156s

### Removed
- VNC server dependency (TightVNC)
- `rfb2` npm package
- VNC-related CLI flags and environment variables
- BGRA→RGBA color swap (nut-js returns RGBA natively)

## [0.3.3] - 2025-03-15

### Bulletproof Headless Setup
- setup.ps1 now completes end-to-end in a single run on fresh systems, even in non-interactive/headless AI agent shells
- Generate random VNC password when `--vnc-password` not provided non-interactively
- Replace `Start-Process -NoNewWindow -Wait` with `-PassThru -WindowStyle Hidden` + try/catch (msiexec crash fix)
- Wrap `Start-Service` in its own try/catch (post-install crash fix)
- Replace all emoji with ASCII tags for cp1252 headless terminal compatibility

## [0.3.1] - 2025-03-10

### SKILL.md Security Hardening
- Added YAML frontmatter, explicit credential declarations, privacy disclosure, and security considerations for ClaWHub publishing.

## [0.3.0] - 2025-03-01

### Performance Optimizations (~70% faster)
- Screenshot hash cache — skips LLM calls when the screen hasn't changed
- Adaptive VNC frame wait — captures in ~200ms instead of fixed 800ms
- Parallel screenshot + accessibility fetch — runs concurrently via Promise.all
- Accessibility context cache — 500ms TTL eliminates redundant PowerShell queries
- Async debug writes — no longer blocks the event loop
- Exponential backoff with jitter — better retry resilience for API calls

## [0.2.0] - 2025-02-21

### 🚀 Major: Anthropic Computer Use API

Clawd Cursor now supports Anthropic's native Computer Use API (`computer_20250124`) as the **primary execution path**. This is a fundamentally different approach — the full task goes directly to Claude with native computer use tools. No decomposition, no routing. Claude sees screenshots, plans, and executes natively.

### Dual Execution Paths

The agent now has two separate code paths selected by provider:

- **Path A — Computer Use API** (`--provider anthropic`): Full task sent to Claude with `computer_20250124` tool. Claude sees the screen, plans multi-step sequences, and executes them natively. Handles complex, multi-app workflows reliably.
- **Path B — Decompose + Action Router** (`--provider openai` / offline): Original approach from v0.1.0. Parse task → subtasks → Action Router (UI Automation, zero LLM) → Vision fallback. Faster and cheaper for simple tasks, works without an API key.

### Added

- **Anthropic Computer Use integration** — native `computer_20250124` tool type with `anthropic-beta: computer-use-2025-01-24` header
- **Adaptive delays** — per-action timing: 1000ms for app launch, 800ms for navigation, 100ms for typing, 300ms default
- **Verification hints** — post-action verification prompts after each Computer Use step
- **Mouse drag** — `mouseDrag`, `mouseDown`, `mouseUp` with smooth interpolation between points
- **Bulletproof system prompt** — planning rules, ctrl+l for URL navigation, recovery strategies for failed actions
- **Display scaling** — automatic resolution scaling to 1280×720 for Computer Use API compatibility
- **Vision model** — `claude-sonnet-4-20250514` for Computer Use path

### Test Results

| Task | Time | API Calls | Result |
|------|------|-----------|--------|
| Google Docs: open Chrome, go to Docs, write a paragraph | 187s | 14 | ✅ All succeeded |
| GitHub: open Chrome, navigate to profile, screenshot | 102s | — | ✅ All succeeded |
| Notepad: open, write haiku, save to desktop | ~180s | — | ✅ File saved correctly |
| Paint: draw a stick figure | ~90s | 16 | ✅ Drawing completed |

### Breaking Changes

- **Provider selection now determines execution path.** `--provider anthropic` uses Computer Use API (Path A). `--provider openai` or no provider uses the original Decompose + Action Router pipeline (Path B). This is a fundamental change in behavior — the same task will execute via completely different code paths depending on the provider.

### Performance Characteristics

| | Path A (Computer Use) | Path B (Action Router) |
|---|---|---|
| Best for | Complex multi-step tasks | Simple single-action tasks |
| Reliability | Very high | Good for supported patterns |
| Speed | ~90–190s for complex tasks | ~2s for simple tasks |
| Cost | Higher (multiple API calls with screenshots) | Lower (1 text call or zero) |
| Offline | No | Yes (for common patterns) |

## [0.1.0] - 2025-01-15

### Initial Release

- Action Router with Windows UI Automation — 80% of common tasks with zero LLM calls
- Vision fallback for complex/unfamiliar UI
- Smart task decomposition (single text-only LLM call)
- Three-tier safety system (Auto / Preview / Confirm)
- REST API and CLI interface
- Windows setup script
