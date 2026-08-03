import Foundation

struct DesktopConfiguration: Equatable, Sendable {
    let webURL: URL
    let prefersMetal: Bool

    var webOrigin: WebOrigin {
        WebOrigin(url: webURL)!
    }

    static func current(environment: [String: String] = ProcessInfo.processInfo.environment) -> Self {
        #if DEBUG
        let isDebug = true
        #else
        let isDebug = false
        #endif

        let defaultURL: URL
        if isDebug {
            defaultURL = URL(string: "http://127.0.0.1:5173")!
        } else {
            let requestedPort = Int(environment["COMMANDO_PORT"] ?? "")
            let port = requestedPort.flatMap { (1...65_535).contains($0) ? $0 : nil } ?? 4_310
            defaultURL = URL(string: "http://127.0.0.1:\(port)")!
        }

        let configuredURL = environment["COMMANDO_DESKTOP_URL"].flatMap(URL.init(string:))
        let webURL = configuredURL.flatMap { isPermittedWebURL($0) ? $0 : nil } ?? defaultURL
        let metalOverride = environment["COMMANDO_NATIVE_TERMINAL_METAL"]
        let prefersMetal = metalOverride == "1" || (metalOverride != "0" && !isDebug)
        return Self(webURL: webURL, prefersMetal: prefersMetal)
    }

    static func isPermittedWebURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.user == nil,
              url.password == nil,
              let host = url.host?.lowercased()
        else {
            return false
        }
        if host == "localhost" || host == "::1" { return true }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        return octets.count == 4
            && octets.first == "127"
            && octets.allSatisfy { octet in
                guard !octet.isEmpty, octet.allSatisfy(\.isNumber), let value = Int(octet) else {
                    return false
                }
                return (0...255).contains(value)
            }
    }
}

struct WebOrigin: Equatable, Sendable {
    let scheme: String
    let host: String
    let port: Int

    init?(url: URL) {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(),
              let port = url.port ?? Self.defaultPort(for: scheme)
        else {
            return nil
        }
        self.scheme = scheme
        self.host = host
        self.port = port
    }

    func matches(url: URL) -> Bool {
        WebOrigin(url: url) == self
    }

    func matches(scheme: String, host: String, port: Int) -> Bool {
        let normalizedScheme = scheme.lowercased()
        guard let effectivePort = port == 0 ? Self.defaultPort(for: normalizedScheme) : port else {
            return false
        }
        return self.scheme == normalizedScheme
            && self.host == host.lowercased()
            && self.port == effectivePort
    }

    var displayName: String {
        "\(scheme)://\(host):\(port)"
    }

    private static func defaultPort(for scheme: String) -> Int? {
        switch scheme {
        case "http": 80
        case "https": 443
        default: nil
        }
    }
}

struct WebContentAdmission: Equatable, Sendable {
    let origin: WebOrigin

    func allowsNavigation(to url: URL) -> Bool {
        origin.matches(url: url)
    }

    func allowsBridgeMessage(
        isMainFrame: Bool,
        scheme: String,
        host: String,
        port: Int
    ) -> Bool {
        isMainFrame && origin.matches(scheme: scheme, host: host, port: port)
    }
}
