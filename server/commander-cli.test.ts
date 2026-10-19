import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookInstaller, generatedAgentsCli } from './agent-hook-installer.js'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
type Cli = {
  parseAgentsArgs: (args: string[]) => { method: string; path: string; body?: unknown }
  runAgentsCli: (args: string[], request: (...args: any[]) => Promise<any>, options?: { out?: (...args: any[]) => void; err?: (...args: any[]) => void }) => Promise<number>
  agentsRequest: (env: Record<string, string>, fetch?: (...args: any[]) => Promise<any>, read?: (...args: any[]) => Promise<any>) => Promise<(...args: any[]) => Promise<any>>
}
async function load(source = generatedAgentsCli('/test/token')): Promise<Cli> {
  return import(`data:text/javascript;base64,${Buffer.from(source.replace(/^#![^\n]*\n/, '')).toString('base64')}`)
}
describe('generated Commander CLI', () => {
  it('parses all commands, preserving exact words and encoding pane ids', async () => {
    const cli = await load()
    expect(cli.parseAgentsArgs(['list'])).toMatchObject({ method: 'GET', path: '/list' })
    expect(cli.parseAgentsArgs(['read', '%12', '--turns', '10'])).toMatchObject({ path: '/read?pane=%2512&turns=10' })
    expect(cli.parseAgentsArgs(['relay', '%1', ' exact\nwords ', '--steer'])).toEqual({ method: 'POST', path: '/relay', body: { pane: '%1', text: ' exact\nwords ', steer: true } })
    expect(cli.parseAgentsArgs(['nudge', '%1', 'hello'])).toMatchObject({ path: '/nudge', body: { pane: '%1', text: 'hello' } })
    expect(cli.parseAgentsArgs(['relays'])).toMatchObject({ path: '/relays' })
    expect(cli.parseAgentsArgs(['cancel', 'abc-123'])).toMatchObject({ method: 'POST', path: '/relays/abc-123/cancel' })
    for (const args of [[], ['list', 'extra'], ['read', '%1', '--turns', '11'], ['relay', '%1', 'hello', '--queue'], ['nudge', '%1', 'hello', '--steer'], ['relay', '%1', 'bad\x00'], ['read', '1'], ['cancel', '../bad']]) expect(() => cli.parseAgentsArgs(args)).toThrow('Usage')
  })
  it('prints needs-you first by default, JSON on request, and nonzero for API errors', async () => {
    const cli = await load(), out = vi.fn(), err = vi.fn()
    const agents = [{ paneId: '%1', title: 'Done', sessionName: 'Fixes', status: 'done', headline: 'Fixed' }, { paneId: '%2', title: 'Question', needsYou: true, brief: { text: 'Needs an answer' } }]
    const request = vi.fn(async () => ({ status: 200, result: agents }))
    expect(await cli.runAgentsCli(['list'], request, { out, err })).toBe(0)
    expect(out.mock.calls[0][0]).toBe('%2 NEEDS YOU · Question · Needs an answer\n%1 done · Done (session: Fixes) · Fixed')
    await cli.runAgentsCli(['list', '--json'], request, { out }); expect(out).toHaveBeenLastCalledWith(agents)
    expect(await cli.runAgentsCli(['relays'], async () => ({ status: 403, result: { error: 'Only Commander' } }), { out, err })).toBe(1)
    expect(err).toHaveBeenLastCalledWith('Only Commander')
  })
  it('uses the hook token path, pane header and configured port in fetch requests', async () => {
    const cli = await load(), read = vi.fn(async () => ' token\n'), fetch = vi.fn(async () => ({ status: 200, json: async () => ({ ok: true }) }))
    const request = await cli.agentsRequest({ TMUX_PANE: '%9', COMMANDO_PORT: '4400', COMMANDO_AGENT_HOOK_TOKEN_PATH: '/private/token' }, fetch, read)
    await request('POST', '/relay', { pane: '%1', text: 'hello' })
    expect(read).toHaveBeenCalledWith('/private/token', 'utf8')
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:4400/api/commander/agent/relay', expect.objectContaining({ headers: { Authorization: 'Bearer token', 'X-Commando-Pane': '%9', 'Content-Type': 'application/json' }, body: JSON.stringify({ pane: '%1', text: 'hello' }) }))
    await expect(cli.agentsRequest({}, fetch, read)).rejects.toThrow('TMUX_PANE')
    await expect(cli.agentsRequest({ TMUX_PANE: '%1', COMMANDO_PORT: '0' }, fetch, read)).rejects.toThrow('COMMANDO_PORT')
  })
  it('installs the executable into a temporary home alongside commando-chat with a realpath guard', async () => {
    const home = await mkdtemp(join(tmpdir(), 'commander-cli-')); dirs.push(home)
    const paths = await new AgentHookInstaller({ home }).install()
    expect(paths.agentsCliPath).toBe(join(home, '.commando/hooks/commando-agents.mjs'))
    const source = await readFile(paths.agentsCliPath, 'utf8')
    expect(source).toBe(generatedAgentsCli(paths.tokenPath))
    expect(source).toContain('pathToFileURL(realpathSync(process.argv[1])).href')
    expect((await stat(paths.agentsCliPath)).mode & 0o777).toBe(0o700)
    expect((await load(source)).parseAgentsArgs(['list'])).toMatchObject({ method: 'GET' })
  })
})

it.each(['relay', 'nudge'])('prints %s receipts as human lines or JSON and fails on a failed relay', async (command) => {
  const cli = await load(), out = vi.fn(), err = vi.fn()
  for (const status of ['queued', 'delivered']) {
    const result = { ok: true, relay: { id: 'abc', status } }, request = vi.fn(async () => ({ status: 200, result }))
    expect(await cli.runAgentsCli([command, '%1', 'Hello'], request, { out, err })).toBe(0)
    expect(out).toHaveBeenLastCalledWith(status + ' abc')
    expect(await cli.runAgentsCli([command, '%1', 'Hello', '--json'], request, { out, err })).toBe(0)
    expect(out).toHaveBeenLastCalledWith(result)
  }
  for (const flags of [[], ['--json']]) {
    out.mockClear()
    expect(await cli.runAgentsCli([command, '%1', 'Hello', ...flags], async () => ({ status: 200, result: { ok: true, relay: { status: 'failed', error: 'Text rejected' } } }), { out, err })).toBe(1)
    expect(err).toHaveBeenLastCalledWith('Text rejected'); expect(out).not.toHaveBeenCalled()
  }
})

it('preserves a message whose exact text is --json, including with steering and a separate JSON flag', async () => {
  const cli = await load(), out = vi.fn(), request = vi.fn(async () => ({ status: 200, result: { ok: true, relay: { id: 'abc', status: 'queued' } } }))
  expect(cli.parseAgentsArgs(['relay', '%1', '--json'])).toMatchObject({ body: { text: '--json' } })
  await cli.runAgentsCli(['relay', '%1', '--json'], request, { out })
  expect(out).toHaveBeenLastCalledWith('queued abc')
  expect(cli.parseAgentsArgs(['relay', '%1', '--json', '--steer', '--json'])).toMatchObject({ body: { text: '--json', steer: true }, json: true })
})
