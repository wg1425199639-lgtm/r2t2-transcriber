// swift-tools-version: 5.7
import PackageDescription

let package = Package(
    name: "capture-mac",
    platforms: [.macOS(.v13)],
    targets: [.executableTarget(name: "capture-mac")]
)
