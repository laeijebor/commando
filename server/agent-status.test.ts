import { describe, expect, it } from 'vitest'
import {
  inferAgentProcessStatus,
  inferAgentProvider,
  inferAgentStatus,
} from './agent-status.js'

const now = 100_000

describe('agent inference', () => {
  it('prefers foreground process evidence for the provider', () => {
    expect(inferAgentProvider('/opt/bin/claude', 'shell', '')).toMatchObject({
      provider: 'claude',
      source: 'process',
    })
    expect(inferAgentProvider('node', 'OpenCode', '')).toMatchObject({
      provider: 'opencode',
      source: 'heuristic',
    })
  })

  it('discovers supported agent processes without treating captured history as live work', () => {
    expect(inferAgentProcessStatus({
      paneId: '%1',
      command: '/opt/bin/codex',
      title: 'shell',
      capturedAt: now,
    })).toMatchObject({
      provider: 'codex',
      status: 'unknown',
      source: 'process',
      confidence: 'medium',
      summary: 'codex process detected',
    })
    expect(inferAgentProcessStatus({
      paneId: '%2',
      command: 'node',
      title: 'OpenCode',
      capturedAt: now,
    })).toMatchObject({
      provider: 'opencode',
      status: 'unknown',
      source: 'heuristic',
      confidence: 'low',
    })
    expect(inferAgentProcessStatus({
      paneId: '%3',
      command: 'zsh',
      title: 'Codex',
      capturedAt: now,
    })).toMatchObject({ provider: 'unknown', status: 'unknown' })
  })

  it('recognizes active work and input prompts', () => {
    expect(
      inferAgentStatus({
        paneId: '%1',
        command: 'claude',
        title: '',
        content: 'Analyzing files…\nEsc to interrupt',
        capturedAt: now,
        lastChangedAt: now,
      }),
    ).toMatchObject({
      provider: 'claude',
      status: 'working',
      confidence: 'high',
      source: 'heuristic',
    })

    expect(
      inferAgentStatus({
        paneId: '%2',
        command: 'codex',
        title: '',
        content: 'Apply these changes? [y/N]',
        capturedAt: now,
        lastChangedAt: now,
      }),
    ).toMatchObject({ status: 'needs_input', confidence: 'high' })

    expect(
      inferAgentStatus({
        paneId: '%3',
        command: 'opencode',
        title: '',
        content: 'Should the fallback preserve the old title?\nWaiting for your answer...',
        capturedAt: now,
        lastChangedAt: now - 2_000,
      }),
    ).toMatchObject({ status: 'needs_input', confidence: 'high' })
  })

  it('distinguishes completion, stale output, and dead panes', () => {
    expect(
      inferAgentStatus({
        paneId: '%1',
        command: 'opencode',
        title: '',
        content: 'Finished the requested change.\n❯',
        capturedAt: now,
        lastChangedAt: now - 60_000,
      }).status,
    ).toBe('done')

    expect(
      inferAgentStatus({
        paneId: '%2',
        command: 'codex',
        title: '',
        content: 'Inspecting repository',
        capturedAt: now,
        lastChangedAt: now - 31_000,
      }).status,
    ).toBe('stale')

    expect(
      inferAgentStatus({
        paneId: '%3',
        command: 'claude',
        title: '',
        content: '',
        dead: true,
        capturedAt: now,
        lastChangedAt: now,
      }),
    ).toMatchObject({
      status: 'failed',
      confidence: 'high',
      source: 'process',
    })
  })
})
