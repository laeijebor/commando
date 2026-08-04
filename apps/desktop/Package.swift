// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CommandoDesktop",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CommandoDesktop", targets: ["CommandoDesktop"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/migueldeicaza/SwiftTerm.git",
            exact: "1.15.0"
        ),
    ],
    targets: [
        .executableTarget(
            name: "CommandoDesktop",
            dependencies: [
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            resources: [
                .copy("Resources/JetBrainsMono"),
            ],
            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug)),
            ]
        ),
        .testTarget(
            name: "CommandoDesktopTests",
            dependencies: ["CommandoDesktop"]
        ),
    ]
)
