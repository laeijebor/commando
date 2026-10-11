import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_PLANS_FOLDER, ChatPlanStore, handleChatPlans, planTitle } from './chat-plans.js'
import { NoteVaultManager } from './note-vaults.js'

const cleanup: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'commando-chat-plans-')))
  cleanup.push(root)
  const home = join(root, 'home')
  await mkdir(join(home, 'notes-vaults'), { recursive: true })
  const defaultDirectory = join(home, 'notes-vaults', 'default')
  const vaults = new NoteVaultManager({
    statePath: join(home, 'note-vaults.json'),
    defaultDirectory,
    legacyDirectory: join(home, 'notes'),
    legacyNotesPath: join(home, 'notes.json'),
    environment: {},
  })
  const store = new ChatPlanStore(vaults, join(root, 'chat-plans'))
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    void handleChatPlans(request, response, url, store).then((handled) => {
      if (!handled) {
        response.writeHead(404)
        response.end()
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { root, defaultDirectory, vaults, store, base, post }
}

describe('chat plan routes', () => {
  it('files a plan as a note in the default vault and says where', async () => {
    const { defaultDirectory, vaults, post } = await setup()
    const response = await post('/api/chat/plans/vault', { markdown: '# Add greeting.txt\n\n- Create it\n- Check it\n' })
    expect(response.status).toBe(201)
    const saved = await response.json() as { path: string; title: string; noteId: string }
    expect(saved.title).toBe('Add greeting.txt')
    expect(saved.path.startsWith(join(defaultDirectory, CHAT_PLANS_FOLDER))).toBe(true)
    expect(await readFile(saved.path, 'utf8')).toContain('- Create it')
    // It is an ordinary note of that vault.
    const { store } = await vaults.defaultStore()
    expect((await store.list()).map((note) => note.title)).toEqual(['Add greeting.txt'])
  })

  it('saves to the default vault even while another vault is open', async () => {
    const { root, defaultDirectory, vaults, post } = await setup()
    await vaults.snapshot()
    const other = join(root, 'other-vault')
    await mkdir(other)
    await vaults.open(other)
    const saved = await (await post('/api/chat/plans/vault', { markdown: 'Just do it' })).json() as { path: string; title: string }
    expect(saved.title).toBe('Just do it')
    expect(saved.path.startsWith(defaultDirectory)).toBe(true)
    expect(await readdir(other)).toEqual([])
  })

  it('stashes a plan for a new chat by content, and prunes old ones', async () => {
    const { root, store, post } = await setup()
    const first = await (await post('/api/chat/plans/file', { markdown: '# Long plan' })).json() as { path: string }
    const again = await (await post('/api/chat/plans/file', { markdown: '# Long plan' })).json() as { path: string }
    expect(first.path).toBe(again.path)
    expect(first.path.startsWith(join(root, 'chat-plans'))).toBe(true)
    expect(await readFile(first.path, 'utf8')).toBe('# Long plan')
    const old = join(root, 'chat-plans', `${'0'.repeat(64)}.md`)
    await writeFile(old, 'old')
    await utimes(old, new Date(0), new Date(0))
    expect(await store.prune()).toBe(1)
    expect(await readdir(join(root, 'chat-plans'))).toEqual([first.path.slice(first.path.lastIndexOf('/') + 1)])
  })

  it('refuses empty, oversized, non-JSON and non-POST requests', async () => {
    const { base, post } = await setup()
    expect((await post('/api/chat/plans/vault', { markdown: '  ' })).status).toBe(400)
    expect((await post('/api/chat/plans/vault', { markdown: 'x'.repeat(300 * 1024) })).status).toBe(413)
    expect((await fetch(`${base}/api/chat/plans/file`, { method: 'POST', body: 'plan' })).status).toBe(415)
    expect((await fetch(`${base}/api/chat/plans/vault`)).status).toBe(405)
    expect((await fetch(`${base}/api/chat/plans/other`, { method: 'POST' })).status).toBe(404)
  })

  it('titles a plan by its first heading, else its first line', () => {
    expect(planTitle('Intro\n\n## Steps\n- a')).toBe('Steps')
    expect(planTitle('\n\nFix the build\nmore')).toBe('Fix the build')
    expect(planTitle('   ')).toBe('Claude plan')
    expect(planTitle(`# ${'x'.repeat(300)}`)).toHaveLength(200)
  })
})
