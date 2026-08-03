import Carbon.HIToolbox
import Foundation
import Testing
@testable import CommandoIsland

@Test func placesVisorAtBottomCenterOfVisibleScreen() {
    let visibleFrame = CGRect(x: 80, y: 42, width: 1_440, height: 900)

    let frame = VisorGeometry.frame(visibleFrame: visibleFrame)

    #expect(frame.midX == visibleFrame.midX)
    #expect(frame.minY == visibleFrame.minY + 12)
    #expect(frame.width == 1_180.8)
    #expect(frame.height == 378)
    #expect(visibleFrame.contains(frame))
}

@Test func clampsVisorToSmallVisibleScreens() {
    let visibleFrame = CGRect(x: -400, y: 20, width: 400, height: 260)

    let frame = VisorGeometry.frame(visibleFrame: visibleFrame)

    #expect(frame == CGRect(x: -384, y: 32, width: 368, height: 236))
    #expect(visibleFrame.contains(frame))
}

@Test func registersOptionF12AsTheGlobalVisorShortcut() {
    #expect(VisorShortcut.keyCode == UInt32(kVK_F12))
    #expect(VisorShortcut.carbonModifiers == UInt32(optionKey))
}

@Test func resolvesAndConfiguresAnIsolatedLoginShell() {
    #expect(VisorShellConfiguration.executable(
        environment: ["SHELL": "/opt/homebrew/bin/fish"],
        accountShell: "/bin/zsh"
    ) == "/opt/homebrew/bin/fish")
    #expect(VisorShellConfiguration.executable(
        environment: ["SHELL": "relative-shell"],
        accountShell: "/bin/bash"
    ) == "/bin/bash")

    let environment = VisorShellConfiguration.processEnvironment(inherited: [
        "HOME": "/Users/tester",
        "PATH": "",
    ])
    #expect(environment.contains("COMMANDO_VISOR=1"))
    #expect(environment.contains("TERM=xterm-256color"))
    #expect(environment.contains("COLORTERM=truecolor"))
    #expect(environment.contains("PATH=\(VisorShellConfiguration.fallbackPath)"))
    #expect(environment.contains("HOME=/Users/tester"))
}
