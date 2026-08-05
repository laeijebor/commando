import Foundation
import WebKit

struct TrustedLinkRequest: Equatable, Sendable {
    let url: URL
    let opensInNewWindow: Bool

    static func decode(_ body: Any) -> Self? {
        guard let object = body as? [String: Any],
              Set(object.keys) == ["url", "opensInNewWindow"],
              let value = object["url"] as? String,
              value.utf8.count <= 8_192,
              let url = URL(string: value),
              let opensInNewWindow = object["opensInNewWindow"] as? Bool
        else {
            return nil
        }
        return Self(url: url, opensInNewWindow: opensInNewWindow)
    }
}

@MainActor
enum TrustedLinkBridge {
    static let handlerName = "commandoTrustedLink"
    static let contentWorld = WKContentWorld.world(name: "CommandoTrustedLinkWorld")
    static let userScript = WKUserScript(
        source: """
        (() => {
          document.addEventListener("click", (event) => {
            if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            const anchor = target.closest("a[href]");
            if (!anchor) return;
            let url;
            try { url = new URL(anchor.href, document.baseURI); } catch { return; }
            const targetName = (anchor.target || "").toLowerCase();
            const opensInNewWindow =
              (targetName !== "" && targetName !== "_self") || event.metaKey || event.shiftKey;
            if (url.origin === location.origin && !opensInNewWindow) return;
            event.preventDefault();
            window.webkit.messageHandlers.commandoTrustedLink.postMessage({
              url: url.href,
              opensInNewWindow,
            });
          }, true);
        })();
        """,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true,
        in: contentWorld
    )
}

@MainActor
final class TrustedLinkScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private let admission: WebContentAdmission
    private let externalURLHandler: any ExternalURLHandling

    init(admission: WebContentAdmission, externalURLHandler: any ExternalURLHandling) {
        self.admission = admission
        self.externalURLHandler = externalURLHandler
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        let origin = message.frameInfo.securityOrigin
        guard admission.allowsBridgeMessage(
            isMainFrame: message.frameInfo.isMainFrame,
            scheme: origin.protocol,
            host: origin.host,
            port: origin.port
        ),
              let request = TrustedLinkRequest.decode(message.body)
        else {
            return
        }
        externalURLHandler.handle(
            request.url,
            source: .trustedWebLink(opensInNewWindow: request.opensInNewWindow)
        )
    }
}
