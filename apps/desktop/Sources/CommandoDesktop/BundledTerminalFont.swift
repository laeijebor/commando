import AppKit
import CoreText

@MainActor
enum BundledTerminalFont {
    enum Face: CaseIterable {
        case regular
        case bold

        var resourceName: String {
            switch self {
            case .regular: "JetBrainsMono-Regular"
            case .bold: "JetBrainsMono-Bold"
            }
        }

        var postScriptName: String {
            resourceName
        }

        var expectedSHA256: String {
            switch self {
            case .regular: "08546b840f12407615e5bdf257bfdd2b42fc49a020ee51e4fd766ad2587f4bc5"
            case .bold: "46fe456f11a4ebb5d8a621c033227dfd72a4783958e56f004057a7a3d884948e"
            }
        }
    }

    static let familyName = "JetBrains Mono"
    static let resourceDirectory = "JetBrainsMono"
    static let expectedSHA256 = Face.regular.expectedSHA256
    static let expectedBoldSHA256 = Face.bold.expectedSHA256

    static var resourceURL: URL? {
        resourceURL(for: .regular)
    }

    static var boldResourceURL: URL? {
        resourceURL(for: .bold)
    }

    static func resourceURL(for face: Face) -> URL? {
        packagedResourceURL(forResource: face.resourceName, withExtension: "ttf")
            ?? Bundle.module.url(
                forResource: face.resourceName,
                withExtension: "ttf",
                subdirectory: resourceDirectory
            )
    }

    static var licenseURL: URL? {
        packagedResourceURL(forResource: "OFL", withExtension: "txt")
            ?? Bundle.module.url(
                forResource: "OFL",
                withExtension: "txt",
                subdirectory: resourceDirectory
            )
    }

    static var provenanceURL: URL? {
        packagedResourceURL(forResource: "PROVENANCE", withExtension: "md")
            ?? Bundle.module.url(
                forResource: "PROVENANCE",
                withExtension: "md",
                subdirectory: resourceDirectory
            )
    }

    private static var descriptors: [String: CTFontDescriptor]?
    private(set) static var registrationFailure: String?

    @discardableResult
    static func register() -> Bool {
        if descriptors != nil { return true }

        var loadedDescriptors: [String: CTFontDescriptor] = [:]
        for face in Face.allCases {
            guard let resourceURL = resourceURL(for: face) else {
                registrationFailure = "missing SwiftPM resource for \(face.resourceName)"
                return false
            }

            var unmanagedError: Unmanaged<CFError>?
            let registered = CTFontManagerRegisterFontsForURL(
                resourceURL as CFURL,
                .process,
                &unmanagedError
            )
            if !registered, let error = unmanagedError?.takeRetainedValue() {
                let alreadyRegistered = CFErrorGetDomain(error) == kCTFontManagerErrorDomain
                    && CFErrorGetCode(error) == CTFontManagerError.alreadyRegistered.rawValue
                guard alreadyRegistered else {
                    registrationFailure = CFErrorCopyDescription(error) as String
                    return false
                }
            }

            guard let fontDescriptors = CTFontManagerCreateFontDescriptorsFromURL(
                resourceURL as CFURL
            ) as? [CTFontDescriptor] else {
                registrationFailure = "CoreText found no descriptors in \(face.resourceName)"
                return false
            }

            for descriptor in fontDescriptors {
                guard let name = CTFontDescriptorCopyAttribute(
                    descriptor,
                    kCTFontNameAttribute
                ) as? String else {
                    continue
                }
                loadedDescriptors[name] = descriptor
            }
        }

        guard Face.allCases.allSatisfy({ loadedDescriptors[$0.postScriptName] != nil }) else {
            registrationFailure = "CoreText did not expose the bundled Regular and Bold faces"
            return false
        }
        descriptors = loadedDescriptors
        registrationFailure = nil
        return true
    }

    static func font(size: CGFloat, face: Face = .regular) -> NSFont? {
        guard register(),
              descriptors?[face.postScriptName] != nil,
              let resourceURL = resourceURL(for: face)?.standardizedFileURL,
              let font = NSFont(name: face.postScriptName, size: size),
              sourceURL(for: font)?.standardizedFileURL == resourceURL
        else {
            return nil
        }
        return font
    }

    static func sourceURL(for font: NSFont) -> URL? {
        CTFontCopyAttribute(font as CTFont, kCTFontURLAttribute) as? URL
    }

    private static func packagedResourceURL(
        forResource name: String,
        withExtension extensionName: String
    ) -> URL? {
        guard let resourcesURL = Bundle.main.resourceURL else { return nil }
        let candidate = resourcesURL
            .appendingPathComponent("CommandoDesktop_CommandoDesktop.bundle", isDirectory: true)
            .appendingPathComponent(resourceDirectory, isDirectory: true)
            .appendingPathComponent("\(name).\(extensionName)")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }
}
