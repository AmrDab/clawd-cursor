/// permission-check - Quick permission status checker for Node.js integration
/// Returns JSON: {"accessibility": bool, "screenRecording": bool}
/// Use AXTrustedCheckOptionPrompt: true to trigger the system prompt dialog

import Foundation
import ApplicationServices
import CoreGraphics

struct PermissionStatus: Codable {
    let accessibility: Bool
    let screenRecording: Bool
    let processPath: String
    let bundleId: String?
}

// Check Accessibility permission (does NOT prompt - use --prompt flag for that)
// Pattern from mediar-ai/MacosUseSDK - use kCFBooleanTrue/False explicitly
let shouldPrompt = CommandLine.arguments.contains("--prompt")
let promptValue: CFBoolean = shouldPrompt ? kCFBooleanTrue : kCFBooleanFalse
let axOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: promptValue] as CFDictionary
let axGranted = AXIsProcessTrustedWithOptions(axOptions)

// Check Screen Recording permission
// CGPreflightScreenCaptureAccess() returns current state without prompting
// CGRequestScreenCaptureAccess() would trigger the prompt
let screenGranted = CGPreflightScreenCaptureAccess()

// Get process info for debugging
let processPath = ProcessInfo.processInfo.arguments[0]
let bundleId = Bundle.main.bundleIdentifier

let status = PermissionStatus(
    accessibility: axGranted,
    screenRecording: screenGranted,
    processPath: processPath,
    bundleId: bundleId
)

let encoder = JSONEncoder()
encoder.outputFormatting = .sortedKeys
if let jsonData = try? encoder.encode(status),
   let jsonString = String(data: jsonData, encoding: .utf8) {
    print(jsonString)
} else {
    fputs("{\"error\": \"Failed to encode status\"}\n", stderr)
    exit(1)
}
