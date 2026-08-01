// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "NativeTerminalSwiftSpike",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(
            name: "NativeTerminalSwiftSpike",
            targets: ["NativeTerminalSwiftSpike"]
        ),
    ],
    targets: [
        .executableTarget(
            name: "NativeTerminalSwiftSpike",
            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug)),
            ]
        ),
        .testTarget(
            name: "NativeTerminalSwiftSpikeTests",
            dependencies: ["NativeTerminalSwiftSpike"]
        ),
    ]
)
