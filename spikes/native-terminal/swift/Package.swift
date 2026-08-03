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
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.15.0"),
    ],
    targets: [
        .executableTarget(
            name: "NativeTerminalSwiftSpike",
            dependencies: [
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
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
