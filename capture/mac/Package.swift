// swift-tools-version: 5.7
import Foundation
import PackageDescription

let testingPluginPath = "/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing"
let testingSwiftSettings: [SwiftSetting] = FileManager.default.fileExists(atPath: testingPluginPath)
    ? [.unsafeFlags(["-plugin-path", testingPluginPath])]
    : []

let package = Package(
    name: "capture-mac",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "capture-mac"),
        .testTarget(
            name: "capture-macTests",
            dependencies: ["capture-mac"],
            swiftSettings: testingSwiftSettings
        )
    ]
)
