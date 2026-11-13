import { describe, expect, it } from 'vitest'
import { keepReason, stopsByDefault } from './tracked-processes.js'

describe('keepReason', () => {
  it('keeps apps and shared helper daemons, and stops everything else', () => {
    expect(keepReason({ fullCommand: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron .' })).toBe('app')
    expect(keepReason({ fullCommand: '/Users/me/Applications/Cursor.app/Contents/MacOS/Cursor' })).toBe('app')
    expect(keepReason({ fullCommand: '/opt/homebrew/bin/adb -L tcp:5037 fork-server server --reply-fd 4' })).toBe('shared helper')
    expect(keepReason({ fullCommand: 'gpg-agent --homedir /Users/me/.gnupg --daemon' })).toBe('shared helper')
    expect(keepReason({ fullCommand: '/usr/bin/java -Xmx2g -cp gradle.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10' })).toBe('shared helper')
    expect(keepReason({ fullCommand: 'java -cp kotlin-daemon.jar org.jetbrains.kotlin.daemon.KotlinCompileDaemon' })).toBe('shared helper')
    expect(keepReason({ fullCommand: 'node /repo/node_modules/.bin/vite --port 5273' })).toBeUndefined()
    expect(keepReason({ fullCommand: 'python3 -m http.server 4499' })).toBeUndefined()
    expect(keepReason({ fullCommand: 'grep adb notes.txt' })).toBeUndefined()
    expect(stopsByDefault({ fullCommand: 'watchman --foreground' })).toBe(false)
    expect(stopsByDefault({ fullCommand: 'npx serve .redline' })).toBe(true)
  })
})
