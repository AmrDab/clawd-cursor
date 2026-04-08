import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import Network

private let hostPort: UInt16 = {
    if let env = ProcessInfo.processInfo.environment["CLAWDCURSOR_HOST_PORT"], let parsed = UInt16(env) {
        return parsed
    }
    return 3848
}()

private func expectedToken() -> String? {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let tokenPath = home.appendingPathComponent(".clawdcursor/host-token").path
    return try? String(contentsOfFile: tokenPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func jsonResponse(status: Int, payload: Data) -> Data {
    var response = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "ERROR")\r\n"
    response += "Content-Type: application/json\r\n"
    response += "Content-Length: \(payload.count)\r\n"
    response += "Connection: close\r\n\r\n"
    var data = Data(response.utf8)
    data.append(payload)
    return data
}

private func textResponse(status: Int, text: String) -> Data {
    jsonResponse(status: status, payload: Data(text.utf8))
}

private func runBinary(_ binary: String, args: [String] = [], stdin: Data? = nil) -> (exitCode: Int32, stdout: Data, stderr: Data) {
    let bundlePath = Bundle.main.bundlePath
    let macOSDir = URL(fileURLWithPath: bundlePath).appendingPathComponent("Contents/MacOS")
    let binaryPath = macOSDir.appendingPathComponent(binary).path

    let process = Process()
    let out = Pipe()
    let err = Pipe()
    let input = Pipe()

    process.executableURL = URL(fileURLWithPath: binaryPath)
    process.arguments = args
    process.standardOutput = out
    process.standardError = err
    process.standardInput = input

    do {
        try process.run()
    } catch {
        return (1, Data(), Data("{\"error\":\"failed_to_launch_binary\"}".utf8))
    }

    if let stdin {
        input.fileHandleForWriting.write(stdin)
    }
    try? input.fileHandleForWriting.close()

    process.waitUntilExit()
    let stdout = out.fileHandleForReading.readDataToEndOfFile()
    let stderr = err.fileHandleForReading.readDataToEndOfFile()
    return (process.terminationStatus, stdout, stderr)
}

private func handleRequest(raw: Data) -> Data {
    guard let request = String(data: raw, encoding: .utf8) else {
        return textResponse(status: 400, text: "{\"error\":\"invalid_utf8\"}")
    }

    let parts = request.components(separatedBy: "\r\n\r\n")
    guard let head = parts.first else {
        return textResponse(status: 400, text: "{\"error\":\"invalid_request\"}")
    }

    let lines = head.components(separatedBy: "\r\n")
    guard let reqLine = lines.first else {
        return textResponse(status: 400, text: "{\"error\":\"missing_request_line\"}")
    }

    let reqParts = reqLine.split(separator: " ")
    guard reqParts.count >= 2 else {
        return textResponse(status: 400, text: "{\"error\":\"bad_request_line\"}")
    }

    let method = String(reqParts[0])
    let path = String(reqParts[1])
    let body = parts.dropFirst().joined(separator: "\r\n\r\n")
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
        if let idx = line.firstIndex(of: ":") {
            let name = String(line[..<idx]).trimmingCharacters(in: .whitespaces).lowercased()
            let value = String(line[line.index(after: idx)...]).trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
    }

    if method == "GET" && path == "/health" {
        let payload = "{\"status\":\"ok\",\"service\":\"clawdcursor-host\",\"port\":\(hostPort)}"
        return textResponse(status: 200, text: payload)
    }

    if method == "GET" && path == "/status" {
        let axOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: kCFBooleanFalse] as CFDictionary
        let axGranted = AXIsProcessTrustedWithOptions(axOptions)
        let screenGranted = CGPreflightScreenCaptureAccess()
        let bundleId = Bundle.main.bundleIdentifier ?? "unknown"
        let payload = "{\"accessibility\":\(axGranted),\"screenRecording\":\(screenGranted),\"bundleId\":\"\(bundleId)\"}"
        return textResponse(status: 200, text: payload)
    }

    if method == "POST" && path == "/rpc" {
        guard let token = expectedToken(), !token.isEmpty else {
            return textResponse(status: 503, text: "{\"error\":\"host_token_missing\"}")
        }
        guard headers["x-clawdcursor-token"] == token else {
            return textResponse(status: 401, text: "{\"error\":\"unauthorized\"}")
        }
        let result = runBinary("clawdcursor-helper", stdin: Data((body + "\n").utf8))
        if result.exitCode == 0, !result.stdout.isEmpty {
            let lines = String(data: result.stdout, encoding: .utf8)?.split(separator: "\n") ?? []
            if let first = lines.first {
                return textResponse(status: 200, text: String(first))
            }
        }
        let stderr = String(data: result.stderr, encoding: .utf8) ?? "unknown error"
        return textResponse(status: 500, text: "{\"error\":\"helper_failed\",\"message\":\"\(stderr.replacingOccurrences(of: "\"", with: "'"))\"}")
    }

    return textResponse(status: 404, text: "{\"error\":\"not_found\"}")
}

private var listenerRef: NWListener?

private func startServer() throws {
    // SECURITY: Bind to localhost only — reject connections from other machines
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: hostPort)!)
    let listener = try NWListener(using: params)
    listener.newConnectionHandler = { conn in
        conn.start(queue: .global())
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1024 * 1024) { data, _, _, _ in
            let response = handleRequest(raw: data ?? Data())
            conn.send(content: response, completion: .contentProcessed { _ in
                conn.cancel()
            })
        }
    }
    listener.start(queue: .global())
    listenerRef = listener
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

if let bundleId = Bundle.main.bundleIdentifier {
    NSLog("ClawdCursorHost starting (bundle: \(bundleId), port: \(hostPort))")
}

try startServer()
DispatchQueue.main.async {
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.title = "🐾"
    statusItem.button?.toolTip = "ClawdCursor Host"
}

app.run()
