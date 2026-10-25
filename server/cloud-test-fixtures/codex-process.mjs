// Entirely synthetic CLI-shaped process: no provider contact and no credential reads.
import assert from 'node:assert/strict'

const args = process.argv.slice(2)
assert.equal(process.env.COMMANDO_TOKEN, undefined)
assert.equal(process.env.OPENAI_API_KEY, undefined)
assert.equal(process.env.NODE_OPTIONS, undefined)
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.0.0-synthetic\n')
} else if (args[0] === 'cloud' && args[1] === 'exec') {
  assert.deepEqual(args.slice(0, 7), ['cloud', 'exec', '--env', 'env_fixture', '--branch', 'main', '--'])
  assert.equal(args.length, 8)
  assert.equal(args[7], "Synthetic task; $(do-not-execute) 'quoted'")
  process.stdout.write('https://chatgpt.com/codex/tasks/task_process\n')
} else if (args[0] === 'cloud' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ tasks: [{ id: 'task_process', url: 'https://chatgpt.com/codex/tasks/task_process', status: 'ready', updated_at: '2026-09-13T00:00:00.000Z' }], cursor: null }))
} else if (args[0] === 'cloud' && args[1] === 'diff') {
  assert.equal(args[2], 'task_process')
  process.stdout.write('--- a/synthetic.txt\n+++ b/synthetic.txt\n@@ -1 +1 @@\n-old\n+new\n')
} else {
  throw new Error('Unexpected synthetic CLI command')
}
