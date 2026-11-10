#!/usr/bin/env node
// Spike: a lease-aware gateway in front of an Argent tool-server.
// Laptops set ARGENT_TOOLS_URL=http://<host>:<port> and ARGENT_AUTH_TOKEN=<tenant token>.
// Every /tools/:name call is checked against the tenant's *live* leases in Commando's
// device-lock registry; list-devices is filtered to leased devices; host-wide tools are refused.
// usage: COMMANDO_TOKEN=... ARGENT_UPSTREAM=http://127.0.0.1:3101 ARGENT_UPSTREAM_TOKEN=... \
//        node argent-gate.mjs <port> '<json tenants: {"tenant-token":"AS-NAME"}>'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [port, tenantsJson] = process.argv.slice(2)
const tenants = JSON.parse(tenantsJson)
const upstream = new URL(process.env.ARGENT_UPSTREAM)
const commando = `http://127.0.0.1:${process.env.COMMANDO_PORT ?? 4310}/api/device-locks`
const DENY = new Set(['update-argent', 'stop-all-simulator-servers', 'stop-metro', 'dismiss-update'])
const DEVICE_KEYS = ['udid', 'device_id', 'serial']

// CoreDevice identifier (what the lock stores) -> hardware UDID (what Argent uses).
function iosAliases() {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'gate-')), out = join(dir, 'd.json')
    execFileSync('xcrun', ['devicectl', 'list', 'devices', '--quiet', '--json-output', out], { timeout: 20_000 })
    const devices = JSON.parse(readFileSync(out, 'utf8')).result.devices
    return new Map(devices.map((d) => [d.identifier, d.hardwareProperties?.udid]).filter(([, u]) => u))
  } catch { return new Map() }
}
const aliases = iosAliases()

let cache = { at: 0, view: null }
async function leasedDeviceIds(as) {
  if (Date.now() - cache.at > 2000) {
    const res = await fetch(commando, { headers: { Authorization: `Bearer ${process.env.COMMANDO_TOKEN}` } })
    cache = { at: Date.now(), view: await res.json() }
  }
  const { resources, holders } = cache.view
  const ids = new Set()
  for (const h of holders.filter((h) => h.as === as)) {
    const r = resources.find((r) => r.id === h.resourceId)
    if (!r) continue
    if (r.kind === 'emulator') ids.add('emulator-*')
    if (r.serial) { ids.add(r.serial); if (aliases.get(r.serial)) ids.add(aliases.get(r.serial)) }
  }
  return ids
}
const allowed = (ids, id) => ids.has(id) || (ids.has('emulator-*') && /^emulator-\d+$/.test(id))

const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

http.createServer(async (req, res) => {
  const as = tenants[(req.headers.authorization ?? '').replace(/^Bearer /, '')]
  if (!as) return send(res, 401, { error: 'farm: unknown tenant token' })
  const chunks = []; for await (const c of req) chunks.push(c)
  let body = Buffer.concat(chunks)
  const tool = /^\/tools\/([^/?]+)/.exec(req.url)?.[1]
  const ids = await leasedDeviceIds(as)
  if (tool) {
    if (DENY.has(tool)) { console.log(`DENY  ${as} ${tool}`); return send(res, 403, { error: `farm: ${tool} is host-wide and not available to tenants` }) }
    const args = body.length ? JSON.parse(body) : {}
    const flat = args.args ?? args
    const target = DEVICE_KEYS.map((k) => flat[k]).find(Boolean) ?? (tool === 'boot-device' ? flat.avdName : undefined)
    if (target && !allowed(ids, target)) { console.log(`DENY  ${as} ${tool} ${target}`); return send(res, 403, { error: `farm: you don't hold a lease on ${target}. Run: farm lock <device> --as ${as}` }) }
    console.log(`ALLOW ${as} ${tool} ${target ?? ''}`)
  }
  const headers = { ...req.headers, host: upstream.host, authorization: `Bearer ${process.env.ARGENT_UPSTREAM_TOKEN}` }
  if (tool === 'list-devices') delete headers['accept-encoding']
  const up = http.request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers }, (ur) => {
    if (tool !== 'list-devices') { res.writeHead(ur.statusCode, ur.headers); return ur.pipe(res) }
    const parts = []; ur.on('data', (d) => parts.push(d)); ur.on('end', () => {
      try {
        const text = Buffer.concat(parts).toString()
        const filter = (o) => { if (o && Array.isArray(o.devices)) { o.devices = o.devices.filter((d) => allowed(ids, d.serial ?? d.udid ?? d.id)); o.avds = [] } ; for (const v of Object.values(o ?? {})) if (v && typeof v === 'object') filter(v); return o }
        const out = JSON.stringify(filter(JSON.parse(text)))
        const h = { ...ur.headers }; delete h['content-length']
        res.writeHead(ur.statusCode, h); res.end(out)
      } catch { res.writeHead(ur.statusCode, ur.headers); res.end(Buffer.concat(parts)) }
    })
  })
  up.on('error', (e) => send(res, 502, { error: String(e) }))
  up.end(body)
}).listen(Number(port), '127.0.0.1', () => console.log(`argent-gate on :${port} -> ${upstream.href}`))
