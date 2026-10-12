import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./commando-canvas', import.meta.url))
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function fixture(errors: string[] = [], status = '200') {
  const dir = await mkdtemp(join(tmpdir(), 'commando-canvas-cli-')); dirs.push(dir)
  const bin = join(dir, 'bin'), artifact = join(dir, 'a board'), token = join(dir, 'token'), calls = join(dir, 'calls.jsonl')
  await mkdir(bin); await mkdir(artifact); await writeFile(token, 'test token')
  const curl = join(bin, 'curl')
  await writeFile(curl, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2), url = args.find(arg => arg.startsWith('http:'));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
let body, status;
if (url.endsWith('/api/redline/artifacts')) { body = {id:'0123456789abcdef',url:'http://127.0.0.1:4410/redline/artifacts/0123456789abcdef/'}; status='201'; }
else if (url.endsWith('/canvas')) {body = {manifest:{title:'Board',frames:[]},errors:${JSON.stringify(errors)}};status=${JSON.stringify(status)};}
else {body={webPaneId:'w-12345678'};status='201';}
fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(body));
process.stdout.write(status);
`)
  await chmod(curl, 0o755)
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_PANE: '%12', COMMANDO_PORT: '4410', COMMANDO_AGENT_HOOK_TOKEN_PATH: token }
  delete env.BASH_ENV
  return { dir, artifact, calls, env }
}
async function run(args: string[], env: NodeJS.ProcessEnv) {
  return await new Promise<{ code: string | number; stdout: string; stderr: string }>((resolve) => {
    execFile('bash', [script, ...args], { env, timeout: 10000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))
  })
}
describe('commando-canvas CLI', () => {
  it('registers, validates and opens a canvas with custom manifest, anchor, token and port', async () => {
    const f = await fixture(['frames[0].focus: must be a positive integer'])
    const result = await run([f.artifact, '--manifest', 'board.json'], f.env)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('w-12345678\n')
    expect(result.stderr).toContain('frames[0].focus')
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
    expect(calls).toHaveLength(3)
    expect(calls[0]).toContain('Authorization: Bearer test token')
    expect(calls[1]).toContain('manifest=board.json')
    const body = JSON.parse(calls[2][calls[2].indexOf('--data') + 1])
    expect(body).toEqual({ url: 'http://127.0.0.1:4410/redline/artifacts/0123456789abcdef/', anchor: '%12', engine: 'webkit', content: { kind: 'canvas', artifactId: '0123456789abcdef', manifest: 'board.json' } })
  })
  it.each([['canvas.json: must be valid JSON', '200'], ['canvas.json: not found', '404']])('does not open an unusable manifest: %s', async (error, status) => {
    const f = await fixture([error], status), result = await run([f.artifact], f.env)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(error)
    expect((await readFile(f.calls, 'utf8')).trim().split('\n')).toHaveLength(2)
  })
  it('reports missing token and daemon-down errors', async () => {
    const f = await fixture()
    expect((await run([f.artifact], { ...f.env, COMMANDO_AGENT_HOOK_TOKEN_PATH: join(f.dir, 'missing') })).stderr).toContain('agent hook token not readable')
    await writeFile(join(f.dir, 'bin/curl'), '#!/usr/bin/env bash\nexit 7\n')
    const result = await run([f.artifact], f.env)
    expect(result.code).toBe(1); expect(result.stderr).toContain('daemon unavailable at http://127.0.0.1:4410')
  })
})
