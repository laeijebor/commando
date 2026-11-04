import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
it('opens a default/custom HTML canvas and delegates all feedback subcommands literally', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slides-wrapper-')); dirs.push(dir)
  const bin = join(dir, 'bin'), calls = join(dir, 'calls'), token = join(dir, 'token')
  await mkdir(bin); await writeFile(token, 'test token')
  await writeFile(join(bin, 'curl'), `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2),url=args.find(x=>x.startsWith('http:')); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n'); const body=url.endsWith('/api/redline/artifacts')?{id:'0123456789abcdef',url:'http://localhost/redline/artifacts/0123456789abcdef/'}:url.endsWith('/canvas')?{errors:[],manifest:{title:'Deck',frames:[]}}:{webPaneId:'w-12345678'}; fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(body));process.stdout.write('200');`)
  await chmod(join(bin, 'curl'), 0o755)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_PANE: '%42', COMMANDO_AGENT_HOOK_TOKEN_PATH: token }
  const run = (args: string[]) => new Promise<string>((resolve, reject) => execFile('bash', [join(process.cwd(), 'scripts/commando-slides'), ...args], { env }, (error, out) => error ? reject(error) : resolve(out)))
  expect(await run([dir])).toBe('w-12345678\n'); expect(await run([dir, 'onepager.html'])).toBe('w-12345678\n')
  const thread = 'ct-' + 'a'.repeat(24)
  await run(['threads', 'w-12345678']); await run(['reply', 'w-12345678', thread, 'literal $text "here"', '--resolve']); await run(['resolve', 'w-12345678', thread]); await run(['spotlight', 'w-12345678', 'Chart', '--frame', 'evidence'])
  const args = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
  expect(args[1]).toContain('manifest=deck.html'); expect(args[4]).toContain('manifest=onepager.html')
  expect(JSON.parse(args[2][args[2].indexOf('--data') + 1]).content).toEqual({ kind: 'canvas', artifactId: '0123456789abcdef', manifest: 'deck.html' })
  expect(args.slice(6).map((call) => call.find((x) => x.startsWith('http:')))).toEqual(expect.arrayContaining([expect.stringContaining('/threads'), expect.stringContaining(`/threads/${thread}/replies`), expect.stringContaining(`/threads/${thread}/status`), expect.stringContaining('/spotlight?wait=0')]))
  expect(JSON.parse(args[7][args[7].indexOf('--data') + 1]).text).toBe('literal $text "here"')
})
