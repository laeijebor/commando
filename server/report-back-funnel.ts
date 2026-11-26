import { execFile } from 'node:child_process'
import type { ReportBackFunnelStatus } from '../shared/report-back.js'
import { REPORT_BACK_LOOPBACK_HOST, REPORT_BACK_MCP_PATH } from './report-back-mcp.js'

export const DEFAULT_FORBIDDEN_FUNNEL_PORTS: readonly number[] = [4310]

const TAILSCALE_BINARIES = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
] as const
const COMMAND_TIMEOUT_MS = 5_000
const COMMAND_MAX_BUFFER = 1024 * 1024
const MAGIC_DNS_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/i
const LOOPBACK_MCP_PROXY_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/mcp$/i

export type FunnelCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
}

export type FunnelCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<FunnelCommandResult>

export type FunnelPortOptions = {
  forbiddenPorts?: readonly number[]
}

function execTailscaleBinary(
  binary: string,
  args: readonly string[],
): Promise<{ result: FunnelCommandResult; enoent: boolean }> {
  return new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            enoent: false,
            result: { ok: true, stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 },
          })
          return
        }
        const err = error as NodeJS.ErrnoException & { code?: number | string }
        const enoent = err.code === 'ENOENT'
        const exitCode = typeof err.code === 'number' ? err.code : null
        resolve({
          enoent,
          result: {
            ok: false,
            stdout: stdout ?? '',
            stderr: (stderr || err.message || 'Tailscale command failed').trim(),
            exitCode,
          },
        })
      },
    )
  })
}

export const defaultFunnelCommandRunner: FunnelCommandRunner = async (command, args) => {
  const candidates = command === 'tailscale' ? TAILSCALE_BINARIES : [command]
  let lastResult: FunnelCommandResult = {
    ok: false,
    stdout: '',
    stderr: 'Tailscale CLI not found',
    exitCode: null,
  }
  for (const binary of candidates) {
    const attempt = await execTailscaleBinary(binary, args)
    lastResult = attempt.result
    if (!attempt.enoent) return lastResult
  }
  return lastResult
}

export function validateFunnelPort(port: number, options: FunnelPortOptions = {}): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Funnel port must be an integer between 1 and 65535')
  }
  const forbidden = options.forbiddenPorts ?? DEFAULT_FORBIDDEN_FUNNEL_PORTS
  if (forbidden.includes(port)) {
    throw new Error(`Refusing to expose forbidden port ${port} via Tailscale Funnel`)
  }
  return port
}

export function buildFunnelArgs(port: number, options: FunnelPortOptions = {}): string[] {
  const validatedPort = validateFunnelPort(port, options)
  return [
    'funnel',
    '--bg',
    '--yes',
    '--set-path',
    REPORT_BACK_MCP_PATH,
    `http://${REPORT_BACK_LOOPBACK_HOST}:${validatedPort}${REPORT_BACK_MCP_PATH}`,
  ]
}

export function buildDisableFunnelArgs(): string[] {
  return ['funnel', '--yes', '--set-path', REPORT_BACK_MCP_PATH, 'off']
}

type TailscaleStatusJson = {
  BackendState?: unknown
  Self?: {
    DNSName?: unknown
    Online?: unknown
  }
}

type TailscaleFunnelStatusJson = {
  AllowFunnel?: Record<string, unknown>
  Web?: Record<
    string,
    {
      Handlers?: Record<string, { Proxy?: unknown } | undefined>
    } | undefined
  >
}

function parseTailscaleDnsName(raw: string): { dnsName?: string; error?: string } {
  let parsed: TailscaleStatusJson
  try {
    parsed = JSON.parse(raw) as TailscaleStatusJson
  } catch {
    return { error: 'Could not parse tailscale status output' }
  }
  if (parsed.BackendState !== 'Running' || parsed.Self?.Online === false) {
    return { error: 'Tailscale is not connected' }
  }
  const dnsName = typeof parsed.Self?.DNSName === 'string'
    ? parsed.Self.DNSName.replace(/\.$/, '').toLowerCase()
    : ''
  if (!dnsName || !MAGIC_DNS_PATTERN.test(dnsName)) {
    return { error: 'Tailscale MagicDNS name is unavailable' }
  }
  return { dnsName }
}

function parseActiveMcpFunnelUrl(raw: string, dnsName: string): string | null {
  if (!raw.trim()) return null
  let parsed: TailscaleFunnelStatusJson
  try {
    parsed = JSON.parse(raw) as TailscaleFunnelStatusJson
  } catch {
    return null
  }
  const allowFunnel = parsed.AllowFunnel
  const web = parsed.Web
  if (!allowFunnel || !web) return null

  const normalizedHostPrefix = `${dnsName.toLowerCase()}:`
  for (const [hostPort, allowed] of Object.entries(allowFunnel)) {
    if (allowed !== true) continue
    if (!hostPort.toLowerCase().startsWith(normalizedHostPrefix)) continue
    const httpsPort = hostPort.slice(normalizedHostPrefix.length)
    if (!/^\d+$/.test(httpsPort)) continue
    const handler = web[hostPort]?.Handlers?.[REPORT_BACK_MCP_PATH]
    const proxy = typeof handler?.Proxy === 'string' ? handler.Proxy : ''
    const proxyMatch = LOOPBACK_MCP_PROXY_PATTERN.exec(proxy)
    if (!proxyMatch) continue
    const proxyPort = Number(proxyMatch[1])
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65_535) continue
    return httpsPort === '443'
      ? `https://${dnsName}${REPORT_BACK_MCP_PATH}`
      : `https://${dnsName}:${httpsPort}${REPORT_BACK_MCP_PATH}`
  }

  return null
}

export async function funnelStatus(
  runner: FunnelCommandRunner = defaultFunnelCommandRunner,
): Promise<ReportBackFunnelStatus> {
  const statusResult = await runner('tailscale', ['status', '--json'])
  if (!statusResult.ok) {
    return {
      enabled: false,
      error: statusResult.stderr.trim() || 'Tailscale status check failed',
    }
  }
  const { dnsName, error } = parseTailscaleDnsName(statusResult.stdout)
  if (!dnsName) {
    return { enabled: false, error }
  }

  const funnelResult = await runner('tailscale', ['funnel', 'status', '--json'])
  if (!funnelResult.ok) {
    return {
      enabled: false,
      error: funnelResult.stderr.trim() || 'Tailscale funnel status check failed',
    }
  }

  const url = parseActiveMcpFunnelUrl(funnelResult.stdout, dnsName)
  if (!url) {
    return { enabled: false }
  }
  return { enabled: true, url }
}

export async function enableFunnel(
  port: number,
  runner: FunnelCommandRunner = defaultFunnelCommandRunner,
  options: FunnelPortOptions = {},
): Promise<ReportBackFunnelStatus> {
  const args = buildFunnelArgs(port, options)
  const result = await runner('tailscale', args)
  if (!result.ok) {
    return {
      enabled: false,
      error: result.stderr.trim() || 'Failed to enable Tailscale Funnel',
    }
  }
  return funnelStatus(runner)
}

export async function disableFunnel(
  runner: FunnelCommandRunner = defaultFunnelCommandRunner,
): Promise<ReportBackFunnelStatus> {
  const result = await runner('tailscale', buildDisableFunnelArgs())
  if (!result.ok) {
    return {
      enabled: false,
      error: result.stderr.trim() || 'Failed to disable Tailscale Funnel',
    }
  }
  return { enabled: false }
}
