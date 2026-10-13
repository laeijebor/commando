import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./commando-guide', import.meta.url))
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

const GUIDE = {
  title: 'Rollout', waiting: true, marks: {},
  steps: [
    { id: 'copy', label: 'Copy the secret', checkpoint: false, checked: true, byUser: true, note: 'printed DIFFERENT' },
    { id: 'store', label: 'Store it', checkpoint: false, checked: true, byUser: false },
    { id: 'phase-1', label: 'Phase 1 done', checkpoint: true, checked: false, byUser: false },
  ],
  changes: [{ id: 'copy' }],
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'commando-guide-cli-')); dirs.push(dir)
  const bin = join(dir, 'bin'), guides = join(dir, 'my guides'), token = join(dir, 'token'), calls = join(dir, 'calls.jsonl')
  await mkdir(bin); await mkdir(guides); await writeFile(token, 'test token'); await writeFile(join(guides, 'deploy.md'), '# Deploy\n')
  const curl = join(bin, 'curl')
  await writeFile(curl, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2), url = args.find(arg => arg.startsWith('http:'));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
let body, status = '200';
if (url.endsWith('/api/redline/artifacts')) { body = {id:'0123456789abcdef',url:'http://127.0.0.1:4410/redline/artifacts/0123456789abcdef/'}; status='201'; }
else if (url.endsWith('/guide')) body = {ok:true,guide:${JSON.stringify(GUIDE)}};
else body = {webPaneId:'w-12345678'};
fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(body));
process.stdout.write(status);
`)
  await chmod(curl, 0o755)
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_PANE: '%12', COMMANDO_PORT: '4410', COMMANDO_AGENT_HOOK_TOKEN_PATH: token }
  delete env.BASH_ENV
  return { dir, guides, calls, env }
}
async function run(args: string[], env: NodeJS.ProcessEnv) {
  return await new Promise<{ code: string | number; stdout: string; stderr: string }>((resolve) => {
    execFile('bash', [script, ...args], { env, timeout: 10000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))
  })
}
const readCalls = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])

describe('commando-guide CLI', () => {
  it('registers the guide folder and opens a guide tab anchored to this pane', async () => {
    const f = await fixture()
    const result = await run([join(f.guides, 'deploy.md')], f.env)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('w-12345678\n')
    const calls = await readCalls(f.calls)
    expect(calls[0]).toContain('Authorization: Bearer test token')
    expect(JSON.parse(calls[0][calls[0].indexOf('--data') + 1])).toEqual({ dir: f.guides })
    expect(JSON.parse(calls[1][calls[1].indexOf('--data') + 1])).toEqual({ url: 'http://127.0.0.1:4410/redline/artifacts/0123456789abcdef/', anchor: '%12', engine: 'webkit', content: { kind: 'guide', artifactId: '0123456789abcdef', file: 'deploy.md' } })
  })

  it('refuses non-markdown files and repo roots', async () => {
    const f = await fixture()
    await writeFile(join(f.guides, 'deploy.html'), '')
    expect((await run([join(f.guides, 'deploy.html')], f.env)).stderr).toContain('must be a .md file')
    await mkdir(join(f.guides, '.git'))
    expect((await run([join(f.guides, 'deploy.md')], f.env)).stderr).toContain('put the guide in its own folder')
  })

  it('prints the user progress readably and as JSON', async () => {
    const f = await fixture()
    const text = await run(['state', 'w-12345678'], f.env)
    expect(text.code, text.stderr).toBe(0)
    expect(text.stdout).toBe([
      'Rollout — 2/3 done · 1 change(s) not yet sent to you (update queued)',
      '[x] copy: Copy the secret — note: "printed DIFFERENT"',
      '[x] store: Store it (agent)',
      '[☆] phase-1: Phase 1 done',
      '',
    ].join('\n'))
    expect(JSON.parse((await run(['state', 'w-12345678', '--json'], f.env)).stdout).guide.title).toBe('Rollout')
    expect((await readCalls(f.calls))[0].at(-1)).toBe('http://127.0.0.1:4410/api/web-panes/w-12345678/guide')
  })

  it('rejects malformed web pane ids', async () => {
    const f = await fixture()
    expect((await run(['state', 'nope'], f.env)).code).toBe(2)
  })
})
