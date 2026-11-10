// Byte-counting TCP pipe: node tcp-count.mjs <listen> <upstream>
import net from 'node:net'
const [l, u] = process.argv.slice(2).map(Number); let up = 0, down = 0
net.createServer((c) => { const s = net.connect(u, '127.0.0.1'); c.on('data', (d) => { up += d.length; s.write(d) }); s.on('data', (d) => { down += d.length; c.write(d) }); c.on('end', () => s.end()); s.on('end', () => c.end()); c.on('error', () => s.destroy()); s.on('error', () => c.destroy()) }).listen(l, '127.0.0.1')
setInterval(() => console.log(JSON.stringify({ up, down })), 2000)
