#!/bin/bash
# Build script for ClawdCursor native helper (macOS only)
# Usage: ./build.sh [--adhoc]
#   --adhoc is now the DEFAULT behavior (required for TCC on macOS 26+)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure this script is executable (no dependency on caller having set +x)
if [ ! -x "$0" ]; then
    chmod +x "$0"
fi

echo "🔨 Building ClawdCursor native helper..."

# Build all targets in release mode
if ! swift build -c release; then
    echo "❌ Swift build failed. Ensure Xcode Command Line Tools are installed:"
    echo "   xcode-select --install"
    exit 1
fi

# Get the build directory
BUILD_DIR=".build/release"

# Create the .app bundle structure
APP_DIR="ClawdCursor.app/Contents/MacOS"
mkdir -p "$APP_DIR"

# These four binaries are ALL required for correct operation
REQUIRED_BINARIES="ClawdCursorHost clawdcursor-helper screenshot-helper permission-check"
MISSING=0

for binary in $REQUIRED_BINARIES; do
    if [ -f "$BUILD_DIR/$binary" ]; then
        cp "$BUILD_DIR/$binary" "$APP_DIR/"
        echo "   ✓ Copied $binary"
    else
        echo "   ❌ MISSING required binary: $binary"
        MISSING=1
    fi
done

if [ "$MISSING" -eq 1 ]; then
    echo ""
    echo "❌ Build incomplete — one or more required binaries are missing."
    echo "   Check the swift build output above for compilation errors."
    exit 1
fi

echo "✅ Built ClawdCursor.app"

# Code signing (REQUIRED for TCC on macOS 26+ / Tahoe)
# Without signing, the app won't appear in System Settings privacy panels
if [[ -n "$CLAWDCURSOR_SIGN_IDENTITY" ]]; then
    echo "🔐 Signing with Developer ID: $CLAWDCURSOR_SIGN_IDENTITY"
    codesign --sign "$CLAWDCURSOR_SIGN_IDENTITY" \
        --options runtime \
        --entitlements entitlements.plist \
        --force \
        --deep \
        "ClawdCursor.app"
    echo "✅ Signed with Developer ID"
else
    # Ad-hoc sign by default — CRITICAL for TCC to recognize the app
    echo "🔐 Ad-hoc signing (required for TCC permissions)..."
    if [ -f "entitlements.plist" ]; then
        codesign --sign - \
            --options runtime \
            --entitlements entitlements.plist \
            --force \
            --deep \
            "ClawdCursor.app"
    else
        codesign --sign - \
            --force \
            --deep \
            "ClawdCursor.app"
    fi
    echo "✅ Ad-hoc signed"
fi

# Verify signature
if codesign -v "ClawdCursor.app" 2>/dev/null; then
    echo "✅ Signature verified"
else
    echo "⚠️  Signature verification failed — TCC permissions may not work"
    echo "   On macOS 26+ (Tahoe), unsigned binaries don't appear in privacy settings"
fi

echo ""
echo "📦 Output: $SCRIPT_DIR/ClawdCursor.app"
echo ""
echo "To test permissions:"
echo "  ./ClawdCursor.app/Contents/MacOS/permission-check"
echo ""
echo "To launch:"
echo "  open ClawdCursor.app"
