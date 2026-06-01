#!/bin/bash
# Clawd Cursor Installer for macOS / Linux
# Usage: curl -fsSL https://clawdcursor.com/install.sh | bash
# Specify version: VERSION=v0.9.9 curl -fsSL https://clawdcursor.com/install.sh | bash

set -e
set -o pipefail  # Capture failures in pipelines (critical for build error detection)

VERSION="${VERSION:-main}"
INSTALL_DIR="$HOME/clawdcursor"

echo ""
echo "  /\___/\\"
echo " ( >^.^< )  Clawd Cursor Installer"
echo "  )     ("
echo " (_)_(_)_)"
echo ""

# ── 1. Check Node.js ─────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
    echo "  ❌ Node.js not found. Install v20+ from https://nodejs.org"
    exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "  ❌ Node.js $(node --version) is too old. Update to v20+: https://nodejs.org"
    exit 1
fi
echo "  ✅ Node.js $(node --version)"

# ── 2. Check git ──────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
    echo "  ❌ git not found. Install: brew install git (macOS) or sudo apt install git (Linux)"
    exit 1
fi
echo "  ✅ $(git --version)"

# ── 3. Clone or update ───────────────────────────────────────────────────────
echo ""
DISPLAY_VERSION="$VERSION"
[ "$VERSION" = "main" ] && DISPLAY_VERSION="latest (main)"

ERR_LOG=$(mktemp -t clawd-installer.XXXXXX 2>/dev/null || echo "/tmp/clawd-installer-$$.log")
trap 'rm -f "$ERR_LOG"' EXIT
indent_err() { sed 's/^/      /' "$ERR_LOG"; }

if [ -d "$INSTALL_DIR/.git" ]; then
    # Update existing install — only proceed if the working tree is clean.
    # The previous "git checkout && pull || rm -rf" path silently destroyed
    # user state when git complained (dirty tree, diverged history, etc.).
    echo "  📦 Updating to $DISPLAY_VERSION..."
    cd "$INSTALL_DIR"

    DIRTY=$(git status --porcelain 2>/dev/null)
    if [ -n "$DIRTY" ]; then
        echo "  ❌ Refusing to update: $INSTALL_DIR has uncommitted changes."
        echo ""
        echo "$DIRTY" | head -20 | sed 's/^/      /'
        DIRTY_COUNT=$(echo "$DIRTY" | wc -l | tr -d ' ')
        [ "$DIRTY_COUNT" -gt 20 ] && echo "      ... and $((DIRTY_COUNT - 20)) more"
        echo ""
        echo "  Pick one and re-run the installer:"
        echo "    • Stash:      cd $INSTALL_DIR && git stash"
        echo "    • Discard:    cd $INSTALL_DIR && git reset --hard && git clean -fd"
        echo "    • Sidecar:    INSTALL_DIR=\$HOME/clawdcursor-new curl -fsSL https://clawdcursor.com/install.sh | bash"
        exit 1
    fi

    if ! git fetch --all --tags --quiet 2>"$ERR_LOG"; then
        echo "  ❌ Failed to fetch from GitHub (network or auth issue):"
        indent_err
        exit 1
    fi

    if ! git checkout "$VERSION" --quiet 2>"$ERR_LOG"; then
        echo "  ❌ Failed to switch to '$VERSION':"
        indent_err
        echo "      (tree is clean — likely the ref doesn't exist on origin)"
        exit 1
    fi

    # Only pull if we landed on a branch — tag/SHA checkouts are detached.
    if git symbolic-ref -q HEAD >/dev/null 2>&1; then
        if ! git pull --ff-only --quiet 2>"$ERR_LOG"; then
            echo "  ❌ Failed to fast-forward '$VERSION':"
            indent_err
            echo "      Local branch may have diverged from origin. Resolve manually."
            exit 1
        fi
    fi
elif [ -d "$INSTALL_DIR" ]; then
    # Directory exists but isn't a git checkout. Could be user data we
    # don't recognise — refuse rather than silently rm -rf.
    echo "  ❌ $INSTALL_DIR exists but is not a git checkout."
    echo "      Move or remove it manually, then re-run. (We won't delete"
    echo "      it for you because it might contain unrelated files.)"
    exit 1
else
    echo "  📦 Downloading $DISPLAY_VERSION..."
    if ! git clone https://github.com/AmrDab/clawdcursor.git --branch "$VERSION" "$INSTALL_DIR" --quiet 2>"$ERR_LOG"; then
        echo "  ❌ Clone failed:"
        indent_err
        exit 1
    fi
fi

# ── 4. Install dependencies ──────────────────────────────────────────────────
echo "  📦 Installing dependencies..."
cd "$INSTALL_DIR"
npm install --loglevel error 2>/dev/null

# ── 5. Build ──────────────────────────────────────────────────────────────────
echo "  🔨 Building..."
npm run build 2>/dev/null

# ── 5b. Build native macOS host app (REQUIRED on macOS) ──────────────────────
if [ "$(uname)" = "Darwin" ]; then
    NATIVE_HOST="$INSTALL_DIR/native/ClawdCursor.app/Contents/MacOS/ClawdCursorHost"
    PERM_CHECK="$INSTALL_DIR/native/ClawdCursor.app/Contents/MacOS/permission-check"
    BUILD_LOG="/tmp/clawdcursor-build-$$.log"
    
    # Check Swift is available
    if ! command -v swift &>/dev/null; then
        echo ""
        echo "  ❌ Swift not found — REQUIRED for macOS"
        echo ""
        echo "     Install Xcode Command Line Tools:"
        echo "       xcode-select --install"
        echo ""
        echo "     Then re-run the installer."
        exit 1
    fi
    
    echo "  🔨 Building macOS native host app..."
    cd "$INSTALL_DIR/native"
    
    # Build with ad-hoc signing (CRITICAL for TCC on macOS 26+)
    # Use temp file to capture exit status properly (bash pipeline bug workaround)
    set +e  # Don't exit on error, we'll handle it
    bash ./build.sh --adhoc > "$BUILD_LOG" 2>&1
    BUILD_EXIT=$?
    set -e
    
    # Show build output (indented)
    if [ -f "$BUILD_LOG" ]; then
        while IFS= read -r line; do echo "     $line"; done < "$BUILD_LOG"
        rm -f "$BUILD_LOG"
    fi
    
    # Check build exit status
    if [ $BUILD_EXIT -ne 0 ]; then
        echo ""
        echo "  ❌ Native host app build FAILED (exit code $BUILD_EXIT)"
        echo ""
        echo "     This is REQUIRED for macOS. Common fixes:"
        echo "       • Install Xcode Command Line Tools: xcode-select --install"
        echo "       • Update macOS/Xcode: softwareupdate --install -a"
        echo "       • Check build errors above"
        echo ""
        echo "     Manual build:"
        echo "       cd $INSTALL_DIR/native && bash ./build.sh --adhoc"
        exit 1
    fi
    
    # Verify ALL required binaries exist
    NATIVE_APP_DIR="$INSTALL_DIR/native/ClawdCursor.app/Contents/MacOS"
    MISSING_BINS=""
    for bin in ClawdCursorHost clawdcursor-helper screenshot-helper permission-check; do
        if [ ! -f "$NATIVE_APP_DIR/$bin" ]; then
            MISSING_BINS="$MISSING_BINS $bin"
        fi
    done
    if [ -n "$MISSING_BINS" ]; then
        echo ""
        echo "  ❌ Build succeeded but required binaries are missing:$MISSING_BINS"
        echo ""
        echo "     Try rebuilding manually:"
        echo "       cd $INSTALL_DIR/native && bash ./build.sh --adhoc"
        exit 1
    fi
    
    # Verify code signing (critical for TCC)
    if ! codesign -v "$INSTALL_DIR/native/ClawdCursor.app" 2>/dev/null; then
        echo ""
        echo "  ⚠️  App not code signed — TCC permissions may not work"
        echo "     Attempting ad-hoc signing..."
        if codesign --sign - --force "$INSTALL_DIR/native/ClawdCursor.app" 2>/dev/null; then
            echo "  ✅ Ad-hoc signed successfully"
        else
            echo "  ⚠️  Signing failed — you may need to grant permissions manually"
        fi
    fi
    
    # Quick TCC check (non-blocking, just informational)
    if [ -f "$PERM_CHECK" ]; then
        echo "  🔍 Checking TCC permissions..."
        PERM_OUT=$("$PERM_CHECK" 2>/dev/null || true)
        if echo "$PERM_OUT" | grep -q '"accessibility":true'; then
            echo "     ✅ Accessibility: granted"
        else
            echo "     ⚠️  Accessibility: not yet granted"
            echo "        → System Settings → Privacy & Security → Accessibility → enable ClawdCursor"
        fi
        if echo "$PERM_OUT" | grep -q '"screenRecording":true'; then
            echo "     ✅ Screen Recording: granted"
        else
            echo "     ⚠️  Screen Recording: not yet granted"
            echo "        → System Settings → Privacy & Security → Screen & System Audio Recording → enable ClawdCursor"
        fi
    fi
    
    echo "  ✅ Native host app built and signed"
    cd "$INSTALL_DIR"
fi

# ── 6. Link ───────────────────────────────────────────────────────────────────
echo "  🔗 Linking..."
npm link --force 2>/dev/null || true

# ── 7. Verify ─────────────────────────────────────────────────────────────────
echo ""

# Final macOS verification: ensure all native binaries exist
if [ "$(uname)" = "Darwin" ]; then
    NATIVE_APP_DIR="$INSTALL_DIR/native/ClawdCursor.app/Contents/MacOS"
    FINAL_MISSING=""
    for bin in ClawdCursorHost clawdcursor-helper screenshot-helper permission-check; do
        [ ! -f "$NATIVE_APP_DIR/$bin" ] && FINAL_MISSING="$FINAL_MISSING $bin"
    done
    if [ -n "$FINAL_MISSING" ]; then
        echo "  ❌ INSTALLATION INCOMPLETE"
        echo ""
        echo "     Missing native binaries:$FINAL_MISSING"
        echo "     These are required for clawdcursor to work on macOS."
        echo ""
        echo "     Try rebuilding manually:"
        echo "       cd $INSTALL_DIR/native && bash ./build.sh"
        echo ""
        exit 1
    fi
fi

if command -v clawdcursor &>/dev/null; then
    echo "  ✅ Clawd Cursor $(clawdcursor --version 2>/dev/null || echo $VERSION) installed!"
else
    NPM_PREFIX="$(npm prefix -g 2>/dev/null)/bin"
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$NPM_PREFIX"; then
        echo "  ✅ Installed, but npm's bin folder is not in your PATH."
        echo "     Add this to your shell profile (~/.bashrc or ~/.zshrc):"
        echo "       export PATH=\"$NPM_PREFIX:\$PATH\""
    else
        echo "  ✅ Installed! Reopen your terminal to use 'clawdcursor'."
    fi
fi

# Detect prior state so we don't tell the user to re-run one-time steps
# they already completed (consent, doctor config).
CONSENT_FILE="$HOME/.clawdcursor/consent"
CONFIG_FILE="$INSTALL_DIR/.clawdcursor-config.json"

echo ""
if [ ! -f "$CONSENT_FILE" ]; then
    echo "  Start here:"
    echo "    clawdcursor consent     One-time desktop control authorization"
    echo ""
    echo "  Then pick a path:"
else
    echo "  [OK] Consent already accepted from a previous install."
    echo ""
    echo "  Pick a path:"
fi
echo ""
echo "    Autonomous agent (clawdcursor brings the AI brain):"
if [ -f "$CONFIG_FILE" ]; then
    echo "      Config already saved — skip step 1 unless you want to reconfigure."
    echo "      1. clawdcursor doctor   (optional) Re-check / change AI provider + models"
else
    echo "      1. clawdcursor doctor   Configure AI provider + models"
fi
echo "      2. clawdcursor agent    Start the daemon (HTTP + MCP on :3847)"
echo ""
echo "    MCP-only (your editor brings the AI brain):"
echo "      Register \`clawdcursor mcp\` with Claude Code, Cursor, Windsurf, Zed, etc."
echo "      No daemon, no API key in clawdcursor — your editor handles both."
echo ""
echo "  Run now:"
if [ ! -f "$CONSENT_FILE" ]; then
    echo "    clawdcursor consent"
elif [ ! -f "$CONFIG_FILE" ]; then
    echo "    clawdcursor doctor"
else
    echo "    clawdcursor agent"
fi
echo ""
