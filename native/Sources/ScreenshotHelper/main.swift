/// screenshot-helper - Isolated screen capture subprocess
/// Runs in separate process to:
/// 1. Isolate Screen Recording TCC permission
/// 2. Prevent ReplayKit CPU spin bug (19% idle CPU after capture)
///
/// Usage: screenshot-helper <windowId> <outputPath>
///        screenshot-helper --fullscreen <outputPath>

import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func captureWindow(windowId: CGWindowID, outputPath: String) -> Bool {
    guard let image = CGWindowListCreateImage(
        .null,
        .optionIncludingWindow,
        windowId,
        [.boundsIgnoreFraming, .nominalResolution]
    ) else {
        fputs("error: failed to capture window \(windowId)\n", stderr)
        return false
    }
    return saveImage(image, to: outputPath)
}

func captureFullScreen(outputPath: String) -> Bool {
    guard let image = CGWindowListCreateImage(
        CGRect.infinite,
        .optionOnScreenOnly,
        kCGNullWindowID,
        [.nominalResolution]
    ) else {
        fputs("error: failed to capture screen\n", stderr)
        return false
    }
    return saveImage(image, to: outputPath)
}

func saveImage(_ image: CGImage, to path: String) -> Bool {
    let url = URL(fileURLWithPath: path)
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        fputs("error: failed to create image destination\n", stderr)
        return false
    }
    
    CGImageDestinationAddImage(destination, image, nil)
    
    if CGImageDestinationFinalize(destination) {
        print("{\"success\": true, \"path\": \"\(path)\", \"width\": \(image.width), \"height\": \(image.height)}")
        return true
    } else {
        fputs("error: failed to write image\n", stderr)
        return false
    }
}

// Check Screen Recording permission first
if !CGPreflightScreenCaptureAccess() {
    fputs("{\"error\": \"screen_recording_denied\", \"message\": \"Grant Screen Recording permission in System Settings > Privacy & Security > Screen & System Audio Recording\"}\n", stderr)
    exit(2)
}

// Parse arguments
let args = CommandLine.arguments
guard args.count >= 3 else {
    fputs("usage: screenshot-helper <windowId|--fullscreen> <outputPath>\n", stderr)
    exit(1)
}

let success: Bool
if args[1] == "--fullscreen" {
    success = captureFullScreen(outputPath: args[2])
} else if let windowId = UInt32(args[1]) {
    success = captureWindow(windowId: CGWindowID(windowId), outputPath: args[2])
} else {
    fputs("error: invalid window ID\n", stderr)
    exit(1)
}

exit(success ? 0 : 1)
