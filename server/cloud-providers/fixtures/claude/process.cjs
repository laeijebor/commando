// Synthetic process fixture. The test adds a shebang pointing to its Node binary.
const { spawn } = require('node:child_process')
const mode = process.argv[2]
if (mode === 'inspect') {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { input += chunk })
  process.stdin.on('end', () => {
    const keys = JSON.parse(process.argv[3])
    const env = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]))
    process.stdout.write(JSON.stringify({ argv: process.argv.slice(4), cwd: process.cwd(), env, input }))
  })
} else if (mode === 'hang') {
  process.on('SIGTERM', () => {})
  process.stdout.write('ready')
  setInterval(() => {}, 1000)
} else if (mode === 'cooperative') {
  process.on('SIGTERM', () => process.exit(0))
  process.stdout.write('ready')
  setInterval(() => {}, 1000)
} else if (mode === 'overflow') {
  process.stdout.write('é'.repeat(100_000))
  process.stderr.write('x'.repeat(100_000))
} else if (mode === 'early-exit') {
  process.stdin.destroy()
  process.stderr.write('synthetic diagnostic')
  process.exit(7)
} else if (mode === 'inherited-pipes') {
  // Exits naturally soon; only this fixture's descendant owns these pipes.
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)'], { stdio: ['ignore', 1, 2] }).unref()
  process.stdout.write('parent exited')
} else if (mode === 'receipt-then-hang') {
  process.on('SIGTERM', () => {})
  process.stdout.write('{"ok":true,"session_id":"session_synthetic","url":"https://claude.ai/code/session_synthetic"}')
  setInterval(() => {}, 1000)
} else {
  process.exit(0)
}
