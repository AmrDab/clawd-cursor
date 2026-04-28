[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/amrdab-clawdcursor-badge.png)](https://mseep.ai/app/amrdab-clawdcursor)

<p align="center">
  <img src="docs/favicon.svg" width="80" alt="Clawd Cursor">
</p>

<h1 align="center">Clawd Cursor</h1>

<p align="center">
  <strong>OS-level desktop automation server. Gives any AI model eyes, hands, and ears on a real computer.</strong><br>
  Model-agnostic &middot; Works with Claude, GPT, Gemini, Llama, or any tool-calling model &middot; Free with local models
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
  <a href="#connect">Connect</a> &middot;
  <a href="#api">API</a> &middot;
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

## What's New in v0.8.0 — V2 Architecture

A vision-first alternative to the legacy cascade, opt in with `--v2`:

```bash
clawdcursor start --v2
```

- **Ground-truth verifier** — six independent signals (pixel diff, window state, focus change, OCR delta, task-type assertions, error-pattern detection). Independent of the agent, so it can't be fooled by "done" self-reports. Caught false positives in testing where the legacy pipeline reported `UNVERIFIED_SUCCESS`.
- **Single vision-first agent loop** — screenshot → tool call → new screenshot → repeat. 6-rule system prompt (down from 36). Works with Anthropic, OpenAI, OpenRouter, or anything with vision + tool calls.
- **PlatformAdapter abstraction** — platform-specific code now lives in `src/v2/platform/{macos,windows,linux}.ts` behind one interface. Replaces 142+ scattered `if (IS_MAC)` branches across 34 files. Adding a new OS is a single file.
- **Legacy pipeline untouched** — `clawdcursor start` (no flag) behaves exactly as before. Zero breaking changes.

Full history in [CHANGELOG.md](CHANGELOG.md).

---

## What It Does

Clawd Cursor is a **tool server**. It wraps your desktop as 42 callable tools: mouse, keyboard, screen, windows, browser. Any AI that can call functions can use it.

```
Your AI → "Click the Send button"  →  find_element + mouse_click
Your AI → "What's on screen?"      →  desktop_screenshot + read_screen
Your AI → "Open Chrome to gmail"   →  open_app + navigate_browser
```

No app-specific integrations. No per-service API keys. If it's on screen, clawdcursor can interact with it.

---

## Quick Start

**Windows**
```powershell
powershell -c "irm https://clawdcursor.com/install.ps1 | iex"
clawdcursor start
```

**macOS**
```bash
curl -fsSL https://clawdcursor.com/install.sh | bash
clawdcursor grant     # grant Accessibility + Screen Recording permissions
clawdcursor start
```

**Linux**
```bash
curl -fsSL https://clawdcursor.com/install.sh | bash
clawdcursor start
```

First run auto-detects your AI provider from environment variables. Or be explicit:
```bash
clawdcursor start --provider anthropic --api-key sk-ant-...
clawdcursor start --provider gemini     # GEMINI_API_KEY in env
clawdcursor start                       # free with Ollama
```

> See [docs/MACOS-SETUP.md](docs/MACOS-SETUP.md) for macOS permission setup.

---

## Connect

Three modes. Same 42 tools.

### 1. Built-in Agent (`start`)
Full autonomous agent. Send a task, get a result.
```bash
clawdcursor start
curl http://localhost:3847/task -d '{"task": "Open Notepad and write Hello"}'
```

### 2. Tools-Only Server (`serve`)
Exposes tools over REST. You bring the AI.
```bash
clawdcursor serve
curl http://localhost:3847/tools          # discover tools
curl http://localhost:3847/execute/mouse_click -d '{"x":500,"y":300}'
```

### 3. MCP Mode (`mcp`)
MCP stdio server for Claude Code, Cursor, Windsurf, Zed.
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

## Tools

42 tools across 6 categories:

| Category | Count | Examples |
|----------|-------|---------|
| Perception | 9 | `desktop_screenshot`, `read_screen`, `get_active_window`, `smart_read`, `ocr_read_screen` |
| Mouse | 6 | `mouse_click`, `mouse_double_click`, `mouse_drag`, `mouse_scroll` |
| Keyboard | 5 | `key_press`, `type_text`, `smart_type`, `shortcuts_list`, `shortcuts_execute` |
| Window / App | 6 | `focus_window`, `open_app`, `get_windows`, `invoke_element` |
| Browser (CDP) | 10 | `cdp_connect`, `cdp_click`, `cdp_type`, `cdp_read_text`, `cdp_evaluate` |
| Orchestration | 6 | `smart_click`, `navigate_browser`, `delegate_to_agent`, `wait` |

---

## Pipeline

Two pipelines ship side by side. Same 42 tools, same MCP interface — only the decision-maker differs.

### V2 — vision-first (`--v2`)

Three stages, each does one thing:

```
┌──────────┐     ┌────────────────┐     ┌──────────────────────┐
│  Router  │  →  │  VisionAgent   │  →  │  GroundTruthVerifier │
│          │     │                │     │                      │
│  regex   │     │  screenshot    │     │  pixel diff · window │
│  shortcut│     │  → tool call   │     │  focus · OCR delta   │
│  zero    │     │  → screenshot  │     │  task assertions     │
│  LLM     │     │  → repeat      │     │  anti-patterns       │
└──────────┘     └────────────────┘     └──────────────────────┘
```

Router handles trivial tasks ("open Safari") without a model. Everything else hits the VisionAgent (16 tools, 6-rule prompt, model-agnostic). The Verifier runs six independent checks against the screen *after* the agent claims done — so "done" has to be true, not just asserted.

### Legacy — text-first cascade (default, no flag)

Cheapest-first. Kept for backwards compatibility.

```
L1.5   Deterministic flows  →  hardcoded sequences. Zero LLM.
L2     Skill Cache          →  learned action patterns. Zero LLM.
L2.5   OCR Reasoner         →  OS OCR + cheap text LLM. ~90% of tasks.
L2.5b  A11y Reasoner        →  fallback when OCR is unavailable.
L3     Computer Use         →  vision model. Last resort.
```

---

## API

`http://localhost:3847`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/tools` | GET | All tools in OpenAI function-calling format |
| `/execute/:name` | POST | Execute a tool |
| `/task` | POST | Submit a plain-English task |
| `/status` | GET | Agent state |
| `/screenshot` | GET | Current screen as PNG |
| `/task-logs` | GET | Recent task logs (JSONL) |
| `/confirm` | POST | Approve/reject a safety-gated action |
| `/abort` | POST | Stop current task |
| `/health` | GET | Version + health check |

---

## Safety

| Tier | Actions | Behavior |
|------|---------|----------|
| Auto | Navigation, reading, opening apps | Runs immediately |
| Preview | Typing, form filling | Logged before executing |
| Confirm | Sending messages, deleting, purchases | Pauses for approval |

Server binds to `localhost` only. Dangerous key combos blocked. Consent required on first run.

---

## CLI

```
clawdcursor start        Full agent (built-in LLM pipeline)
clawdcursor serve        Tools-only REST server
clawdcursor mcp          MCP stdio server
clawdcursor doctor       Diagnose and configure
clawdcursor grant        Grant macOS permissions (interactive)
clawdcursor task <t>     Send task to running agent
clawdcursor stop         Stop server
clawdcursor dashboard    Open web dashboard

Options:
  --port <port>          Default: 3847
  --provider <name>      anthropic | openai | gemini | groq | ollama | deepseek | ...
  --model <model>        Override model
  --api-key <key>        Provider API key
  --base-url <url>       OpenAI-compatible endpoint
  --accept               Skip consent prompt (non-interactive)
  --v2                   Use v2 architecture (vision-first agent + ground truth verifier)
```

---

## Platform Support

Platform-specific code lives in `src/v2/platform/{macos,windows,linux}.ts` behind one `PlatformAdapter` interface — business logic never reads `process.platform`.

| Platform | UI Automation | OCR | Browser |
|----------|---------------|-----|---------|
| **Windows** x64 / ARM64 | PowerShell + UI Automation | Windows.Media.Ocr | Chrome / Edge |
| **macOS** Intel / Apple Silicon | JXA + System Events | Apple Vision | Chrome / Edge |
| **Linux** x64 / ARM64 | AT-SPI | Tesseract | Chrome / Edge |

## Prerequisites

- Node.js 20+
- **macOS** — Xcode CLI tools: `xcode-select --install`, then `clawdcursor grant` for Accessibility + Screen Recording
- **Linux** — `sudo apt install tesseract-ocr`
- **AI key** — optional; works fully offline with Ollama

## Tech Stack

TypeScript · Node.js · nut-js · Playwright · sharp · Express · MCP SDK · Zod

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">
  <a href="https://clawdcursor.com">clawdcursor.com</a>
</p>
