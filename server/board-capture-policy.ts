import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type CaptureAddress = { address: string; family: number }
export type CaptureResolver = (host: string) => Promise<CaptureAddress[]>
export type CaptureDestination = { url: string; origin: string; policy: 'public' | 'private'; addresses: CaptureAddress[] }
export const captureLookup: CaptureResolver = (host) => lookup(host, { all: true })
const debuggingPorts = new Map<number, number>()
/** Track live and retiring browser processes across engine/capture instances.
 * Removing ports only after exit also closes the timeout/relaunch window. */
export function registerBrowserDebuggingPort(port: number, exited: Promise<void>): void {
  debuggingPorts.set(port, (debuggingPorts.get(port) ?? 0) + 1)
  const remove = () => {
    const remaining = (debuggingPorts.get(port) ?? 1) - 1
    if (remaining) debuggingPorts.set(port, remaining)
    else debuggingPorts.delete(port)
  }
  void exited.then(remove, remove)
}
export function isLinkLocalCaptureHost(host: string): boolean {
  host = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (isIP(host) === 4) return host.startsWith('169.254.')
  if (isIP(host) !== 6) return false
  host = new URL(`http://[${host}]/`).hostname.slice(1, -1)
  if ((parseInt(host.split(':')[0] || '0', 16) & 0xffc0) === 0xfe80) return true
  // IPv4-mapped/compatible addresses must not turn metadata IPv4 into an
  // allowed private IPv6 destination (WHATWG URLs canonicalize dotted tails).
  return /^::(?:ffff:)?a9fe:[0-9a-f]+$/.test(host)
}

/** Non-global addresses, including mapped IPv4, link-local and documentation ranges. */
export function isPrivatePreviewHost(host: string): boolean {
  host = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'local') return true
  if (isIP(host) === 4) {
    const [a, b, c] = host.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)
  }
  if (isIP(host) === 6) {
    const normalized = new URL(`http://[${host}]/`).hostname.slice(1, -1)
    const [first, second] = normalized.split(':').map((part) => parseInt(part || '0', 16))
    return !/^[23]/.test(normalized) || (first === 0x2001 && second < 0x200) || /^2001:db8:/i.test(normalized) || first === 0x2002 || first === 0x3fff
  }
  return false
}
export function isBoardCaptureUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !/^\/(?:api\/(?:auth|pairing)|auth|login|logout)(?:\/|$)/i.test(decodeURIComponent(url.pathname))
  } catch { return false }
}
const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '')
const portOf = (url: URL) => Number(url.port || (url.protocol === 'https:' ? 443 : 80))
export function isCaptureControlUrl(value: string, origins: readonly string[], ports: readonly number[]): boolean {
  const url = new URL(value)
  return origins.some((origin) => new URL(origin).origin === url.origin) || ports.includes(portOf(url)) || debuggingPorts.has(portOf(url))
}
export async function resolveCaptureDestination(value: string, resolve: CaptureResolver = captureLookup): Promise<CaptureDestination> {
  if (!isBoardCaptureUrl(value)) throw new Error('Unsafe Board capture URL')
  if (isCaptureControlUrl(value, [], [])) throw new Error('Blocked browser debugging port')
  const url = new URL(value), host = hostOf(url)
  let addresses: CaptureAddress[]
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }]
  else {
    const signal = AbortSignal.timeout(5000)
    let abort!: () => void
    const timedOut = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Capture DNS timed out'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try { addresses = await Promise.race([resolve(host), timedOut]) }
    finally { signal.removeEventListener('abort', abort) }
  }
  if (isCaptureControlUrl(value, [], [])) throw new Error('Blocked browser debugging port')
  if (!addresses.length || addresses.some((a) => !isIP(a.address))) throw new Error('No usable capture DNS answer')
  if (isLinkLocalCaptureHost(host) || addresses.some((a) => isLinkLocalCaptureHost(a.address))) throw new Error('Blocked link-local capture destination')
  const privateAnswers = addresses.filter((a) => isPrivatePreviewHost(a.address)).length
  if (privateAnswers && privateAnswers !== addresses.length) throw new Error('Mixed public/private capture DNS answers')
  return { url: url.href, origin: url.origin, addresses, policy: isPrivatePreviewHost(host) || privateAnswers ? 'private' : 'public' }
}

/** One DNS memo per job. The selected address is also pinned in the Node HTTP socket;
 * merely checking DNS before letting Chromium resolve again would permit rebinding. */
export class CaptureRequestPolicy {
  private readonly dns = new Map<string, Promise<CaptureAddress[]>>()
  constructor(readonly destination: CaptureDestination, private readonly origins: readonly string[], private readonly ports: readonly number[], private readonly resolve: CaptureResolver = captureLookup) {
    this.dns.set(hostOf(new URL(destination.url)), Promise.resolve(destination.addresses))
  }
  async address(value: string): Promise<CaptureAddress> {
    if (!isBoardCaptureUrl(value) || isCaptureControlUrl(value, this.origins, this.ports)) throw new Error('Blocked capture URL')
    const url = new URL(value), host = hostOf(url)
    let answers = this.dns.get(host)
    if (!answers) {
      answers = isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : this.resolve(host)
      this.dns.set(host, answers)
    }
    const addresses = await answers
    // Browser launches can publish new control ports while DNS is pending.
    if (isCaptureControlUrl(value, this.origins, this.ports)) throw new Error('Blocked capture URL')
    if (!addresses.length || addresses.some((a) => !isIP(a.address))) throw new Error('No usable capture DNS answer')
    if (isLinkLocalCaptureHost(host) || addresses.some((a) => isLinkLocalCaptureHost(a.address))) throw new Error('Blocked link-local capture destination')
    if ((isPrivatePreviewHost(host) || addresses.some((a) => isPrivatePreviewHost(a.address)))
      && !(this.destination.policy === 'private' && url.origin === this.destination.origin && addresses.every((a) => isPrivatePreviewHost(a.address)))) {
      throw new Error('Blocked private capture destination')
    }
    return addresses[0]
  }
}
