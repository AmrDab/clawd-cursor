/// ClawdCursor Native Helper - macOS Accessibility & Input Control
/// Communicates with Node.js via JSON-RPC over stdio
///
/// Commands:
/// - checkPermissions: Returns permission status
/// - traverseAccessibilityTree: Returns UI element tree for a PID
/// - click: Click at coordinates or element
/// - type: Type text
/// - pressKey: Press key combination
/// - openApp: Open application by name or bundle ID
/// - getWindowList: List visible windows

import Foundation
import ApplicationServices
import CoreGraphics
import AppKit

// MARK: - JSON-RPC Types

struct JsonRpcRequest: Codable {
    let id: Int
    let method: String
    let params: [String: AnyCodable]?
}

struct JsonRpcResponse: Codable {
    let id: Int
    let result: AnyCodable?
    let error: JsonRpcError?
}

struct JsonRpcError: Codable {
    let code: Int
    let message: String
}

// AnyCodable wrapper for dynamic JSON
struct AnyCodable: Codable {
    let value: Any
    
    init(_ value: Any) {
        self.value = value
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Cannot decode value")
        }
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encode(String(describing: value))
        }
    }
}

// MARK: - Accessibility Element

struct UIElement: Codable {
    let role: String?
    let title: String?
    let value: String?
    let description: String?
    let position: [String: CGFloat]?
    let size: [String: CGFloat]?
    let enabled: Bool
    let focused: Bool
    let children: [UIElement]?
}

// MARK: - Main Handler

class ClawdCursorHelper {
    static let shared = ClawdCursorHelper()
    
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }()
    
    private let decoder = JSONDecoder()
    
    func run() {
        // Check accessibility permission at startup (pattern from mediar-ai/MacosUseSDK)
        let axOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: kCFBooleanFalse] as CFDictionary
        if !AXIsProcessTrustedWithOptions(axOptions) {
            fputs("{\"error\": \"accessibility_denied\", \"message\": \"Grant Accessibility permission in System Settings > Privacy & Security > Accessibility\"}\n", stderr)
            // Continue anyway - some commands might not need it
        }
        
        // Read JSON-RPC requests from stdin
        while let line = readLine() {
            guard !line.isEmpty else { continue }
            handleRequest(line)
        }
    }
    
    func handleRequest(_ line: String) {
        guard let data = line.data(using: .utf8),
              let request = try? decoder.decode(JsonRpcRequest.self, from: data) else {
            fputs("{\"error\": \"parse_error\", \"message\": \"Invalid JSON-RPC request\"}\n", stderr)
            return
        }
        
        let response: JsonRpcResponse
        
        switch request.method {
        case "checkPermissions":
            response = checkPermissions(id: request.id)
        case "traverseAccessibilityTree":
            response = traverseAccessibilityTree(id: request.id, params: request.params)
        case "click":
            response = click(id: request.id, params: request.params)
        case "type":
            response = typeText(id: request.id, params: request.params)
        case "pressKey":
            response = pressKey(id: request.id, params: request.params)
        case "openApp":
            response = openApp(id: request.id, params: request.params)
        case "getWindowList":
            response = getWindowList(id: request.id)
        default:
            response = JsonRpcResponse(id: request.id, result: nil, error: JsonRpcError(code: -32601, message: "Method not found: \(request.method)"))
        }
        
        if let responseData = try? encoder.encode(response),
           let responseString = String(data: responseData, encoding: .utf8) {
            print(responseString)
            fflush(stdout)
        }
    }
    
    // MARK: - Commands
    
    func checkPermissions(id: Int) -> JsonRpcResponse {
        // Pattern from mediar-ai/MacosUseSDK
        let axOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: kCFBooleanFalse] as CFDictionary
        let axGranted = AXIsProcessTrustedWithOptions(axOptions)
        let screenGranted = CGPreflightScreenCaptureAccess()
        
        return JsonRpcResponse(id: id, result: AnyCodable([
            "accessibility": axGranted,
            "screenRecording": screenGranted
        ]), error: nil)
    }
    
    func traverseAccessibilityTree(id: Int, params: [String: AnyCodable]?) -> JsonRpcResponse {
        guard let pid = params?["pid"]?.value as? Int else {
            return JsonRpcResponse(id: id, result: nil, error: JsonRpcError(code: -32602, message: "Missing 'pid' parameter"))
        }
        
        // Caps from mediar-ai/MacosUseSDK - prevents hanging on complex apps
        let maxDepth = (params?["maxDepth"]?.value as? Int) ?? 100
        let maxElements = (params?["maxElements"]?.value as? Int) ?? 2000
        let maxSeconds: Double = 5.0
        let startTime = Date()
        
        let app = AXUIElementCreateApplication(pid_t(pid))
        AXUIElementSetMessagingTimeout(app, 5.0)
        var elementCount = 0
        var truncated = false
        
        func traverse(_ element: AXUIElement, depth: Int) -> UIElement? {
            // Check all caps
            if depth >= maxDepth || elementCount >= maxElements {
                truncated = true
                return nil
            }
            if Date().timeIntervalSince(startTime) > maxSeconds {
                truncated = true
                return nil
            }
            elementCount += 1
            AXUIElementSetMessagingTimeout(element, 2.0)
            
            var role: CFTypeRef?
            var title: CFTypeRef?
            var value: CFTypeRef?
            var desc: CFTypeRef?
            var position: CFTypeRef?
            var size: CFTypeRef?
            var enabled: CFTypeRef?
            var focused: CFTypeRef?
            var children: CFTypeRef?
            
            AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
            AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &title)
            AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
            AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &desc)
            AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &position)
            AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size)
            AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &enabled)
            AXUIElementCopyAttributeValue(element, kAXFocusedAttribute as CFString, &focused)
            AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
            
            var posDict: [String: CGFloat]? = nil
            if let pos = position, CFGetTypeID(pos) == AXValueGetTypeID() {
                var point = CGPoint.zero
                if AXValueGetValue(pos as! AXValue, .cgPoint, &point) {
                    posDict = ["x": point.x, "y": point.y]
                }
            }
            
            var sizeDict: [String: CGFloat]? = nil
            if let sz = size, CFGetTypeID(sz) == AXValueGetTypeID() {
                var s = CGSize.zero
                if AXValueGetValue(sz as! AXValue, .cgSize, &s) {
                    sizeDict = ["width": s.width, "height": s.height]
                }
            }
            
            var childElements: [UIElement]? = nil
            if let childArray = children as? [AXUIElement], !childArray.isEmpty {
                childElements = childArray.compactMap { traverse($0, depth: depth + 1) }
            }
            
            return UIElement(
                role: role as? String,
                title: title as? String,
                value: value as? String,
                description: desc as? String,
                position: posDict,
                size: sizeDict,
                enabled: (enabled as? Bool) ?? true,
                focused: (focused as? Bool) ?? false,
                children: childElements
            )
        }
        
        if let rootElement = traverse(app, depth: 0) {
            return JsonRpcResponse(id: id, result: AnyCodable([
                "pid": pid,
                "elementCount": elementCount,
                "truncated": truncated,
                "tree": rootElement
            ]), error: nil)
        } else {
            return JsonRpcResponse(id: id, result: nil, error: JsonRpcError(code: -32000, message: "Failed to traverse accessibility tree for PID \(pid)"))
        }
    }
    
    func click(id: Int, params: [String: AnyCodable]?) -> JsonRpcResponse {
        guard let x = params?["x"]?.value as? Double,
              let y = params?["y"]?.value as? Double else {
            return JsonRpcResponse(id: id, result: nil, error: JsonRpcError(code: -32602, message: "Missing 'x' or 'y' parameter"))
        }
        
        let point = CGPoint(x: x, y: y)
        let button = (params?["button"]?.value as? String) == "right" ? CGMouseButton.right : CGMouseButton.left
        let clickCount = (params?["clickCount"]?.value as? Int) ?? 1
        
        let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
        let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
        
        for _ in 0..<clickCount {
            if let mouseDown = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button) {
                mouseDown.post(tap: .cghidEventTap)
            }
            usleep(10000) // 10ms
            if let mouseUp = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button) {
                mouseUp.post(tap: .cghidEventTap)
            }
            usleep(50000) // 50ms between clicks
        }
        
        return JsonRpcResponse(id: id, result: AnyCodable(["success": true, "x": x, "y": y]), error: nil)
    }
    
    func typeText(id: Int, params: [String: AnyCodable]?) -> JsonRpcResponse {
        guard let text = params?["text"]?.value as? String else {
            return JsonRpcResponse(id: id, result: nil, error: JsonRpcError(code: -32602, message: "Missing 'text' parameter"))
        }
        
        let delayMs = (params?["delayMs"]?.value as? Int) ?? 10
        
        for char in text {
            let source = CGEventSource(stateID: .hidSystemState)
            if let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) {
                var buffer = [UniChar](String(char).utf16)
                keyDown.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: &buffer)
                keyDown.post(tap: .cghidEventTap)
            }
            if let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
                keyUp.post(tap: .cghidEventTap)
            }
            usleep(UInt32(delayMs * 1000))
        }
        
        return JsonRpcResponse(id: id, result: AnyCodable(["success": true, "length": text.count]), error: nil)
    }
    
    func pressKey(id: Int, params: [String: AnyCodable]?) -> JsonRpcResponse {
        guard let key = params?["key"]?.value as? String else {
            return JsonRpcResponse(id: id, result: nil, error: JsonRpcError(code: -32602, message: "Missing 'key' parameter"))
        }
        
        let modifiers = params?["modifiers"]?.value as? [String] ?? []
        
        // Map key names to virtual keycodes
        let keyCode: CGKeyCode
        switch key.lowercased() {
        case "return", "enter": keyCode = 0x24
        case "tab": keyCode = 0x30
        case "space": keyCode = 0x31
        case "delete", "backspace": keyCode = 0x33
        case "escape", "esc": keyCode = 0x35
        case "left": keyCode = 0x7B
        case "right": keyCode = 0x7C
        case "down": keyCode = 0x7D
        case "up": keyCode = 0x7E
        case "f1": keyCode = 0x7A
        case "f2": keyCode = 0x78
        case "f3": keyCode = 0x63
        case "f4": keyCode = 0x76
        case "f5": keyCode = 0x60
        case "f6": keyCode = 0x61
        case "f7": keyCode = 0x62
        case "f8": keyCode = 0x64
        case "f9": keyCode = 0x65
        case "f10": keyCode = 0x6D
        case "f11": keyCode = 0x67
        case "f12": keyCode = 0x6F
        default:
            // For single characters, use character-based approach
            if key.count == 1 {
                return typeText(id: id, params: ["text": AnyCodable(key)])
            }
            return JsonRpcResponse(id: id, result: nil, error: JsonRpcError(code: -32602, message: "Unknown key: \(key)"))
        }
        
        var flags: CGEventFlags = []
        for mod in modifiers {
            switch mod.lowercased() {
            case "cmd", "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: break
            }
        }
        
        let source = CGEventSource(stateID: .hidSystemState)
        if let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true) {
            keyDown.flags = flags
            keyDown.post(tap: .cghidEventTap)
        }
        usleep(10000)
        if let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) {
            keyUp.flags = flags
            keyUp.post(tap: .cghidEventTap)
        }
        
        return JsonRpcResponse(id: id, result: AnyCodable(["success": true, "key": key, "modifiers": modifiers]), error: nil)
    }
    
    func openApp(id: Int, params: [String: AnyCodable]?) -> JsonRpcResponse {
        let appName = params?["name"]?.value as? String
        let bundleId = params?["bundleId"]?.value as? String
        
        var url: URL?
        
        if let bundleId = bundleId {
            url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
        } else if let appName = appName {
            url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: appName)
            if url == nil {
                // Try finding by name
                let path = "/Applications/\(appName).app"
                if FileManager.default.fileExists(atPath: path) {
                    url = URL(fileURLWithPath: path)
                }
            }
        }
        
        guard let appUrl = url else {
            return JsonRpcResponse(id: id, result: nil, error: JsonRpcError(code: -32000, message: "App not found"))
        }
        
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        
        let semaphore = DispatchSemaphore(value: 0)
        var resultPid: pid_t = 0
        var resultError: Error?
        
        NSWorkspace.shared.openApplication(at: appUrl, configuration: config) { app, error in
            resultPid = app?.processIdentifier ?? 0
            resultError = error
            semaphore.signal()
        }
        
        semaphore.wait()
        
        if let error = resultError {
            return JsonRpcResponse(id: id, result: nil, error: JsonRpcError(code: -32000, message: error.localizedDescription))
        }
        
        return JsonRpcResponse(id: id, result: AnyCodable(["success": true, "pid": Int(resultPid)]), error: nil)
    }
    
    func getWindowList(id: Int) -> JsonRpcResponse {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let windowList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return JsonRpcResponse(id: id, result: nil, error: JsonRpcError(code: -32000, message: "Failed to get window list"))
        }
        
        let windows: [[String: Any]] = windowList.compactMap { window in
            guard let ownerPid = window[kCGWindowOwnerPID as String] as? Int,
                  let windowId = window[kCGWindowNumber as String] as? Int,
                  let layer = window[kCGWindowLayer as String] as? Int,
                  layer == 0 else { return nil }  // Normal windows only
            
            let ownerName = window[kCGWindowOwnerName as String] as? String ?? ""
            let windowName = window[kCGWindowName as String] as? String ?? ""
            let bounds = window[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
            
            return [
                "windowId": windowId,
                "ownerPid": ownerPid,
                "ownerName": ownerName,
                "windowName": windowName,
                "bounds": bounds
            ]
        }
        
        return JsonRpcResponse(id: id, result: AnyCodable(["windows": windows]), error: nil)
    }
}

// MARK: - Main

ClawdCursorHelper.shared.run()
