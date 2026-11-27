import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../shared/agent-chat.js'
import { ChatReplyEmbeds } from './chat-reply-embeds.js'
import { MAX_ARTIFACT_DIRS, RedlineArtifactRegistry } from './redline-artifacts.js'

let root: string
let home: string
let cwd: string
let artifacts: RedlineArtifactRegistry
let embeds: ChatReplyEmbeds

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'reply-embeds-')))
  home = join(root, 'home')
  cwd = join(root, 'work')
  await mkdir(home)
  await mkdir(cwd)
  artifacts = new RedlineArtifactRegistry()
  embeds = new ChatReplyEmbeds({ artifacts, home, tempRoots: [] })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const reply = (text: string, id = 'a1'): ChatItem => ({ id, turnId: 't', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'assistant_message', text })
async function attached(text: string, at = cwd) {
  const [item] = await embeds.attach([reply(text)], at)
  return item.kind === 'assistant_message' ? item.embeds : undefined
}
async function file(path: string, content = '<h1>Mock</h1>') {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  return path
}
const manifest = (frames: unknown[], title = 'Settings board') => JSON.stringify({ title, frames })

describe('ChatReplyEmbeds', () => {
  it('serves an HTML mock-up from its artifact folder in the pane cwd', async () => {
    const page = await file(join(cwd, '.canvas', 'settings', 'My Accounts.html'))
    const result = await attached('Here: ![Accounts](.canvas/settings/My%20Accounts.html)')
    const id = artifacts.register(join(cwd, '.canvas')).id
    expect(result).toEqual([{ src: '.canvas/settings/My%20Accounts.html', kind: 'html', path: page, url: `/redline/artifacts/${id}/settings/My%20Accounts.html` }])
    expect(artifacts.resolve(id, 'settings/My%20Accounts.html')).toBe(page)
  })

  it('refuses HTML outside an artifact folder, outside the cwd, under daemon state or through a symlink', async () => {
    await file(join(cwd, 'loose.html'))
    await file(join(home, '.redline', 'elsewhere.html'))
    await file(join(home, '.commando', '.redline', 'state.html'))
    await symlink(join(home, '.redline'), join(cwd, '.pr'))
    const text = [
      `![a](${cwd}/loose.html)`, `![b](${home}/.redline/elsewhere.html)`, `![c](${cwd}/.pr/elsewhere.html)`,
    ].join('\n\n')
    expect((await attached(text))?.map((embed) => [embed.src.split('/').at(-1), embed.error])).toEqual([
      ['loose.html', 'not-embeddable'], ['elsewhere.html', 'not-embeddable'], ['elsewhere.html', 'not-embeddable'],
    ])
    // Even with home as the cwd, daemon state is never served.
    expect(await attached(`![d](~/.commando/.redline/state.html)`, home)).toEqual([
      { src: '~/.commando/.redline/state.html', kind: 'html', path: join(home, '.commando', '.redline', 'state.html'), error: 'not-embeddable' },
    ])
    expect(await attached(`![e](~/.redline/elsewhere.html)`, home)).toMatchObject([{ kind: 'html', url: expect.stringMatching(/^\/redline\/artifacts\/[0-9a-f]{16}\/elsewhere\.html$/) }])
  })

  it('names a missing page and leaves images, web addresses and code alone', async () => {
    await file(join(cwd, 'shot.png'), 'png')
    const text = '![gone](.redline/gone.html)\n\n![shot](shot.png) ![web](https://example.com/a.html)\n\n```\n![x](.redline/code.html)\n```'
    expect(await attached(text)).toEqual([{ src: '.redline/gone.html', kind: 'html', path: join(cwd, '.redline', 'gone.html'), error: 'missing' }])
    expect(await attached('No embeds ![shot](shot.png)')).toBeUndefined()
  })

  it('lists a canvas board’s frames from its folder or its manifest', async () => {
    const canvas = join(cwd, '.canvas', 'settings')
    await file(join(canvas, 'canvas.json'), manifest([
      { id: 'list', title: 'Accounts · list', src: 'Accounts.html', x: 0, y: 0 },
      { id: 'teal', title: 'Accounts · teal', src: 'screens/Teal page.html', x: 500, y: 0, w: 1280, h: 800 },
      { id: 'broken', title: 'No src', x: 0, y: 0 },
    ]))
    await file(join(canvas, 'board.json'), manifest([{ id: 'one', title: 'One', src: 'One.html', x: 0, y: 0 }], 'Second board'))
    const [board, second] = (await attached('![Board](.canvas/settings) and ![Other](.canvas/settings/board.json)'))!
    const id = artifacts.register(canvas).id
    expect(board).toEqual({
      src: '.canvas/settings', kind: 'canvas', path: canvas, url: `/redline/artifacts/${id}/`, title: 'Settings board', frames: [
        { id: 'list', title: 'Accounts · list', url: `/redline/artifacts/${id}/Accounts.html`, w: 390, h: 844 },
        { id: 'teal', title: 'Accounts · teal', url: `/redline/artifacts/${id}/screens/Teal%20page.html`, w: 1280, h: 800 },
      ],
    })
    expect(second).toMatchObject({ kind: 'canvas', title: 'Second board', frames: [{ id: 'one', url: `/redline/artifacts/${id}/One.html` }] })
  })

  it('refuses a folder that is not a canvas, a broken manifest, and a canvas outside the rules', async () => {
    await mkdir(join(cwd, '.canvas', 'empty'), { recursive: true })
    await file(join(cwd, '.canvas', 'broken', 'canvas.json'), '{ not json')
    await file(join(cwd, 'boards', 'canvas.json'), manifest([]))
    const result = await attached('![a](.canvas/empty) ![b](.canvas/broken) ![c](boards) ![d](.canvas/gone/canvas.json)')
    expect(result?.map((embed) => [embed.src, embed.kind, embed.error])).toEqual([
      ['.canvas/empty', 'canvas', 'not-embeddable'], ['.canvas/broken', 'canvas', 'invalid'], ['boards', 'canvas', 'not-embeddable'],
      ['.canvas/gone/canvas.json', 'canvas', 'missing'],
    ])
  })

  it('remembers a resolution until the manifest changes or its registration lapses', async () => {
    const canvas = join(cwd, '.canvas', 'settings')
    await file(join(canvas, 'canvas.json'), manifest([{ id: 'a', title: 'A', src: 'A.html', x: 0, y: 0 }]))
    const register = vi.spyOn(artifacts, 'ensure')
    const first = await attached('![Board](.canvas/settings)')
    await attached('![Board](.canvas/settings) and more text')
    expect(register).toHaveBeenCalledTimes(1)
    await writeFile(join(canvas, 'canvas.json'), manifest([{ id: 'a', title: 'A', src: 'A.html', x: 0, y: 0 }, { id: 'b', title: 'B', src: 'B.html', x: 0, y: 0 }]))
    expect((await attached('![Board](.canvas/settings)'))?.[0].frames).toHaveLength(2)
    expect(register).toHaveBeenCalledTimes(2)
    artifacts.unregister(first![0].url!.split('/')[3])
    const again = await attached('![Board](.canvas/settings)')
    expect(register).toHaveBeenCalledTimes(3)
    expect(artifacts.directory(again![0].url!.split('/')[3])).toBe(canvas)
  })

  it('keeps every published board serving past the registry capacity, with the same URLs on re-attach', async () => {
    const changes = vi.fn()
    embeds = new ChatReplyEmbeds({ artifacts, home, tempRoots: [], onRetainedChange: changes })
    const count = MAX_ARTIFACT_DIRS + 6
    const replies: ChatItem[] = []
    for (let index = 0; index < count; index += 10) {
      const names = Array.from({ length: Math.min(10, count - index) }, (_, offset) => `b${index + offset}`)
      for (const name of names) await file(join(cwd, '.canvas', name, 'canvas.json'), manifest([{ id: 'a', title: 'A', src: 'A.html', x: 0, y: 0 }]))
      replies.push(reply(names.map((name) => `![${name}](.canvas/${name})`).join(' '), `a${index}`))
    }
    const urls = async () => (await embeds.attach(replies, cwd)).flatMap((item) => item.kind === 'assistant_message' ? item.embeds ?? [] : []).map((embed) => embed.url!)
    const first = await urls()
    expect(first).toHaveLength(count)
    // Other registrations arrive meanwhile (tiles, other chats); none of the published ones is evicted.
    for (let index = 0; index < MAX_ARTIFACT_DIRS; index++) artifacts.register(await realpath(await mkdtemp(join(root, 'other-'))))
    for (const url of first) expect(artifacts.directory(url.split('/')[3])).toMatch(/\/\.canvas\/b\d+$/)
    expect(await urls()).toEqual(first)
    expect(new Set(embeds.retainedIds())).toEqual(new Set(first.map((url) => url.split('/')[3])))
    expect(changes).toHaveBeenCalledTimes(count)
  })

  it('shows a chip rather than a URL the registry no longer serves', async () => {
    await file(join(cwd, '.redline', 'page.html'))
    embeds = new ChatReplyEmbeds({ artifacts: { ensure: () => ({ id: '0123456789abcdef' }), directory: () => null }, home, tempRoots: [] })
    expect(await attached('![p](.redline/page.html)')).toEqual([{ src: '.redline/page.html', kind: 'html', path: join(cwd, '.redline', 'page.html'), error: 'not-embeddable' }])
  })

  it('attaches at most ten embeds a reply, and drops stale ones when the text changes', async () => {
    const text = Array.from({ length: 12 }, (_, index) => `![p${index}](.redline/p${index}.html)`).join(' ')
    expect(await attached(text)).toHaveLength(10)
    const [item] = await embeds.attach([{ ...reply('No more'), embeds: [{ src: 'x.html', kind: 'html', error: 'missing' }] } as ChatItem], cwd)
    expect(item).not.toHaveProperty('embeds')
  })
})
