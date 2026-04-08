#!/bin/bash
# Build script for ClawdCursor native helper (macOS only)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "🔨 Building ClawdCursor native helper..."

# Build all targets in release mode
swift build -c release

# Get the build directory
BUILD_DIR=".build/release"

# Create the .app bundle structure
APP_DIR="ClawdCursor.app/Contents/MacOS"
mkdir -p "$APP_DIR"

# Copy binaries into the bundle
cp "$BUILD_DIR/ClawdCursorHost" "$APP_DIR/"
cp "$BUILD_DIR/clawdcursor-helper" "$APP_DIR/"
cp "$BUILD_DIR/screenshot-helper" "$APP_DIR/"
cp "$BUILD_DIR/permission-check" "$APP_DIR/"

echo "✅ Built ClawdCursor.app"

# Check if we should sign
if [[ -n "$CLAWDCURSOR_SIGN_IDENTITY" ]]; then
    echo "🔐 Signing with identity: $CLAWDCURSOR_SIGN_IDENTITY"
    codesign --sign "$CLAWDCURSOR_SIGN_IDENTITY" \
        --options runtime \
        --entitlements entitlements.plist \
        --force \
        "ClawdCursor.app"
    echo "✅ Signed ClawdCursor.app"
elif [[ "$1" == "--adhoc" ]]; then
    echo "🔐 Ad-hoc signing..."
    codesign --sign - \
        --options runtime \
        --entitlements entitlements.plist \
        --force \
        "ClawdCursor.app"
    echo "✅ Ad-hoc signed ClawdCursor.app"
else
    echo "⚠️  Not signed. Set CLAWDCURSOR_SIGN_IDENTITY or use --adhoc"
fi

echo ""
echo "📦 Output: $SCRIPT_DIR/ClawdCursor.app"
echo ""
echo "To test permissions:"
echo "  ./ClawdCursor.app/Contents/MacOS/permission-check"
echo ""
echo "To run the helper:"
echo "  open ClawdCursor.app"
