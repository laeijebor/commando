import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
const script = fileURLToPath(new URL('./commando-board', import.meta.url))
let root: string, env: NodeJS.ProcessEnv, status: number
function calls(): { url: string; method: string; authorization: string; body: unknown }[] {
  try { return readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) } catch { return [] }
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'board-cli-test-')); const tokenPath = join(root, 'token'); writeFileSync(tokenPath, 'private-test-token')
  status = 200
  writeFileSync(join(root, 'fetch.mjs'), `
import fs from 'node:fs'
const root = ${JSON.stringify(root)}
globalThis.fetch = async (url, init) => {
  fs.appendFileSync(root + '/calls', JSON.stringify({url: new URL(url).pathname, method: init.method, authorization: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined}) + '\\n')
  const status = Number(fs.readFileSync(root + '/status', 'utf8'))
  return {ok: status < 400, status, json: async () => status < 400 ? {items: [{key: 'url:https://example.com/a', kind: 'link', state: 'closed', title: 'Example'}]} : {error: 'Board is full'}}
}
`)
  env = { ...process.env, HOME: root, TMUX_PANE: '%12', COMMANDO_PORT: '4410', COMMANDO_AGENT_HOOK_TOKEN_PATH: tokenPath }
})
afterEach(async () => { rmSync(root, { recursive: true, force: true }) })
function run(args: string[], customEnv = env) {
  writeFileSync(join(root, 'status'), String(status))
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((r) => execFile(process.execPath, ['--import', join(root, 'fetch.mjs'), script, ...args], { env: customEnv, timeout: 10000 }, (error, stdout, stderr) => r({ code: error?.code ?? 0, stdout, stderr })))
}
describe('commando-board CLI', () => {
  it('lists readable items or JSON, resolves port/pane and keeps token in auth header', async () => {
    const listed = await run(['list']); expect(listed.code).toBe(0); expect(listed.stdout).toContain('url:https://example.com/a\tlink\tclosed\tExample')
    const json = await run(['list', '--json']); expect(JSON.parse(json.stdout).items).toHaveLength(1)
    expect(calls()[0]).toMatchObject({ url: '/api/boards/by-pane/%2512', method: 'GET', authorization: 'Bearer private-test-token' })
    expect(listed.stdout + listed.stderr).not.toContain('private-test-token')
  })
  it.each([
    [['add', './file with spaces.png', '--title', 'Picture', '--caption', 'Look', '--group', 'evidence', '--pin'], '/items', 'POST', { path: resolve('./file with spaces.png'), title: 'Picture', caption: 'Look', group: 'evidence', pinned: true }],
    [['add', 'https://example.com/a?x=1'], '/items', 'POST', { url: 'https://example.com/a?x=1' }],
    [['clip', 'Decision with "quotes"\nand lines', '--tone', 'decision', '--group', 'g'], '/items', 'POST', { text: 'Decision with "quotes"\nand lines', tone: 'decision', group: 'g' }],
    [['group', 'g', '--title', 'Evidence', '--tone', 'green', '--near', 'h'], '/groups', 'POST', { id: 'g', title: 'Evidence', tone: 'green', near: 'h' }],
    [['link', 'g', 'url:https://example.com/a', '--label', 'supports'], '/links', 'POST', { from: 'g', to: 'url:https://example.com/a', label: 'supports' }],
    [['place', 'clip:one', '--group', 'g'], '/place', 'POST', { key: 'clip:one', group: 'g' }],
    [['remove', 'url:https://example.com/a?x=1'], '/items/url%3Ahttps%3A%2F%2Fexample.com%2Fa%3Fx%3D1', 'DELETE', undefined],
  ] as const)('sends %j through the pane alias', async (args, path, method, body) => {
    const result = await run([...args]); expect(result.code, result.stderr).toBe(0)
    expect(calls()[0]).toMatchObject({ url: `/api/boards/by-pane/%2512${path}`, method, ...(body === undefined ? {} : { body }) })
  })
  it.each([[], ['group', 'g'], ['place', 'clip:one'], ['add', 'x', '--bogus'], ['clip', 'a', '--tone', 'bad'], ['list', '--title', 'a']])('rejects invalid arguments %j before HTTP', async (...input) => {
    const args = input.flat() as string[]
    expect((await run(args)).code).toBe(2); expect(calls()).toHaveLength(0)
  })
  it('reports missing pane/token and daemon errors without leaking credentials', async () => {
    expect((await run(['list'], { ...env, TMUX_PANE: '' })).code).toBe(1)
    expect((await run(['list'], { ...env, COMMANDO_AGENT_HOOK_TOKEN_PATH: join(root, 'missing') })).code).toBe(1)
    status = 409
    const result = await run(['add', 'https://example.com']); expect(result.code).toBe(1); expect(result.stderr).toContain('409: Board is full'); expect(result.stderr).not.toContain('private-test-token')
  })
})
