import { mkdir, mkdtemp, opendir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../shared/agent-chat.js'
import { ChatReplyResources, markdownResourceReferences } from './chat-reply-resources.js'

const reply = (text: string): Extract<ChatItem, { kind: 'assistant_message' }> => ({ id: 'a', turnId: 't', kind: 'assistant_message', status: 'completed', createdAt: 1, updatedAt: 1, text })
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reply-resources-'))
  await mkdir(join(dir, 'folder'))
  await writeFile(join(dir, 'README.md'), 'hello')
  await writeFile(join(dir, 'my file.txt'), 'hello world')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
async function resources(text: string) {
  const [item] = await new ChatReplyResources(dir).attach([reply(text)], dir)
  return item.kind === 'assistant_message' ? item.resources : undefined
}

describe('reply resources', () => {
  it('resolves absolute, home, file URLs and relative explicit links including references', async () => {
    const result = await resources(`[a](${dir}/README.md) [b](~/README.md) [c](${pathToFileURL(join(dir, 'my file.txt'))}) [d](./README.md:7:2) [folder][f]\n\n[f]: ./folder`)
    expect(result).toMatchObject([
      { ref: `${dir}/README.md`, path: join(dir, 'README.md'), kind: 'file', size: 5 },
      { ref: '~/README.md', path: join(dir, 'README.md'), kind: 'file' },
      { ref: pathToFileURL(join(dir, 'my file.txt')).href, path: join(dir, 'my file.txt'), kind: 'file' },
      { ref: './README.md:7:2', path: join(dir, 'README.md'), line: 7 },
      { ref: './folder', kind: 'folder', entries: 0 },
    ])
  })
  it('recognizes single-backtick filenames, relative paths and line suffixes', async () => {
    expect(await resources('`README.md:23:4` `./folder` `../' + dir.split('/').at(-1) + '/README.md`')).toMatchObject([
      { ref: 'README.md:23:4', path: join(dir, 'README.md'), line: 23 },
      { ref: './folder', kind: 'folder' },
      { path: join(dir, 'README.md'), kind: 'file' },
    ])
    await writeFile(join(dir, 'folder', 'child.txt'), 'a')
    expect(await resources('`folder/child.txt`')).toMatchObject([{ kind: 'file', path: join(dir, 'folder/child.txt') }])
  })
  it('ignores fences, bare paths, multiple backticks, schemes, multiline and long code', () => {
    const text = '```md\n[x](./README.md)\n`README.md`\n```\n\n./README.md ``README.md`` `https://example.com/a` `data:text/a` `README.md\n` `' + 'a'.repeat(1025) + '.md` [web](https://example.com/a) [relative](README.md) ![image](./README.md)'
    expect(markdownResourceReferences(text)).toEqual([])
  })
  it('drops missing code, retains missing links, and deduplicates', async () => {
    expect(await resources('`missing.txt` [missing](./missing.txt) [again](./missing.txt)')).toEqual([
      { ref: './missing.txt', path: join(dir, 'missing.txt'), missing: true },
    ])
  })
  it('decodes Markdown paths with spaces and refreshes metadata after changes', async () => {
    const resolver = new ChatReplyResources(dir)
    const text = '[file](./my%20file.txt) `./folder`'
    const [first] = await resolver.attach([reply(text)], dir)
    expect(first).toMatchObject({ resources: [{ path: join(dir, 'my file.txt'), size: 11 }, { entries: 0 }] })
    await writeFile(join(dir, 'my file.txt'), 'updated content')
    await writeFile(join(dir, 'folder', 'child'), '')
    const [next] = await resolver.attach([reply(text)], dir)
    expect(next).toMatchObject({ resources: [{ size: 15 }, { entries: 1 }] })
  })
  it('caps resources at 50 and leaves non-reply items unchanged', async () => {
    expect((await resources(Array.from({ length: 60 }, (_, i) => `[${i}](./missing-${i})`).join(' ')))?.length).toBe(50)
    const item = { ...reply(''), kind: 'reasoning' as const }
    expect((await new ChatReplyResources().attach([item], dir))[0]).toBe(item)
  })
  it('keeps valid chips when another path is too long, and logs that path once', async () => {
    const log = vi.fn()
    const resolver = new ChatReplyResources(dir, log)
    const item = reply(`[bad](./${'x'.repeat(300)}) \`README.md\``)
    expect((await resolver.attach([item], dir))[0]).toMatchObject({ resources: [{ ref: 'README.md', kind: 'file' }] })
    await resolver.attach([item], dir)
    expect(log).toHaveBeenCalledTimes(1)
  })
  it.each(['EACCES', 'EPERM', 'ENAMETOOLONG', 'ELOOP'])('skips just the path whose stat fails with %s', async (code) => {
    const log = vi.fn()
    const resolver = new ChatReplyResources(dir, log, markdownResourceReferences, {
      stat: async (path) => { if (path.endsWith('/bad')) throw Object.assign(new Error(code), { code }); return stat(path) }, opendir,
    })
    const item = reply('[bad](./bad) `README.md`')
    const [attached] = await resolver.attach([item], dir)
    expect(attached).toMatchObject({ resources: [{ ref: 'README.md', path: join(dir, 'README.md') }] })
    if (attached.kind === 'assistant_message') expect(attached.resources).toHaveLength(1)
    await resolver.attach([item], dir)
    expect(log).toHaveBeenCalledTimes(1)
  })
  it('keeps a folder without entries when directory enumeration fails', async () => {
    const log = vi.fn()
    const resolver = new ChatReplyResources(dir, log, markdownResourceReferences, {
      stat, opendir: vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' })),
    })
    const [attached] = await resolver.attach([reply('`./folder` `README.md`')], dir)
    expect(attached).toMatchObject({ resources: [{ kind: 'folder' }, { kind: 'file' }] })
    if (attached.kind === 'assistant_message') expect(attached.resources![0]).not.toHaveProperty('entries')
    expect(log).toHaveBeenCalledTimes(1)
  })
  it('strips link fragments and queries, preserves refs, and reads GitHub-style line anchors', async () => {
    const result = await resources('[a](./README.md#L12) [b](./README.md#L12-L20) [c](./README.md?raw=1#L14) [d](./README.md#section) [e][file]\n\n[file]: ./README.md:9?raw=1')
    expect(result).toMatchObject([
      { ref: './README.md#L12', path: join(dir, 'README.md'), line: 12 },
      { ref: './README.md#L12-L20', path: join(dir, 'README.md'), line: 12 },
      { ref: './README.md?raw=1#L14', path: join(dir, 'README.md'), line: 14 },
      { ref: './README.md#section', path: join(dir, 'README.md') },
      { ref: './README.md:9?raw=1', path: join(dir, 'README.md'), line: 9 },
    ])
    expect(result![3]).not.toHaveProperty('line')
    expect(await resources('[missing](./gone.md#L12)')).toEqual([{ ref: './gone.md#L12', path: join(dir, 'gone.md'), missing: true }])
    await writeFile(join(dir, 'literal#name.txt'), 'literal')
    expect(await resources('`literal#name.txt`')).toMatchObject([{ path: join(dir, 'literal#name.txt') }])
  })
  it('does not re-parse an unchanged item, but resolves it against the current cwd', async () => {
    const parse = vi.fn(markdownResourceReferences)
    const resolver = new ChatReplyResources(dir, undefined, parse)
    const item = reply('`README.md`')
    await resolver.attach([item], dir)
    await resolver.attach([{ ...item, updatedAt: 2 }], dir)
    expect(parse).toHaveBeenCalledTimes(1)
    expect((await resolver.attach([item], join(dir, 'folder')))[0]).not.toHaveProperty('resources')
    expect(parse).toHaveBeenCalledTimes(1)
    await resolver.attach([{ ...item, text: '`./folder`' }], dir)
    expect(parse).toHaveBeenCalledTimes(2)
  })
  it('bounds the parsed-reference LRU and retains recently read replies', async () => {
    const parse = vi.fn(() => [])
    const resolver = new ChatReplyResources(dir, undefined, parse)
    const batch = Array.from({ length: 2000 }, (_, i) => ({ ...reply('`text`'), id: String(i) }))
    await resolver.attach(batch, dir)
    await resolver.attach([batch[0]], dir) // Refresh the oldest entry.
    await resolver.attach([{ ...reply('`text`'), id: 'new' }], dir)
    await resolver.attach([batch[0]], dir)
    expect(parse).toHaveBeenCalledTimes(2001)
    await resolver.attach([batch[1]], dir)
    expect(parse).toHaveBeenCalledTimes(2002)
  })
  it('deduplicates in-flight stat and opendir across replies while preserving order', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const read = vi.fn(async (path: string) => { await gate; return stat(path) })
    const open = vi.fn((path: string) => opendir(path))
    const resolver = new ChatReplyResources(dir, undefined, markdownResourceReferences, { stat: read, opendir: open })
    const batch = Array.from({ length: 4 }, (_, i) => ({ ...reply('`./folder`'), id: String(i) }))
    const pending = resolver.attach(batch, dir)
    expect(read).toHaveBeenCalledTimes(1)
    release()
    const result = await pending
    expect(open).toHaveBeenCalledTimes(1)
    expect(result.map((item) => item.id)).toEqual(batch.map((item) => item.id))
    expect(result).toEqual(batch.map((item) => ({ ...item, resources: [expect.objectContaining({ ref: './folder', kind: 'folder', entries: 0 })] })))
  })
  it('limits concurrent file operations to four', async () => {
    let active = 0, maximum = 0
    const stats = await stat(join(dir, 'README.md'))
    const resolver = new ChatReplyResources(dir, undefined, markdownResourceReferences, {
      stat: async () => {
        maximum = Math.max(maximum, ++active)
        await new Promise<void>((resolve) => setImmediate(resolve))
        active--
        return stats
      }, opendir,
    })
    const batch = Array.from({ length: 60 }, (_, i) => ({ ...reply(`\`./${i}.md\``), id: String(i) }))
    const result = await resolver.attach(batch, dir)
    expect(maximum).toBe(4)
    expect(result.map((item) => item.id)).toEqual(batch.map((item) => item.id))
  })
  it('yields after 25 items even when references need no filesystem work', async () => {
    const parse = vi.fn(() => [])
    const resolver = new ChatReplyResources(dir, undefined, parse)
    let parsedAtYield = 0
    const tick = new Promise<void>((resolve) => setImmediate(() => { parsedAtYield = parse.mock.calls.length; resolve() }))
    await resolver.attach(Array.from({ length: 60 }, (_, i) => ({ ...reply('`text`'), id: String(i) })), dir)
    await tick
    expect(parsedAtYield).toBe(25)
  })
  it('recognises a slides deck folder, its deck.html and a one-pager beside it, parsed once per mtime', async () => {
    const deck = join(dir, 'talk')
    await mkdir(deck)
    const page = (title: string, slides: string[]) => `<html><head><meta name="deck:title" content="${title}"></head><body><main class="deck">${slides.map((slide, i) => `<section class="slide" id="s${i}"><h1>${slide}</h1></section>`).join('')}</main></body></html>`
    await writeFile(join(deck, 'deck.html'), page('Launch plan', ['Why now', 'Numbers', 'Ask']))
    await writeFile(join(deck, 'onepager.html'), page('One pager', ['Summary']))
    await writeFile(join(deck, 'notes.html'), '<p>Not a deck</p>')
    await writeFile(join(dir, 'loose.html'), page('Loose', ['A']))
    const read = vi.fn(async (path: string, encoding: 'utf8') => (await import('node:fs/promises')).readFile(path, encoding))
    const resolver = new ChatReplyResources(dir, undefined, markdownResourceReferences, { stat, opendir, readFile: read })
    const attach = async (text: string) => {
      const [item] = await resolver.attach([reply(text)], dir)
      return item.kind === 'assistant_message' ? item.resources : undefined
    }
    const expected = { folder: deck, manifest: 'deck.html', title: 'Launch plan', slides: 3, first: 'Why now' }
    expect(await attach('`./talk` `talk/deck.html` `talk/onepager.html` `talk/notes.html` `loose.html` `README.md`')).toEqual([
      expect.objectContaining({ ref: './talk', kind: 'folder', deck: expected }),
      expect.objectContaining({ ref: 'talk/deck.html', kind: 'file', deck: expected }),
      expect.objectContaining({ ref: 'talk/onepager.html', deck: { folder: deck, manifest: 'onepager.html', title: 'One pager', slides: 1, first: 'Summary' } }),
      expect.not.objectContaining({ deck: expect.anything() }),
      expect.not.objectContaining({ deck: expect.anything() }),
      expect.not.objectContaining({ deck: expect.anything() }),
    ])
    expect(read).toHaveBeenCalledTimes(3)
    await attach('`./talk`')
    expect(read).toHaveBeenCalledTimes(3)
    await writeFile(join(deck, 'deck.html'), page('Launch plan v2', ['Why now', 'Numbers']))
    await utimes(join(deck, 'deck.html'), new Date(), new Date(Date.now() + 5000))
    expect((await attach('`./talk`'))?.[0]).toMatchObject({ deck: { title: 'Launch plan v2', slides: 2 } })
  })
})
