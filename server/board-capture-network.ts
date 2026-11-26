import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { CaptureAddress } from './board-capture-policy.js'

export type CaptureRequest = { url: string; method?: string; headers?: Record<string, string>; postData?: string; hasPostData?: boolean }
export type CaptureResponse = { status: number; headers: { name: string; value: string }[]; body: Buffer }
export type CaptureFetch = (request: CaptureRequest, address: CaptureAddress, signal: AbortSignal) => Promise<CaptureResponse>
const HOP_HEADERS = /^(?:connection|proxy-connection|proxy-authorization|transfer-encoding|upgrade|keep-alive|trailer)$/i
/** Never follow redirects or re-resolve a validated host. Browser requests are fulfilled
 * from this transport; Chromium's own network path is sent to an unusable proxy. */
export const fetchCaptureRequest: CaptureFetch = (request, address, signal) => new Promise((resolve, reject) => {
  if ((request.hasPostData && request.postData === undefined) || Buffer.byteLength(request.postData ?? '') > 1024 * 1024) {
    reject(new Error('Unsupported/oversized capture request body')); return
  }
  const url = new URL(request.url)
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([key]) => !HOP_HEADERS.test(key) && !/^(?:host|content-length|accept-encoding)$/i.test(key)))
  headers['accept-encoding'] = 'identity'
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: request.method ?? 'GET', headers, signal,
    lookup: (_host, options, callback) => {
      if (typeof options === 'object' && options.all) callback(null, [address])
      else callback(null, address.address, address.family)
    },
  }, (response) => {
    const chunks: Buffer[] = []; let size = 0
    response.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 20 * 1024 * 1024) response.destroy(new Error('Capture response exceeds 20 MiB'))
      else chunks.push(chunk)
    })
    response.on('error', reject)
    response.on('end', () => {
      const headers: CaptureResponse['headers'] = []
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const name = response.rawHeaders[i]
        if (!HOP_HEADERS.test(name) && !/^content-length$/i.test(name)) headers.push({ name, value: response.rawHeaders[i + 1] })
      }
      resolve({ status: response.statusCode ?? 502, headers, body: Buffer.concat(chunks) })
    })
  })
  req.on('error', reject)
  req.end(request.postData)
})
