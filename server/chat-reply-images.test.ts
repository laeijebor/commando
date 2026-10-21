import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../shared/agent-chat.js'
import { ChatImageStore } from './chat-images.js'
import { ChatReplyImages, localImagePath, markdownImageSources } from './chat-reply-images.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>')

const reply = (text: string, extra: Partial<ChatItem> = {}): ChatItem => ({ id: 'a1', turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'assistant_message', text, ...extra } as ChatItem)

describe('markdownImageSources', () => {
  it('finds image addresses as the renderer reads them, once each', () => {
    expect(markdownImageSources('See ![slide](/tmp/a.png) and ![again](/tmp/a.png) and ![b](<./my shot.png> "title")')).toEqual(['/tmp/a.png', './my shot.png'])
  })

  it('resolves reference images through their definitions', () => {
    expect(markdownImageSources('![diagram][d]\n\n[d]: ~/diagram.svg')).toEqual(['~/diagram.svg'])
  })

  it('skips paths in code, plain text and links', () => {
    expect(markdownImageSources('`![x](/tmp/a.png)`\n\n```\n![y](/tmp/b.png)\n```\n\n~/Downloads/c.png and [link](/tmp/d.png)')).toEqual([])
  })
})

describe('localImagePath', () => {
  it('reads absolute, home, relative and file: addresses', () => {
    expect(localImagePath('/tmp/a.png', '/work', '/home/me')).toBe('/tmp/a.png')
    expect(localImagePath('~/Downloads/a.png', '/work', '/home/me')).toBe('/home/me/Downloads/a.png')
    expect(localImagePath('out/a.png', '/work', '/home/me')).toBe('/work/out/a.png')
    expect(localImagePath('file:///tmp/my%20a.png', '/work', '/home/me')).toBe('/tmp/my a.png')
  })

  it('leaves web addresses and other schemes alone', () => {
    for (const src of ['https://example.com/a.png', 'data:image/png;base64,AAAA', '//cdn/a.png', '#top', 'javascript:alert(1)', '~other/a.png']) {
      expect(localImagePath(src, '/work', '/home/me')).toBeNull()
    }
  })
})

describe('ChatReplyImages', () => {
  let dir: string
  let store: ChatImageStore
  let images: ChatReplyImages

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reply-images-'))
    store = new ChatImageStore(join(dir, 'store'))
    images = new ChatReplyImages(store, join(dir, 'home'))
    await mkdir(join(dir, 'home', 'Downloads'), { recursive: true })
    await writeFile(join(dir, 'home', 'Downloads', 'slide.png'), PNG)
    await writeFile(join(dir, 'diagram.svg'), SVG)
    await writeFile(join(dir, 'notes.txt'), 'not an image')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stores the images a reply shows and says which stored image each address means', async () => {
    const text = `![slide](~/Downloads/slide.png)\n\n![diagram](diagram.svg)\n\n![web](https://example.com/a.png)`
    const [item] = await images.attach([reply(text)], dir)
    expect(item).toMatchObject({ kind: 'assistant_message', text, images: [
      { src: '~/Downloads/slide.png', id: expect.stringMatching(/^[0-9a-f]{64}\.png$/) },
      { src: 'diagram.svg', id: expect.stringMatching(/^[0-9a-f]{64}\.svg$/) },
    ] })
  })

  it('reports missing files and files that are not images', async () => {
    const [item] = await images.attach([reply('![gone](/nowhere/x.png) ![text](notes.txt)')], dir)
    expect(item).toMatchObject({ images: [{ src: '/nowhere/x.png', error: 'missing' }, { src: 'notes.txt', error: 'unsupported' }] })
  })

  it('finds a percent-encoded path', async () => {
    await writeFile(join(dir, 'my shot.png'), PNG)
    const [item] = await images.attach([reply(`![a](${join(dir, 'my%20shot.png')}) ![b](${pathToFileURL(join(dir, 'my shot.png')).href})`)], dir)
    expect(item).toMatchObject({ images: [{ id: expect.any(String) }, { id: expect.any(String) }] })
  })

  it('leaves other items, and replies without local images, as they are', async () => {
    const user = { ...reply('![a](/tmp/a.png)'), kind: 'user_message' } as ChatItem
    const plain = reply('no images here', { images: [{ src: 'stale.png', id: `${'0'.repeat(64)}.png` }] } as Partial<ChatItem>)
    const [first, second] = await images.attach([user, plain], dir)
    expect(first).toBe(user)
    expect(second).not.toHaveProperty('images')
  })

  it('rereads a file only when it changes', async () => {
    const save = vi.spyOn(store, 'saveReplyImage')
    const text = '![slide](~/Downloads/slide.png)'
    await images.attach([reply(text)], dir)
    await images.attach([reply(`${text} still streaming`)], dir)
    expect(save).toHaveBeenCalledTimes(1)
    await writeFile(join(dir, 'home', 'Downloads', 'slide.png'), Buffer.concat([PNG, Buffer.from([0])]))
    await images.attach([reply(text)], dir)
    expect(save).toHaveBeenCalledTimes(2)
  })
})
