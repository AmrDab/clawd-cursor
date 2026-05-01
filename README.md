<p align="center">
  <img src="docs/favicon.svg" width="80" alt="Clawd Cursor">
</p>

<h1 align="center">Clawd Cursor</h1>

<p align="center">
  <strong>The skill that gives any AI agent eyes, hands, and a keyboard on a real desktop.</strong><br>
  Install it. Your agent uses it. Windows, macOS, Linux &mdash; any tool-calling model.
</p>

<p align="center">
  <a href="https://github.com/AmrDab/clawdcursor/stargazers"><img src="https://img.shields.io/github/stars/AmrDab/clawdcursor?style=for-the-badge&logo=github&color=eab308&logoColor=white" alt="GitHub stars"></a>
  <a href="https://github.com/AmrDab/clawdcursor/releases/latest"><img src="https://img.shields.io/github/v/release/AmrDab/clawdcursor?style=for-the-badge&color=22c55e&label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AmrDab/clawdcursor?style=for-the-badge&color=a855f7" alt="MIT license"></a>
  <a href="https://discord.gg/UGBWKvmj"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://clawdcursor.com"><img src="https://img.shields.io/badge/Website-clawdcursor.com-0ea5e9?style=for-the-badge" alt="Website"></a>
</p>

<p align="center">
  <a href="https://clawdcursor.com">Website</a> &middot;
  <a href="https://discord.gg/UGBWKvmj">Discord</a> &middot;
  <a href="#install-the-skill">Install</a> &middot;
  <a href="#connect-your-agent">Connect</a> &middot;
  <a href="#tool-surface">Tools</a> &middot;
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

## What This Is

Clawd Cursor is a **skill**, not an application. It gives an AI agent the ability to use the user's computer &mdash; mouse, keyboard, screen, windows, browser &mdash; the same way a human would.

You install it once. Any tool-calling agent on the machine &mdash; Claude Code, Cursor, Windsurf, OpenClaw, the Claude Agent SDK, or a bring-your-own-model setup &mdash; picks it up through MCP or the skill registry once configured. The agent then knows how to click, type, read the screen, open apps, and drive GUIs whenever the task requires it.

```
User: "Open Outlook and reply to the latest email from Sarah."

Agent  →  window({"action":"open_app","name":"Outlook"})
       →  accessibility({"action":"read_tree"})
       →  accessibility({"action":"invoke","name":"Sarah's email"})
       →  computer({"action":"key","combo":"mod+r"})
       →  computer({"action":"type","text":"..."})
       →  accessibility({"action":"invoke","name":"Send"})
       → done (verified by ground-truth verifier)
```

No app-specific integrations. No per-service API keys. No cloud round-trip &mdash; everything runs locally on `127.0.0.1`. If it renders on screen, the agent can read it and act on it.

**Design principles.** Model-agnostic (Claude, GPT, Gemini, local models via Ollama). OS-agnostic (a single `PlatformAdapter` handles Windows, macOS, and Linux behind one interface). Skill-first (the AI is the primary consumer; the CLI exists for testing).

---

## Latest Release

**v0.8.6** &mdash; polish release. Fixes a stale `McpServer` version string that had been advertising `v0.7.2` in MCP client metadata since the v0.7.x line; adds `SECURITY.md` and a private vulnerability reporting channel; trims the homepage; prunes stale repo artifacts.

The substantive work landed earlier in the v0.8.x line:

- **v0.8.5** &mdash; `computer({"action":"key","combo":"..."})` now actually works (compact-tool keyboard remap was missing); 16 documentation accuracy fixes; cost-tier ladder added to SKILL.md.
- **v0.8.4** &mdash; security maintenance: patches every fixable CVE in the dependency tree (vite, path-to-regexp, picomatch, hono, follow-redirects); README rewritten to frame clawdcursor as a *skill* rather than a standalone server.
- **v0.8.3** &mdash; idempotent `open_app` (no more N copies of Outlook stacking up under retry), agent runaway guard, `clawdcursor stop` sweeps every mode.
- **v0.8.2** &mdash; silent-401 auth bug fixed, force-focus on Windows through the foreground lock, Electron/WebView2 detection + CDP relaunch hint.
- **v0.8.1 (rolled into 0.8.2)** &mdash; unified blind/hybrid/vision pipeline (one loop, three strategy modes), compact MCP surface (6 tools, ~12&times; smaller catalog), Linux AT-SPI bridge, Wayland input routing.

Full per-release detail in [CHANGELOG.md](CHANGELOG.md).

---

## Install the Skill

### Windows

```powershell
powershell -c "irm https://clawdcursor.com/install.ps1 | iex"
```

### macOS

```bash
curl -fsSL https://clawdcursor.com/install.sh | bash
clawdcursor grant     # Accessibility + Screen Recording
```

### Linux

```bash
curl -fsSL https://clawdcursor.com/install.sh | bash
```

The installer clones the skill into `~/clawdcursor`, runs `npm install`, builds, and registers a global `clawdcursor` shim via `npm link`. Runtime state (auth token, pidfiles, logs) lives at `~/.clawdcursor/`. To wire the skill into an agent host, follow [Connect Your Agent](#connect-your-agent) below &mdash; the installer does not edit any host config files automatically.

> Linux notes: install `tesseract-ocr` for OCR, `python3-gi` + `gir1.2-atspi-2.0` for accessibility (the AT-SPI typelib `python3-gi` consumes), and `ydotool` (or `wtype`) for Wayland input.

---

## Connect Your Agent

The skill is transport-agnostic. Every agent below exposes the same tool catalog.

### Claude Code

Add the MCP entry to `~/.claude/settings.json` (the installer leaves agent host config untouched, so this step is required):

```jsonc
// ~/.claude/settings.json
{
  "mcpServers": {
    "clawdcursor": {
      "command": "clawdcursor",
      "args": ["mcp", "--compact"]
    }
  }
}
```

### OpenClaw

```bash
openclaw skill install clawdcursor
```

The skill metadata in [SKILL.md](SKILL.md) tells OpenClaw how to install, bootstrap, and discover the tool catalog. No further configuration needed.

### Cursor, Windsurf, Zed

Any MCP-aware editor. Add a stdio MCP entry pointing to `clawdcursor mcp --compact`. Refer to the host's MCP configuration docs.

### Claude Agent SDK / bring-your-own-model

The skill also exposes a local REST surface for agents that do not speak MCP. Start the skill server once, then discover tools at `GET http://127.0.0.1:3847/tools?mode=compact` and call them at `POST /execute/:name`. Bearer-token auth; token written to `~/.clawdcursor/token`. See [API](#api) below.

---

## Tool Surface

The skill exposes two catalogs side by side. Agents pick the one that fits.

### Compact &mdash; 6 compound tools (recommended)

Anthropic `computer_20250124`-style: one tool per capability, with an `action` enum for the verb. Small prompt footprint (~1,500 tokens), easy for a model to learn zero-shot, the default for most agents.

Most-used actions per compound below. The full enum is at `GET /tools?mode=compact` or via MCP `list_tools`.

| Tool | Most-used actions |
|---|---|
| `computer` | `screenshot`, `click`, `double_click`, `right_click`, `triple_click`, `hover`, `scroll`, `scroll_horizontal`, `drag`, `drag_path`, `type`, `key`, `wait` |
| `accessibility` | `read_tree`, `find`, `get_element`, `focused`, `invoke`, `focus`, `set_value`, `get_value`, `expand`, `collapse`, `toggle`, `select`, `state`, `list_children`, `wait_for` |
| `window` | `list`, `active`, `focus`, `maximize`, `minimize`, `restore`, `close`, `resize`, `list_displays`, `screen_size`, `open_app`, `open_file`, `open_url`, `switch_tab`, `navigate` |
| `system` | `clipboard_read`, `clipboard_write`, `system_time`, `ocr`, `undo`, `shortcuts_list`, `shortcuts_run`, `delegate`, `detect_webview`, `relaunch_with_cdp` |
| `browser` | `connect`, `page_context`, `read_text`, `click`, `type`, `select_option`, `evaluate`, `wait_for`, `list_tabs`, `switch_tab`, `scroll` |
| `task` | (no `action` enum &mdash; takes `{instruction: string}` and routes through the full pipeline) |

### Granular &mdash; 74 individual tools

Full catalog for agents that prefer one tool per verb. Sample of categories below; the full list is at `GET /tools` or `list_tools` over MCP.

| Category | Examples |
|---|---|
| Perception | `read_screen`, `desktop_screenshot`, `desktop_screenshot_region`, `ocr_read_screen`, `smart_read` |
| Mouse | `mouse_click`, `mouse_double_click`, `mouse_drag`, `mouse_drag_stepped`, `mouse_scroll` |
| Keyboard | `key_press`, `type_text`, `smart_type`, `shortcuts_list`, `shortcuts_execute` |
| Window / App | `focus_window`, `open_app`, `get_windows`, `get_active_window`, `detect_webview_apps` |
| Browser (CDP) | `cdp_connect`, `cdp_click`, `cdp_type`, `cdp_read_text`, `cdp_evaluate` |
| Accessibility | `find_element`, `invoke_element`, `wait_for_element`, `get_focused_element`, `a11y_expand`, `a11y_toggle` |
| System | `read_clipboard`, `write_clipboard`, `get_system_time`, `undo_last`, `delegate_to_agent` |
| Orchestration | `smart_click`, `navigate_browser`, `wait` |

Full catalog visible to the agent through MCP `list_tools` or at `GET /tools`.

---

## How the Skill Thinks

Every tool call &mdash; whether it arrives over MCP, REST, or the built-in agent &mdash; passes through the same decision layer.

```
         ┌────────────────────────────────────────────┐
agent ─▶ │  Router   (regex shortcuts · zero LLM)    │ ──▶ tool
         └───────────────────┬────────────────────────┘
                             │  (no shortcut match)
                             ▼
         ┌────────────────────────────────────────────┐
         │  Blind     (accessibility tree only)       │ ──▶ tool
         └───────────────────┬────────────────────────┘
                             │  (a11y sparse, stagnation)
                             ▼
         ┌────────────────────────────────────────────┐
         │  Hybrid    (a11y + screenshot-on-demand)   │ ──▶ tool
         └───────────────────┬────────────────────────┘
                             │  (still stuck)
                             ▼
         ┌────────────────────────────────────────────┐
         │  Vision    (screenshot every turn)         │ ──▶ tool
         └────────────────────────────────────────────┘
```

Every tool call routes through a single `safety.evaluate()` chokepoint. The agent cannot bypass this path &mdash; it is the only way tools execute.

**Ground-truth verification.** When a task is claimed complete, six independent signals are checked against the post-task screen: pixel diff, window-state change, focus change, OCR delta, task-type assertions (`send_email`, `navigate_url`, `open_app`, `type_text`, &hellip;), and anti-pattern detection (error dialogs, auth failures, "cannot send", "draft saved"). Weighted voting with hard-fail rules. The agent cannot self-report its way past the verifier.

**Runaway guard.** If the agent calls the same tool with identical arguments three or more times in a six-turn window, the loop exits with a targeted diagnostic &mdash; typically pointing at `detect_webview` when the target app is Electron/WebView2 with a sparse accessibility tree.

---

## Safety

Tools are classified into three tiers, enforced at the single `safety.evaluate()` chokepoint:

| Tier | Actions | Behavior |
|---|---|---|
| Auto | Reading, navigation, opening apps | Executes immediately |
| Preview | Typing, form fill, arbitrary input | Logged before executing |
| Confirm | Sending messages, deleting, purchases | Pauses for user approval |

Hardening: server binds to `127.0.0.1` only, bearer-token auth on every request, dangerous key combinations (Cmd+Q, Alt+F4, Ctrl+Alt+Del) blocked by default, first-run consent prompt required. Sensitive categories (email, banking, password managers) require explicit user approval per action.

---

## API

For agents that do not speak MCP. Base URL: `http://127.0.0.1:3847` (localhost-only, bearer-token auth, token at `~/.clawdcursor/token`).

| Endpoint | Method | Purpose |
|---|---|---|
| `/tools` | GET | Full catalog in OpenAI function-calling format. `?mode=compact` for the 6-tool surface. |
| `/execute/:name` | POST | Execute a tool by name. Returns structured JSON. |
| `/status` | GET | Current skill state. |
| `/screenshot` | GET | Current screen as PNG. |
| `/confirm` | POST | Approve or reject a safety-gated action. |
| `/abort` | POST | Stop the in-flight task. |
| `/health` | GET | Version, uptime, and health check. |

---

## Platform Support

Platform-specific code lives in `src/v2/platform/{windows,macos,linux}.ts` behind a single `PlatformAdapter` interface. Business logic never reads `process.platform`.

| Platform | UI Automation | OCR | Browser |
|---|---|---|---|
| **Windows** x64 / ARM64 | UI Automation via PowerShell bridge | `Windows.Media.Ocr` | Chrome / Edge (CDP) |
| **macOS** Intel / Apple Silicon | JXA + System Events (TCC-safe) | Apple Vision | Chrome / Edge (CDP) |
| **Linux** X11 | AT-SPI + nut-js | Tesseract | Chrome / Edge (CDP) |
| **Linux** Wayland | AT-SPI + `ydotool` / `wtype` | Tesseract | Chrome / Edge (CDP) |

---

## Prerequisites

- **Node.js** 20 or newer
- **macOS** &mdash; Xcode CLI tools (`xcode-select --install`), then `clawdcursor grant` for Accessibility + Screen Recording
- **Linux** &mdash; `tesseract-ocr`, `python3-gi` + `gir1.2-atspi-2.0` (AT-SPI typelib), `ydotool` or `wtype` (Wayland)
- **AI provider key** &mdash; configured on the agent side; the skill itself is model-agnostic

---

## Testing and Troubleshooting

The CLI below is intended for humans diagnosing an install. Agents should not invoke it; they should use MCP or the REST surface.

```
clawdcursor doctor       Diagnose install, permissions, and platform bridges
clawdcursor grant        Grant macOS permissions (interactive)
clawdcursor consent      Manage desktop-control consent (--accept / --revoke / --status)
clawdcursor status       Check readiness (consent, permissions, AI config)
clawdcursor mcp          MCP stdio server (the primary skill transport)
clawdcursor serve        REST-only tool server (bring-your-own-agent)
clawdcursor stop         Stop every running mode (mcp, serve, start)

# The web dashboard is reachable at http://127.0.0.1:3847 while
# `clawdcursor serve` (or `start`) is running — no separate command.

# The two commands below exist for manual end-to-end testing only.
# Real agents should not use these — they should call the skill through MCP.
clawdcursor start        Run the built-in autonomous agent (testing)
clawdcursor task <t>     Send a task to that agent (testing)

Options:
  --port <port>          Default: 3847 (start, serve, stop, task)
  --compact              MCP only: expose 6 compound tools instead of 74 granular.
                         For REST/serve, use the `?mode=compact` query parameter
                         on `GET /tools` instead.
  --provider <name>      `start` only: anthropic | openai | gemini | ollama | ...
  --accept               `start` and `consent` only: skip the consent prompt.
                         For `serve`, use `--skip-consent` (dev environments).
```

---

## Tech Stack

TypeScript · Node.js 20+ · nut-js · Playwright · sharp · Express · Model Context Protocol SDK · Zod · commander

---

## License

MIT &mdash; see [LICENSE](LICENSE).

---

<p align="center">
  <a href="https://clawdcursor.com">clawdcursor.com</a>
</p>
