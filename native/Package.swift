// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ClawdCursorHelper",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .executable(name: "ClawdCursorHost", targets: ["ClawdCursorHost"]),
        .executable(name: "clawdcursor-helper", targets: ["ClawdCursorHelper"]),
        .executable(name: "screenshot-helper", targets: ["ScreenshotHelper"]),
        .executable(name: "permission-check", targets: ["PermissionCheck"])
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "ClawdCursorHost",
            dependencies: [],
            path: "Sources/ClawdCursorHost"
        ),
        .executableTarget(
            name: "ClawdCursorHelper",
            dependencies: [],
            path: "Sources/ClawdCursorHelper"
        ),
        .executableTarget(
            name: "ScreenshotHelper",
            dependencies: [],
            path: "Sources/ScreenshotHelper"
        ),
        .executableTarget(
            name: "PermissionCheck",
            dependencies: [],
            path: "Sources/PermissionCheck"
        )
    ]
)
