// Synthetic interactive CLI only. Tests prepend their own Node shebang.
const fs = require('node:fs')
if (process.argv[2] === '--version') {
  console.log('2.1.316 (Claude Code)')
  process.exit(0)
}
const prompt = process.argv[3]
if (!process.env.TERM) {
  console.error('Synthetic interactive CLI requires TERM')
  process.exit(1)
}
fs.writeFileSync(`${process.env.CLAUDE_CONFIG_DIR}/observed.json`, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR,
  files: fs.readdirSync('.'), term: process.env.TERM,
}))
console.log(' Accessing workspace:')
console.log(` ${process.cwd()}`)
console.log(" Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.")
console.log(" Claude Code'll be able to read, edit, and execute files here.")
console.log(' Security guide')
console.log(' ❯ No, exit')
console.log('   Yes, I trust this folder')
console.log(' Enter to confirm · Esc to cancel')
process.stdin.setRawMode(true)
let input = ''
process.stdin.on('data', (chunk) => {
  input += chunk.toString()
  if (!input.includes('\x1b[B') || !/[\r\n]/.test(input)) return
  fs.writeFileSync(`${process.env.CLAUDE_CONFIG_DIR}/trusted`, process.cwd())
  if (prompt === 'timeout') return
  if (prompt === 'malformed') console.log('Created cloud session without a receipt')
  else {
    console.log('Created cloud session: Synthetic task')
    console.log('View: https://claude.ai/code/session_ABCDEFGHIJ1234?from=cli&m=0')
    console.log('Resume with: claude --teleport session_ABCDEFGHIJ1234')
  }
  process.exit(0)
})
