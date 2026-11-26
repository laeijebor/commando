import type { ClientRequest } from 'node:http'
import { isIP, type Socket } from 'node:net'
import type { CaptureAddress } from './board-capture-policy.js'

function normalizedAddress(value: string | undefined): string | undefined {
  if (!value) return
  if (isIP(value) === 4) return value
  if (isIP(value) !== 6) return
  try {
    const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1)
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical)
    if (!mapped) return canonical
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  } catch { return undefined }
}

export function assertPinnedPeer(socket: Pick<Socket, 'remoteAddress'> | null | undefined, address: CaptureAddress): void {
  const expected = normalizedAddress(address.address)
  if (!expected || normalizedAddress(socket?.remoteAddress) !== expected) throw new Error('Request socket connected to an unapproved address')
}

/** Use with agent:false: lookup pins new sockets, and this check also rejects
 * an unexpected connected peer before queued HTTP writes can be flushed. */
export function guardPinnedSocket(request: ClientRequest, address: CaptureAddress): void {
  request.once('socket', (socket) => {
    const verify = () => {
      try { assertPinnedPeer(socket, address) }
      catch (error) { request.destroy(error as Error); socket.destroy() }
    }
    if (socket.connecting || !socket.remoteAddress) socket.prependOnceListener('connect', verify)
    else verify()
  })
}
