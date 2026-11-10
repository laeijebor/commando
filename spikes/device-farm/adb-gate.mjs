#!/usr/bin/env node
// Spike: an adb-protocol-aware gate in front of the host's adb server.
// Laptops point ADB_SERVER_SOCKET=tcp:<host>:<port> at it. It only lets a connection
// reach the serials the tenant currently leases, filters `adb devices`, and refuses
// host-wide commands (kill-server, connect, disconnect, transport-any).
// usage: node adb-gate.mjs <listenPort> <allowedSerial[,serial...]> [upstreamPort=5037]
import net from 'node:net'

const [listenPort, allowedArg, upstreamPort = '5037'] = process.argv.slice(2)
const allowed = new Set(allowedArg.split(','))
const stats = { connections: 0, denied: 0, bytesUp: 0, bytesDown: 0 }

const frame = (s) => Buffer.from(s.length.toString(16).padStart(4, '0') + s)
const fail = (sock, msg) => { stats.denied++; console.log(`DENY  ${msg}`); sock.end(Buffer.concat([Buffer.from('FAIL'), frame(msg)])) }

function serialOf(req) {
  let m
  if ((m = /^host:transport:(.+)$/.exec(req))) return m[1]
  if ((m = /^host:tport:serial:(.+)$/.exec(req))) return m[1]
  if ((m = /^host-serial:([^:]+(?::\d+)?):/.exec(req))) return m[1]
  return undefined
}

net.createServer((client) => {
  stats.connections++
  let head = Buffer.alloc(0)
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk])
    if (head.length < 4) return
    const len = parseInt(head.subarray(0, 4).toString(), 16)
    if (head.length < 4 + len) return
    client.off('data', onData)
    const req = head.subarray(4, 4 + len).toString()
    const rest = head.subarray(4 + len)
    const serial = serialOf(req)
    if (/^host:(kill|connect|disconnect|reconnect|transport-any|tport:any|transport-usb|tport:usb|transport-local|tport:local|track-devices)/.test(req)) return fail(client, `farm: '${req}' is not allowed; use -s <leased serial>`)
    if (serial && !allowed.has(serial)) return fail(client, `farm: you don't hold a lease on ${serial}`)
    const upstream = net.connect(Number(upstreamPort), '127.0.0.1')
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    const filterDevices = /^host:devices(-l)?$/.test(req)
    console.log(`ALLOW ${req}`)
    upstream.write(Buffer.concat([head.subarray(0, 4 + len), rest]))
    if (filterDevices) {
      let buf = Buffer.alloc(0)
      upstream.on('data', (d) => { buf = Buffer.concat([buf, d]) })
      upstream.on('end', () => {
        if (buf.subarray(0, 4).toString() !== 'OKAY') return client.end(buf)
        const body = buf.subarray(8).toString().split('\n').filter((l) => l && allowed.has(l.split(/\s+/)[0])).map((l) => l + '\n').join('')
        client.end(Buffer.concat([Buffer.from('OKAY'), frame(body)]))
      })
    } else {
      client.on('data', (d) => { stats.bytesUp += d.length; upstream.write(d) })
      upstream.on('data', (d) => { stats.bytesDown += d.length; client.write(d) })
      client.on('end', () => upstream.end()); upstream.on('end', () => client.end())
    }
  }
  client.on('data', onData)
}).listen(Number(listenPort), '127.0.0.1', () => console.log(`adb-gate on :${listenPort} allowing ${[...allowed].join(',')}`))

process.on('SIGUSR2', () => console.log('STATS', JSON.stringify(stats)))
setInterval(() => console.log('STATS', JSON.stringify(stats)), 30_000).unref()
