import { describe, expect, it, vi } from 'vitest'
import {
  buildDisableFunnelArgs,
  buildFunnelArgs,
  disableFunnel,
  enableFunnel,
  funnelStatus,
  type FunnelCommandResult,
  type FunnelCommandRunner,
} from './report-back-funnel.js'

function ok(stdout = ''): FunnelCommandResult {
  return { ok: true, stdout, stderr: '', exitCode: 0 }
}

function fail(stderr: string, exitCode = 1): FunnelCommandResult {
  return { ok: false, stdout: '', stderr, exitCode }
}

const RUNNING_STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'hub-mac.tail1234.ts.net.', Online: true },
})

const ACTIVE_FUNNEL_STATUS = JSON.stringify({
  TCP: { '443': { HTTPS: true } },
  Web: {
    'hub-mac.tail1234.ts.net:443': {
      Handlers: {
        '/mcp': { Proxy: 'http://127.0.0.1:4311/mcp' },
      },
    },
  },
  AllowFunnel: {
    'hub-mac.tail1234.ts.net:443': true,
  },
})

describe('report-back-funnel', () => {
  it('builds funnel args strictly exposing only /mcp on 127.0.0.1 and forbids main daemon port', () => {
    expect(buildFunnelArgs(4311)).toEqual([
      'funnel',
      '--bg',
      '--yes',
      '--set-path',
      '/mcp',
      'http://127.0.0.1:4311/mcp',
    ])

    expect(() => buildFunnelArgs(4310)).toThrow(/forbidden port 4310/i)
    expect(() => buildFunnelArgs(0)).toThrow()
    expect(() => buildFunnelArgs(70_000)).toThrow()
    expect(() => buildFunnelArgs(Number.NaN)).toThrow()
    expect(() => buildFunnelArgs(4410, { forbiddenPorts: [4410] })).toThrow(/forbidden port 4410/i)

    expect(buildDisableFunnelArgs()).toEqual(['funnel', '--yes', '--set-path', '/mcp', 'off'])
  })

  it('reports active funnel URL when Tailscale is running and /mcp funnel points to loopback', async () => {
    const runner = vi.fn<FunnelCommandRunner>(async (_cmd, args) => {
      if (args[0] === 'status') return ok(RUNNING_STATUS)
      if (args[0] === 'funnel' && args[1] === 'status') return ok(ACTIVE_FUNNEL_STATUS)
      return fail('unexpected call')
    })

    const status = await funnelStatus(runner)
    expect(status).toEqual({
      enabled: true,
      url: 'https://hub-mac.tail1234.ts.net/mcp',
    })
  })

  it('reports disabled when funnel is off or only exposes a different path or non-loopback target', async () => {
    const differentPath = JSON.stringify({
      Web: {
        'hub-mac.tail1234.ts.net:443': {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:4311/mcp' } },
        },
      },
      AllowFunnel: { 'hub-mac.tail1234.ts.net:443': true },
    })

    const runner = vi.fn<FunnelCommandRunner>(async (_cmd, args) => {
      if (args[0] === 'status') return ok(RUNNING_STATUS)
      return ok(differentPath)
    })
    expect(await funnelStatus(runner)).toEqual({ enabled: false })

    const remoteProxy = JSON.stringify({
      Web: {
        'hub-mac.tail1234.ts.net:443': {
          Handlers: { '/mcp': { Proxy: 'http://10.0.0.2:4311/mcp' } },
        },
      },
      AllowFunnel: { 'hub-mac.tail1234.ts.net:443': true },
    })
    runner.mockImplementation(async (_cmd, args) => (args[0] === 'status' ? ok(RUNNING_STATUS) : ok(remoteProxy)))
    expect(await funnelStatus(runner)).toEqual({ enabled: false })
  })

  it('reports errors cleanly when Tailscale CLI is unavailable or disconnected', async () => {
    const missingRunner: FunnelCommandRunner = async () => fail('Tailscale CLI not found')
    expect(await funnelStatus(missingRunner)).toEqual({
      enabled: false,
      error: 'Tailscale CLI not found',
    })

    const stoppedRunner: FunnelCommandRunner = async () =>
      ok(JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'hub.tail.ts.net.' } }))
    expect(await funnelStatus(stoppedRunner)).toEqual({
      enabled: false,
      error: 'Tailscale is not connected',
    })
  })

  it('enables and disables funnel using the validated CLI args', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    let active = false
    const runner: FunnelCommandRunner = async (command, args) => {
      calls.push({ command, args })
      if (args[0] === 'funnel' && args[1] === '--bg') {
        active = true
        return ok()
      }
      if (args[0] === 'funnel' && args.includes('off')) {
        active = false
        return ok()
      }
      if (args[0] === 'status') return ok(RUNNING_STATUS)
      if (args[0] === 'funnel' && args[1] === 'status') return ok(active ? ACTIVE_FUNNEL_STATUS : '{}')
      return fail('unexpected')
    }

    const enabled = await enableFunnel(4311, runner)
    expect(enabled).toEqual({ enabled: true, url: 'https://hub-mac.tail1234.ts.net/mcp' })
    expect(calls[0]).toEqual({
      command: 'tailscale',
      args: ['funnel', '--bg', '--yes', '--set-path', '/mcp', 'http://127.0.0.1:4311/mcp'],
    })

    const disabled = await disableFunnel(runner)
    expect(disabled).toEqual({ enabled: false })
    expect(calls[calls.length - 1]).toEqual({
      command: 'tailscale',
      args: ['funnel', '--yes', '--set-path', '/mcp', 'off'],
    })
  })
})
