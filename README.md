<p align="center">
  <img src="docs/favicon.svg" width="96" alt="Clawd Cursor">
</p>

<h1 align="center">Clawd Cursor</h1>

<p align="center">
  <strong>Eyes, hands, and a keyboard for any AI agent on a real desktop.</strong><br>
  Any model. Any app. One MCP entry. Local-only.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AmrDab/clawdcursor?color=a855f7" alt="MIT license"></a>
  <a href="https://github.com/AmrDab/clawdcursor/releases/latest"><img src="https://img.shields.io/github/v/release/AmrDab/clawdcursor?color=22c55e&label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white" alt="Node 20+">
  <img src="https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-0ea5e9" alt="Cross-platform">
  <a href="https://github.com/AmrDab/clawdcursor/actions/workflows/cross-platform.yml"><img src="https://img.shields.io/github/actions/workflow/status/AmrDab/clawdcursor/cross-platform.yml?branch=main&label=tests" alt="Tests"></a>
  <a href="https://github.com/AmrDab/clawdcursor/actions/workflows/codeql.yml"><img src="https://img.shields.io/github/actions/workflow/status/AmrDab/clawdcursor/codeql.yml?branch=main&label=codeql" alt="CodeQL"></a>
  <a href="https://discord.gg/hW29nrEZ8G"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> &middot;
  <a href="#why-clawd-cursor">Why</a> &middot;
  <a href="#how-it-thinks">How it thinks</a> &middot;
  <a href="#tool-surface">Tools</a> &middot;
  <a href="#platform-support">Platforms</a> &middot;
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

Clawd Cursor is a **skill**, not an app. Install it once. Any tool-calling agent on the machine &mdash; Claude Code, Cursor, Windsurf, OpenClaw, Claude Agent SDK, your own loop &mdash; picks up the tools through MCP. The agent then clicks, types, reads the screen, opens apps, and drives any GUI the same way a human would.

> **If a human can do it on a screen, your AI can do it too.** No API? No integration? No problem.
>
> **No task is impossible.** GUI plus a mouse plus a keyboard equals everything you need. There is no "I can't do that in this app" &mdash; only the right sequence of reads, clicks, keys, and waits. Clawd Cursor gives you all of them.

It's **model-agnostic** (Claude, GPT, Gemini, Llama, Kimi, Ollama, &hellip;), **app-agnostic** (drives any window via accessibility, OCR, or vision fallback), and **OS-agnostic** (one `PlatformAdapter` covers Windows, macOS, Linux X11, and Linux Wayland).

> **Use as a fallback, not first choice.** Native API exists? Use it. CLI exists? Use it. Direct file edit possible? Do that. A Playwright script already wired up? Use that. Clawd Cursor is for the **last mile** &mdash; the click, the legacy app, the GUI with no public surface.

---

## Quickstart

Sixty seconds from zero to a tool-calling agent on your desktop.

**Pick your mode first:**

| Your situation | Use | Why |
|---|---|---|
| AI lives in your editor (Claude Code, Cursor, Windsurf, Zed) | **`clawdcursor mcp`** | stdio MCP server. Editor spawns it on demand. No daemon, no port. |
| You're building an agent that runs unattended | **`clawdcursor agent`** | HTTP MCP daemon on `127.0.0.1:3847`. Has its own LLM brain optionally configured via `doctor`. |
| Your agent has its own brain — you just want the tools as an HTTP endpoint | **`clawdcursor agent --no-llm`** | Same daemon, no built-in pipeline, no scheduler startup, no credential validation. Pure tool surface. |

**Windows (PowerShell):**

```powershell
powershell -c "irm https://clawdcursor.com/install.ps1 | iex"
```

**macOS / Linux:**

```bash
curl -fsSL https://clawdcursor.com/install.sh | bash
```

Then:

```bash
clawdcursor consent --accept   # one-time desktop-control consent (required)
clawdcursor doctor             # verify permissions + (optionally) configure an LLM provider
clawdcursor agent              # OR `clawdcursor mcp` — see the table above
```

The installer clones into `~/clawdcursor`, runs `npm install`, builds, and `npm link`s a global shim. Runtime state lives at `~/.clawdcursor/` (auth token, pidfiles, logs). It does **not** edit any agent host config &mdash; that step is below.

Wire it into Claude Code, Cursor, Windsurf, or Zed:

```jsonc
// ~/.claude/settings.json  (or your editor's MCP config)
{
  "mcpServers": {
    "clawdcursor": {
      "command": "clawdcursor",
      "args": ["mcp", "--compact"]
    }
  }
}
```

That's it. Ask your agent to *"open Outlook and reply to the latest email from Sarah"* and watch it run.

> **macOS:** run `clawdcursor grant` to walk through Accessibility + Screen Recording permissions.
> **Linux:** install `tesseract-ocr`, `python3-gi`, `gir1.2-atspi-2.0`, and (Wayland only) `ydotool` or `wtype`.

---

## Why Clawd Cursor

- **Works where APIs don't exist.** Native apps. Legacy enterprise tools. Web portals behind SSO that block headless browsers. Anything inside Citrix or RDP. If pixels reach the screen, your agent can drive it.
- **Model-agnostic.** Claude, GPT, Gemini, Llama, Kimi, anything local via Ollama. 13 providers ship configured. Vision and text can be different models from different vendors.
- **App-agnostic.** No per-app plugins, no per-service auth. The same six compound tools drive Outlook, Figma, your bank, and that 2003-era ERP.
- **Cheapest-tier-first pipeline.** Accessibility tree (free) before OCR (cheap) before screenshot (medium) before vision (expensive). The Reflector feeds verifier signals back to the planner so it doesn't keep paying for vision when text would work.
- **Local-only by default.** Server binds to `127.0.0.1`. Screenshots stay in RAM unless you point a cloud model at them. No telemetry.
- **One protocol, two transports.** MCP over stdio for editor hosts; MCP over HTTP for daemons. Same tool catalog, same JSON-RPC envelope.

---

## How It Thinks

Every tool call &mdash; whether it arrives over stdio MCP, HTTP MCP, or the built-in autonomous loop &mdash; flows through the same decision layer. The pipeline picks the cheapest rung that works and only escalates when the verifier disagrees with the planner's claim of success.

```mermaid
flowchart LR
    user["User task"] --> pre["Preprocessor<br/>(strategy + subtasks)"]
    pre --> router["Router<br/>(regex shortcuts, zero LLM)"]
    router -- match --> tool["safety.evaluate()<br/>→ tool"]
    router -- miss --> blind["Blind<br/>(a11y tree only)"]
    blind --> tool
    blind -- sparse a11y / stagnation --> hybrid["Hybrid<br/>(a11y + screenshot on demand)"]
    hybrid --> tool
    hybrid -- still stuck --> vision["Vision<br/>(screenshot every turn)"]
    vision --> tool
    tool --> verifier{"Ground-truth<br/>verifier"}
    verifier -- pass --> done["done"]
    verifier -- fail --> reflector["Reflector<br/>(structured cause + suggested strategy)"]
    reflector -. feedback .-> pre
    reflector -. hint .-> blind
    reflector -. hint .-> hybrid
    reflector -. hint .-> vision

    classDef rung fill:#0ea5e9,stroke:#0369a1,color:#fff;
    classDef gate fill:#a855f7,stroke:#6b21a8,color:#fff;
    classDef refl fill:#eab308,stroke:#854d0e,color:#000;
    class router,blind,hybrid,vision rung;
    class tool,verifier gate;
    class reflector refl;
```

**Single safety chokepoint.** Every tool call &mdash; direct or autonomous &mdash; routes through `safety.evaluate()`. The agent cannot bypass this path; it is the only way tools execute.

**Ground-truth verification.** When the agent claims a task is done, six independent signals are checked against the post-task screen: pixel diff, window-state change, focus change, OCR delta, task-type assertions (`send_email`, `navigate_url`, `open_app`, &hellip;), and anti-pattern detection (error dialogs, auth failures, "draft saved"). Weighted voting with hard-fail rules. No LLM self-report.

**Reflector loop.** On a verifier fail, the Reflector emits a structured `Cause` (e.g. `wrong_window_focused`, `modal_intercept`, `a11y_target_missing`, `webview_blind`) plus a suggested next strategy. The pipeline ladder consumes that signal to override its default escalation, and a one-line hint is injected as a synthetic `tool_result` so the planner understands *why* it's escalating.

**Runaway guard.** Three identical calls in six turns and the loop exits with a targeted diagnostic &mdash; usually pointing at `detect_webview` when the target is Electron or WebView2 with a sparse accessibility tree.

---

## Transports

One protocol &mdash; **MCP** &mdash; two transports. Same catalog, same JSON-RPC envelope.

| Transport | When to use | Client config |
|---|---|---|
| **stdio MCP** | Editor hosts: Claude Code, Cursor, Windsurf, Zed. Tools appear on demand &mdash; no daemon. | `{"command": "clawdcursor", "args": ["mcp", "--compact"]}` |
| **HTTP MCP** | Bring-your-own-agent, headless daemons, multi-process orchestration, Claude Agent SDK. POST JSON-RPC to `http://127.0.0.1:3847/mcp`. | Run `clawdcursor agent`. Then `tools/list` returns the catalog and `tools/call` invokes any tool. Bearer token at `~/.clawdcursor/token`. |

Both transports are stateless. No session-init handshake. Bearer-token auth on every HTTP request; stdio inherits the parent process's trust.

```bash
# HTTP MCP — list tools
curl -s -X POST http://127.0.0.1:3847/mcp \
  -H "Authorization: Bearer $(cat ~/.clawdcursor/token)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## Tool Surface

Two catalogs, side by side. Agents pick the shape that fits.

### Compact &mdash; 6 compound tools (recommended)

Anthropic `computer_20250124`-style: one tool per capability, an `action` enum for the verb. Catalog footprint ~1,500 tokens &mdash; about 12&times; smaller than the granular surface. Default for every agent that doesn't explicitly need one schema per primitive.

| Tool | Most-used actions |
|---|---|
| `computer` | `screenshot`, `click`, `double_click`, `right_click`, `triple_click`, `hover`, `scroll`, `scroll_horizontal`, `drag`, `drag_path`, `type`, `key`, `wait` |
| `accessibility` | `read_tree`, `find`, `get_element`, `focused`, `invoke`, `focus`, `set_value`, `get_value`, `expand`, `collapse`, `toggle`, `select`, `state`, `list_children`, `wait_for` |
| `window` | `list`, `active`, `focus`, `maximize`, `minimize`, `restore`, `close`, `resize`, `list_displays`, `screen_size`, `open_app`, `open_file`, `open_url`, `switch_tab`, `navigate` |
| `system` | `clipboard_read`, `clipboard_write`, `system_time`, `ocr`, `undo`, `shortcuts_list`, `shortcuts_run`, `delegate`, `detect_webview`, `relaunch_with_cdp` |
| `browser` | `connect`, `page_context`, `read_text`, `click`, `type`, `select_option`, `evaluate`, `wait_for`, `list_tabs`, `switch_tab`, `scroll` |
| `task` | `{instruction: string}` &mdash; hand off the whole task to the pipeline. No `action` enum. |

### Granular &mdash; 93 individual tools

One schema per verb. Use this when your runtime requires every primitive as a top-level tool. The full catalog is visible through MCP `tools/list` on either transport.

A typical turn:

```js
// Compact — recommended
computer({ action: "key", combo: "mod+s" })          // resolves to Cmd+S / Ctrl+S
accessibility({ action: "invoke", name: "Send" })
window({ action: "open_app", name: "Outlook" })
system({ action: "ocr" })                            // OS-level OCR, no LLM vision
task({ instruction: "open Notepad and type hello" }) // full pipeline
```

---

## Guides Marketplace

For unfamiliar apps, the agent reasons from screenshots and the a11y tree &mdash; slow but always works. For popular apps, **community-curated guides** ship the keyboard shortcuts, workflow patterns, layout cues, and failure modes the agent would otherwise have to discover by failing first. Loading a guide for an app it knows speeds operation 5&ndash;10&times;.

- **Public registry fallback: <https://github.com/AmrDab/clawdcursor-guides>**
- **Source repo: <https://github.com/AmrDab/clawdcursor-guides>** &mdash; community PRs welcome
- **Verified seed guides:** discord, excel, figma, gmail, mspaint, olk (new Outlook), outlook, slack, spotify, youtube
- **Bundled core (offline fallback):** msedge, notepad

Guides are fetched on demand, cached locally for 7 days, LRU-evicted at 50 entries. The cache lives at `~/.clawdcursor/guide-cache/`. The agent never blocks on the network &mdash; if a guide isn't local and the registry is unreachable, it falls back to first-principles reasoning.

```bash
clawdcursor guides available             # browse the public registry
clawdcursor guides install youtube       # pre-warm cache for one app
clawdcursor guides list                  # show cached + ratings
clawdcursor guides info youtube          # details for one cached guide
clawdcursor guides refresh youtube       # force re-fetch
clawdcursor guides submit my-app.json    # lint + print PR instructions
```

Every guide passes through a client-side linter on every load &mdash; schema check + prompt-injection patterns + dangerous-prose detection. A guide that fails lint is dropped and the agent falls back to no-knowledge, never poisoned-knowledge. Same linter runs as the registry's CI check on every PR.

Voting: each guide has a `vote: <app>` issue on the source repo. React 👍 / 👎. A nightly job aggregates reactions into `index.json` so `clawdcursor guides list` shows ratings.

See [`docs/guide-marketplace.md`](docs/guide-marketplace.md) for the full architecture, trust model, and CI flow.

---

## Cost Tiers

The pipeline picks the cheapest rung that works. Apply the same logic when you call compound tools by hand.

| Tier | Label | Cost | Source | When to use |
|---|---|---|---|---|
| **T1** | structured | ~free | `accessibility.*`, `window.*`, `browser.read_text`, clipboard | Default. Returns text + bounds &mdash; no image, no vision LLM. |
| **T2** | ocr | cheap | `system({"action":"ocr"})` | A11y tree empty or sparse. OS-level OCR &mdash; text out, no LLM vision. |
| **T3** | screenshot | medium | `computer({"action":"screenshot"})` | OCR isn't enough and you need pixel context. Sends an image into LLM context. |
| **T4** | vision | expensive | `smart_click`, `smart_read`, `smart_type` | Canvas-only apps (Paint, Figma, games) or spatial reasoning that text can't express. Last resort. |

**Rule: start at T1. Escalate only when the current tier fails.** `task({...})` does this automatically; the Reflector tells the planner *which* tier to jump to.

---

## Platform Support

Platform-specific code lives in `src/platform/{windows,macos,linux}.ts` (plus `wayland-backend.ts`) behind a single `PlatformAdapter` interface. Business logic never reads `process.platform`. Roughly 3,750 LOC across the four adapters.

| Platform | UI Automation | OCR | Browser (CDP) | Input |
|---|---|---|---|---|
| **Windows** 10/11 (x64 / ARM64) | UIA via PowerShell bridge | `Windows.Media.Ocr` | Chrome / Edge | nut-js |
| **macOS** 12+ (Intel / Apple Silicon) | JXA + System Events (TCC-safe) | Apple Vision | Chrome / Edge | nut-js + System Events |
| **Linux** X11 | AT-SPI via `python3-gi` | Tesseract | Chrome / Edge | nut-js |
| **Linux** Wayland | AT-SPI via `python3-gi` | Tesseract | Chrome / Edge | `ydotool` / `wtype` |

Per-OS setup notes:

- **Windows** &mdash; no setup. PowerShell bridge spawns on demand.
- **macOS** &mdash; first run needs Accessibility + Screen Recording in `System Settings > Privacy & Security`. `clawdcursor grant` walks the dialogs. Retina / HiDPI handled in the adapter; **do not pre-scale coordinates**.
- **Linux X11** &mdash; `apt install tesseract-ocr python3-gi gir1.2-atspi-2.0` (or your distro's equivalent).
- **Linux Wayland** &mdash; same a11y packages, plus `ydotool` + a running `ydotoold` daemon (preferred) or `wtype` (keyboard only).

---

## Architecture

Five directories. Everything else is a leaf module.

| Directory | What lives here |
|---|---|
| `src/core/` | Pipeline orchestrator, agent loop, router, preprocessor, sense (a11y/snapshot/fingerprint), classify, decompose, skills cache, safety gate, ground-truth verifier, Reflector. |
| `src/tools/` | The 93 granular tools + 6 compound aggregators, playbooks (`compose-send`, `find-replace`), tool registry, dispatch. |
| `src/platform/` | `PlatformAdapter` interface + Windows / macOS / Linux / Wayland implementations, OCR engine, CDP driver, URI handler. |
| `src/llm/` | Provider clients (Claude, GPT, Gemini, Llama, Kimi, Ollama, &hellip;), credentials, model config, guide loader. |
| `src/surface/` | CLI (`clawdcursor`), MCP server (stdio + HTTP), dashboard, doctor, onboarding, readiness probes. |

The `PlatformAdapter` is the only thing platform code talks to. The `safety.evaluate()` chokepoint is the only way tools execute. Those two seams are the whole point of the v0.9 reorganization.

---

## Safety & Privacy

| Tier | Actions | Behavior |
|---|---|---|
| Auto | Reading, opening apps, navigation, typing into non-sensitive fields | Executes immediately |
| Preview | Form fill, arbitrary input | Logged before executing |
| Confirm | Sends, deletes, purchases, transfers | Pauses for user approval |
| Block | `Alt+F4` / `Cmd+Q` of the agent shell, `Ctrl+Alt+Delete`, `Shift+Delete`, power chords | Refused outright |

Hardening summary:

- **Network isolation.** Server binds to `127.0.0.1`. Verify with `netstat -an | findstr 3847` (Windows) or `| grep 3847` (Unix).
- **Bearer-token auth.** Every HTTP request needs `Authorization: Bearer $(cat ~/.clawdcursor/token)`.
- **Sensitive-app policy.** Email, banking, password managers, private messaging auto-elevate to Confirm. The agent must ask the user before acting on these surfaces.
- **No telemetry.** Screenshots stay in RAM. With Ollama or any local model, nothing leaves the machine. With a cloud provider, screenshots go only to the endpoint you configured.
- **Prompt-injection defense.** Screen text returned inside `<untrusted-screen-content>` tags is treated as data, never as instructions.
- **Log privacy.** JSON logs at `~/.clawdcursor/logs/` redact password-field values (`AXSecureTextField`, UIA `IsPassword=true`).

See [SECURITY.md](SECURITY.md) for the private vulnerability reporting channel.

---

## CLI

The CLI is for humans diagnosing an install or managing the guide cache. Agents should connect via MCP (stdio for editor hosts, HTTP for daemons).

```
# Install + setup
clawdcursor consent         Manage desktop-control consent (--accept / --revoke / --status)
clawdcursor grant           Grant macOS permissions (interactive, macOS only)
clawdcursor doctor          Verify permissions, configure AI provider + models
clawdcursor status          Readiness check (consent, permissions, AI config)

# Run
clawdcursor mcp             MCP stdio server — primary transport for editor hosts
clawdcursor agent           Daemon: HTTP MCP at /mcp on :3847, optional built-in LLM
clawdcursor agent --no-llm  Daemon, tool surface only (no built-in brain/scheduler)
clawdcursor stop            Stop every running mode
clawdcursor uninstall       Remove all clawdcursor config and data

# Guides marketplace (see Guides Marketplace section above)
clawdcursor guides list                What's cached + ratings
clawdcursor guides info <app>          Cache metadata for one app
clawdcursor guides available           Browse the public registry
clawdcursor guides install <app>       Pre-warm one (or --all for offline prep)
clawdcursor guides refresh <app>       Force re-fetch
clawdcursor guides remove <app>        Evict from cache
clawdcursor guides clean               Wipe cache
clawdcursor guides lint <file>         Validate a local guide
clawdcursor guides submit <file>       Lint + print PR instructions

# Manual end-to-end testing only — agents should call submit_task via MCP.
clawdcursor task <t>        Send a task to the running agent

Options:
  --port <port>          Default: 3847
  --compact              MCP only: expose 6 compound tools instead of 93 granular
  --provider <name>      `agent` only: anthropic | openai | gemini | ollama | ...
  --accept               `agent` and `consent` only: skip the consent prompt
```

---

## Development

```bash
git clone https://github.com/AmrDab/clawdcursor.git
cd clawdcursor
npm install
npm run build       # tsc + postbuild
npm test            # vitest
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm link            # global `clawdcursor` shim (Unix) — use Admin shell on Windows
```

The build emits `dist/`. Entry point: `dist/surface/cli.js`. Tests run on Node 20 and 22 against Ubuntu, macOS, and Windows in CI.

---

## Tech Stack

TypeScript &middot; Node.js 20+ &middot; nut-js &middot; Playwright &middot; sharp &middot; Express &middot; Model Context Protocol SDK &middot; Zod &middot; commander

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development loop, branch conventions, and the test matrix every change has to clear. Bug reports and feature requests go in [issues](https://github.com/AmrDab/clawdcursor/issues); private security reports go to the channel listed in [SECURITY.md](SECURITY.md).

## License

MIT &mdash; see [LICENSE](LICENSE).

## Acknowledgments

Built on the shoulders of the Model Context Protocol SDK, nut-js, Playwright, the Anthropic `computer_20250124` tool shape, and the AT-SPI / UIA / AX trees that make app-agnostic GUI automation possible at all.

---

<p align="center">
  <a href="https://clawdcursor.com">clawdcursor.com</a> &middot;
  <a href="https://discord.gg/hW29nrEZ8G">Discord</a> &middot;
  <a href="CHANGELOG.md">Changelog</a>
</p>
