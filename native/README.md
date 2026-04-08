# ClawdCursor Native Helper (macOS)

Native Swift host app for macOS that consolidates all TCC (Transparency, Consent, and Control) permissions under a single app identity.

## Why?

macOS binds permissions to code signing identity. When Node.js spawns shell scripts and helpers, each binary can end up with its own permission entry in System Settings. Worse, on macOS 14+ (Sonoma) and especially macOS 26 (Tahoe), unbundled binaries may not even appear in the Privacy settings UI.

This native helper:
1. Bundles everything into `ClawdCursor.app` — one identity in System Settings
2. Uses `CGPreflightScreenCaptureAccess()` and `AXIsProcessTrustedWithOptions()` to detect permission state
3. Provides clear error messages when permissions are missing
4. Isolates Screen Recording in a subprocess to avoid ReplayKit CPU leaks

## Building

Requires Xcode command line tools:

```bash
cd native
./build.sh
```

For ad-hoc signing (works locally):
```bash
./build.sh --adhoc
```

For proper distribution, set your signing identity:
```bash
export CLAWDCURSOR_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
./build.sh
```

## Components

### `permission-check`
Quick standalone binary that returns permission status as JSON:
```bash
./ClawdCursor.app/Contents/MacOS/permission-check
# {"accessibility":true,"screenRecording":false,"processPath":"...","bundleId":"com.clawdcursor.helper"}
```

Use `--prompt` to trigger the system permission dialog:
```bash
./ClawdCursor.app/Contents/MacOS/permission-check --prompt
```

### `ClawdCursorHost` (app executable)
The app process now owns IPC over localhost (`127.0.0.1:3848` by default):

- `GET /health` host liveness
- `GET /status` permission status
- `POST /rpc` JSON-RPC proxy for desktop methods

The CLI checks/launches this app on `clawdcursor start`.

### `clawdcursor-helper`
Worker binary used by the host app for JSON-RPC methods:

```json
{"id":1,"method":"checkPermissions"}
{"id":2,"method":"traverseAccessibilityTree","params":{"pid":12345}}
{"id":3,"method":"click","params":{"x":100,"y":200}}
{"id":4,"method":"type","params":{"text":"Hello"}}
{"id":5,"method":"pressKey","params":{"key":"return","modifiers":["cmd"]}}
{"id":6,"method":"openApp","params":{"name":"Safari"}}
{"id":7,"method":"getWindowList"}
```

### `screenshot-helper`
Isolated subprocess for screen capture. Prevents ReplayKit CPU spin after capture:
```bash
./ClawdCursor.app/Contents/MacOS/screenshot-helper <windowId> /tmp/screenshot.png
./ClawdCursor.app/Contents/MacOS/screenshot-helper --fullscreen /tmp/fullscreen.png
```

## Permissions Required

| Permission | Used By | How to Grant |
|------------|---------|--------------|
| Accessibility | `clawdcursor-helper` | System Settings → Privacy & Security → Accessibility → Enable "ClawdCursor Helper" |
| Screen Recording | `screenshot-helper` | System Settings → Privacy & Security → Screen & System Audio Recording → Enable "ClawdCursor Helper" |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Node.js (clawdcursor CLI)                                   │
│   └── NativeHelper class (native-helper.ts)                 │
│         └── localhost IPC (127.0.0.1:3848)                  │
├─────────────────────────────────────────────────────────────┤
│ ClawdCursor.app/Contents/MacOS/                             │
│   ├── ClawdCursorHost    (bundle identity + IPC endpoint)   │
│   ├── clawdcursor-helper  (AX traversal, input, app ctrl)   │
│   ├── screenshot-helper   (isolated screen capture)         │
│   └── permission-check    (quick permission status)         │
└─────────────────────────────────────────────────────────────┘
```

## Debugging TCC

Check what TCC has for clawdcursor:
```bash
sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db \
  "SELECT client, auth_value, service FROM access WHERE client LIKE '%clawdcursor%'"
```

Reset permissions to test first-run:
```bash
tccutil reset Accessibility com.clawdcursor.helper
tccutil reset ScreenCapture com.clawdcursor.helper
```
