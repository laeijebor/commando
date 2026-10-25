// SYNTHETIC test executable. No network, auth-store access or real Codex tasks.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const fixture = name => readFileSync(new URL(name, import.meta.url), 'utf8')
assert.equal(process.env.CODEX_STARTING_DIFF, undefined)
assert.equal(process.env.COMMANDO_TOKEN, undefined)
assert.notEqual(process.cwd(), '/must/not/use')

if (args.length === 1 && args[0] === '--version') {
  console.log('codex-cli 0.0.0-synthetic')
} else if (args[0] === 'cloud' && args[1] === 'exec') {
  assert.equal(args.length, 8)
  assert.deepEqual(args.slice(2, 7), ['--env', 'env_synthetic', '--branch', 'feature/synthetic', '--'])
  process.stdout.write(fixture('create.stdout.txt'))
  if (args[7] === 'SYNTHETIC_NONZERO') process.exitCode = 1
} else if (args[0] === 'cloud' && args[1] === 'list') {
  assert.deepEqual(args.slice(2, 5), ['--json', '--limit', '20'])
  if (args.length === 5) process.stdout.write(fixture('list-page-1.json'))
  else {
    assert.deepEqual(args.slice(5), ['--cursor=synthetic-page-2'])
    process.stdout.write(fixture('list-page-2.json'))
  }
} else if (args[0] === 'cloud' && args[1] === 'diff') {
  assert.deepEqual(args, ['cloud', 'diff', 'task_synthetic_exact'])
  process.stdout.write(fixture('result.diff'))
} else {
  throw new Error('Unexpected synthetic CLI invocation')
}
