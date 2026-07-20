// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CommandoIsland",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CommandoIsland", targets: ["CommandoIsland"]),
    ],
    targets: [
        .executableTarget(name: "CommandoIsland"),
        .testTarget(
            name: "CommandoIslandTests",
            dependencies: ["CommandoIsland"]
        ),
    ]
)
