import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { agentHostBuild, agentSdkVersion } from './build.js'

describe('agentHostBuild', () => {
  it('reads the installed Agent SDK version so an SDK-only bump changes the fingerprint', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8')) as { version: string }
    expect(await agentSdkVersion()).toBe(manifest.version)
    expect(await agentHostBuild()).toMatch(/^[0-9a-f]{12}$/)
  })
})
