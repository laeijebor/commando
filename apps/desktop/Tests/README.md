# Desktop AppKit integration coverage

`NativeAppKitIntegrationTests` runs from SwiftPM with a real `WKWebView`,
`NativeTerminalBridge`, `TerminalPaneHost`, and `HostedTerminalView`. It requires
no Accessibility permission or generated Xcode project.

The suite covers native Option-right-click and selection gestures through the
terminal surface and bridge into a page feedback handler, named-pasteboard copy,
trusted-link script gating plus the production isolated-world message/opener
path, and partial terminal masks through hit testing and offscreen layer
rendering with Metal disabled.

One join remains manual: a physical click on an external anchor must be checked
in the packaged desktop app to confirm that the trusted DOM click reaches the
system URL opener. A SwiftPM `xctest` process has a prohibited activation policy
and cannot become the active application; fabricated `NSEvent` clicks therefore
do not produce a stable external-anchor event in `WKWebView`. The automated test
separately proves that script-generated clicks are untrusted and blocked, and
that a trusted isolated-world dispatch crosses WebKit origin admission and the
production URL handler into an opener spy. Do not replace this with coordinate
timing or global `CGEvent` injection, which would require desktop focus and may
require Accessibility permission.
