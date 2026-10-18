import type { IncomingMessage, ServerResponse } from 'node:http'
import { requestMatchesBearer, type PairingRegistry } from './pairing.js'

/** Binds device principals to every active HTTP request and upgraded transport. */
export class PairingRequestAuth {
  private readonly principals = new WeakMap<IncomingMessage, string>()
  private readonly releases = new WeakMap<IncomingMessage, () => void>()
  constructor(private readonly registry: PairingRegistry) {}

  deviceId(request: IncomingMessage): string | undefined { return this.principals.get(request) }

  trackResponse(request: IncomingMessage, response: ServerResponse): void {
    const release = () => { this.releases.get(request)?.(); this.releases.delete(request) }
    response.once('finish', release)
    response.once('close', release)
  }

  authorize(request: IncomingMessage, url: URL): boolean {
    let id: string | null = null
    if (!requestMatchesBearer(request, url, (token) => { id = this.registry.authenticate(token); return id !== null }) || !id) return false
    this.principals.set(request, id)
    if (!this.releases.has(request)) {
      const unregister = this.registry.trackConnection(id, () => request.socket.destroy())
      const release = () => { unregister(); request.socket.off('close', release) }
      this.releases.set(request, release)
      request.socket.once('close', release)
    }
    return true
  }
}
