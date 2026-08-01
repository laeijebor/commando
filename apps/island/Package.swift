// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CommandoIsland",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CommandoIsland", targets: ["CommandoIsland"]),
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.15.0"),
    ],
    targets: [
        .executableTarget(
            name: "CommandoIsland",
            dependencies: [
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ]
        ),
        .testTarget(
            name: "CommandoIslandTests",
            dependencies: ["CommandoIsland"]
        ),
    ]
)
