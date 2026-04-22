<p align="center">
  <img src="docs/favicon.svg" width="80" alt="Clawd Cursor">
</p>

<h1 align="center">Clawd Cursor</h1>

<p align="center">
  <strong>A desktop automation server for AI agents.</strong><br>
  Gives any tool-calling model eyes, hands, and a keyboard on a real computer — Windows, macOS, Linux.
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
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#integration">Integration</a> &middot;
  <a href="#api">API</a> &middot;
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

## Overview

Clawd Cursor is a local tool server that exposes the desktop — mouse, keyboard, screen, windows, accessibility tree, and browser — as a set of callable tools. Any model that can call functions can drive it.

```
Your AI  →  "click the Send button"      →  find_element + mouse_click
Your AI  →  "what's on screen?"          →  screenshot + read_screen
Your AI  →  "open Chrome and go to gmail" →  open_app + navigate_browser
```

No app-specific integrations, no per-service API keys, no cloud round-trip. If it renders on your screen, Clawd Cursor can read it and interact with it.

**Design goals:** model-agnostic (Claude, GPT, Gemini, local models), OS-agnostic (a single `PlatformAdapter` replaces every `if (process.platform)` branch in the codebase), and transport-agnostic (REST, MCP, or an autonomous built-in agent — same tools, same semantics).

---

## What's New in v0.8.4

Security maintenance release. Patches every fixable CVE in the dependency tree:

| Package | Severity | Issue |
|---|---|---|
| `vite` | High | Path traversal, `server.fs.deny` bypass, arbitrary read via WebSocket |
| `path-to-regexp` | High | ReDoS via multiple route parameters |
| `picomatch` | High | ReDoS + method injection in POSIX character classes |
| `hono` | Moderate | HTML injection in `hono/jsx` SSR |
| `follow-redirects` | Moderate | Auth headers leaked to cross-domain redirects |

See [CHANGELOG.md](CHANGELOG.md) for the full v0.8.x history — unified blind/hybrid/vision pipeline (v0.8.2), compact MCP surface, Linux AT-SPI + Wayland support, Electron/WebView2 bridge, and session-reliability fixes.

---

## Quick Start

### Windows

```powershell
powershell -c "irm https://clawdcursor.com/install.ps1 | iex"
clawdcursor start
```

### macOS

```bash
curl -fsSL https://clawdcursor.com/install.sh | bash
clawdcursor grant     # Accessibility + Screen Recording
clawdcursor start
```

### Linux

```bash
curl -fsSL https://clawdcursor.com/install.sh | bash
clawdcursor start
```

The server auto-detects your provider from environment variables, or set it explicitly:

```bash
clawdcursor start --provider anthropic --api-key sk-ant-...
clawdcursor start --provider openai    # OPENAI_API_KEY
clawdcursor start --provider ollama    # local, offline, free
```

See [docs/MACOS-SETUP.md](docs/MACOS-SETUP.md) for macOS permission setup.

---

## Integration

Three transports. Same tool catalog behind each.

### 1. Autonomous agent &mdash; `clawdcursor start`

Ships with a built-in agent. Send a plain-English task, get a result.

```bash
clawdcursor start
curl http://localhost:3847/task -d '{"task":"Open Notepad and write Hello"}'
```

### 2. Tool server &mdash; `clawdcursor serve`

REST-only. Bring your own agent.

```bash
clawdcursor serve
curl http://localhost:3847/tools                        # discover
curl http://localhost:3847/execute/mouse_click -d '{"x":500,"y":300}'
```

### 3. MCP server &mdash; `clawdcursor mcp`

stdio MCP for Claude Code, Cursor, Windsurf, Zed, and any MCP-aware client.

```jsonc
// ~/.claude/settings.json
{
  "mcpServers": {
    "clawdcursor": {
      "command": "node",
      "args": ["/path/to/clawdcursor/dist/index.js", "mcp"]
    }
  }
}
```

---

## Tool Surface

Two tool catalogs are exposed side-by-side. Pick the one that fits your agent.

### Compact (6 compound tools, recommended)

Anthropic `computer_20250124`-style: one tool per capability, with an `action` enum for the verb. Small prompt footprint (~1,500 tokens), easy to learn, the default for most agents.

| Tool | Actions |
|---|---|
| `computer` | `screenshot`, `click`, `type`, `key`, `scroll`, `drag`, `drag_path`, `wait` |
| `accessibility` | `read_screen`, `find`, `get_focused`, `wait_for_element`, `invoke` |
| `window` | `list`, `focus`, `set_state`, `set_bounds`, `get_active` |
| `system` | `open_app`, `detect_webview`, `relaunch_with_cdp`, `read_clipboard`, `write_clipboard` |
| `browser` | `connect`, `click`, `type`, `read_text`, `evaluate`, `navigate` |
| `task` | `delegate`, `status`, `confirm`, `abort` |

Activate with `clawdcursor mcp --compact` or `GET /tools?mode=compact`.

### Granular (74 individual tools, power users)

Full catalog for agents that prefer one tool per action. Grouped by capability:

| Category | Count | Examples |
|---|---|---|
| Perception | 9 | `screenshot`, `read_screen`, `smart_read`, `ocr_read_screen`, `get_active_window` |
| Mouse | 6 | `mouse_click`, `mouse_double_click`, `mouse_drag`, `mouse_drag_stepped`, `mouse_scroll` |
| Keyboard | 5 | `key_press`, `type_text`, `smart_type`, `shortcuts_list`, `shortcuts_execute` |
| Window / App | 8 | `focus_window`, `open_app`, `get_windows`, `invoke_element`, `detect_webview_apps` |
| Browser (CDP) | 10 | `cdp_connect`, `cdp_click`, `cdp_type`, `cdp_read_text`, `cdp_evaluate` |
| Accessibility | 6 | `get_ui_tree`, `find_elements`, `wait_for_element`, `get_focused_element` |
| Orchestration | 6 | `smart_click`, `navigate_browser`, `delegate_to_agent`, `wait` |
| &hellip; | &hellip; | &hellip; |

Full catalog at `GET /tools` or `clawdcursor mcp`.

---

## Pipeline

The built-in agent runs a unified blind/hybrid/vision loop. One agent, three modes, same tool catalog. The router picks the cheapest mode that can complete the task.

```
         ┌────────────────────────────────────────────┐
task ──▶ │  Router   (regex shortcuts · zero LLM)    │ ──▶ done
         └───────────────────┬────────────────────────┘
                             │  (no match)
                             ▼
         ┌────────────────────────────────────────────┐
         │  Blind     (accessibility tree only)       │ ──▶ done
         └───────────────────┬────────────────────────┘
                             │  (a11y sparse, stagnation)
                             ▼
         ┌────────────────────────────────────────────┐
         │  Hybrid    (a11y + screenshot-on-demand)   │ ──▶ done
         └───────────────────┬────────────────────────┘
                             │  (still stuck)
                             ▼
         ┌────────────────────────────────────────────┐
         │  Vision    (screenshot every turn)         │ ──▶ done
         └────────────────────────────────────────────┘
```

Every tool call routes through a single `safety.evaluate()` chokepoint. The agent cannot bypass this path — it is the only way tools execute.

**Ground-truth verification.** On claims of completion, six independent signals are checked against the post-task screen: pixel diff, window-state change, focus change, OCR delta, task-type assertions (`send_email`, `navigate_url`, `open_app`, `type_text`, etc.), and anti-pattern detection (error dialogs, auth failures, "cannot send", "draft saved"). Weighted voting with hard-fail rules. The agent cannot self-report its way past the verifier.

**Runaway guard.** If the agent calls the same tool with identical arguments three or more times in a six-turn window, the loop exits with a targeted diagnostic. Catches the common "retry because a11y is opaque" anti-pattern on Electron/WebView2 apps.

---

## API

Base URL: `http://localhost:3847` (localhost-only, bearer-token auth)

| Endpoint | Method | Purpose |
|---|---|---|
| `/tools` | GET | Full catalog in OpenAI function-calling format. `?mode=compact` for the 6-tool surface. |
| `/execute/:name` | POST | Execute a tool by name. Returns structured JSON. |
| `/task` | POST | Submit a plain-English task to the built-in agent. |
| `/status` | GET | Current agent state and active task. |
| `/screenshot` | GET | Current screen as PNG. |
| `/task-logs` | GET | Recent task logs as JSONL. |
| `/confirm` | POST | Approve or reject a safety-gated action. |
| `/abort` | POST | Stop the current task. |
| `/health` | GET | Version, uptime, and health check. |

---

## Safety

Tools are classified into three tiers, enforced at the single `safety.evaluate()` chokepoint:

| Tier | Actions | Behavior |
|---|---|---|
| Auto | Reading, navigation, opening apps | Executes immediately |
| Preview | Typing, form fill, arbitrary input | Logged before executing |
| Confirm | Sending messages, deleting, purchases | Pauses for user approval |

Additional hardening: server binds to `localhost` only, bearer-token authentication on every request, dangerous key combinations (Cmd+Q, Alt+F4, Ctrl+Alt+Del) blocked by default, first-run consent prompt required.

---

## CLI

```
clawdcursor start        Autonomous agent (built-in LLM pipeline)
clawdcursor serve        REST-only tool server
clawdcursor mcp          MCP stdio server
clawdcursor doctor       Diagnose install and configuration
clawdcursor grant        Grant macOS permissions (interactive)
clawdcursor task <t>     Send a task to a running agent
clawdcursor stop         Stop all running modes (start, serve, mcp)
clawdcursor dashboard    Open the web dashboard

Options:
  --port <port>          Default: 3847
  --provider <name>      anthropic | openai | gemini | groq | ollama | deepseek | openrouter
  --model <model>        Override the default model for the provider
  --api-key <key>        Provider API key (else read from env)
  --base-url <url>       OpenAI-compatible endpoint
  --compact              Expose compact 6-tool surface (MCP / serve)
  --accept               Skip the consent prompt (non-interactive)
```

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
- **macOS** — Xcode CLI tools (`xcode-select --install`), then `clawdcursor grant` for Accessibility + Screen Recording
- **Linux** — `tesseract-ocr` (OCR), `at-spi2-core` + `python3-gi` (accessibility), `ydotool` or `wtype` (Wayland input)
- **AI provider key** — optional; works fully offline with Ollama

---

## Tech Stack

TypeScript · Node.js 20+ · nut-js · Playwright · sharp · Express · Hono · Model Context Protocol SDK · Zod

---

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">
  <a href="https://clawdcursor.com">clawdcursor.com</a>
</p>
