import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '../shared/agent-chat.js'
import { prDiagramHash } from '../shared/pr-diagram.js'
import { ChatReplyDiagrams, execFileExecutor, locatePrDiagramRenderer, prDiagramFences, prDiagramRendererCandidates, preparePrDiagram, type PrDiagramExecutor } from './chat-reply-diagrams.js'

const reply = (text: string, extra: Partial<ChatItem> = {}): ChatItem => ({ id: 'a1', turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'assistant_message', text, ...extra } as ChatItem)
const fence = (source: string) => `Here it is:\n\n\`\`\`pr-diagram\n${source}\n\`\`\`\n`
const DOC = '{"type":"pipeline","title":"Ship"}'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
const SVG_ID = `${'e'.repeat(64)}.svg`

describe('prDiagramFences', () => {
  it('finds closed pr-diagram fences in order, each once, and skips other code and a fence still streaming', () => {
    const text = [fence('{"a":1}'), '```json\n{"b":2}\n```', '~~~pr-diagram\n{"c":3}\n~~~', fence('{"a":1}'), '```pr-diagram\n{"open":true}'].join('\n')
    expect(prDiagramFences(text)).toEqual(['{"a":1}', '{"c":3}'])
    expect(prDiagramFences('mentions pr-diagram but has no fence')).toEqual([])
    expect(prDiagramFences('```pr-diagram\n```')).toEqual([])
  })
})

describe('preparePrDiagram', () => {
  it('anchors relative screen-flow screenshots to the chat folder and leaves absolute ones', () => {
    const source = JSON.stringify({ type: 'screen-flow', screens: [{ id: 'a', image: 'shots/a.png' }, { id: 'b', image: '/abs/b.png' }, { id: 'c', image: '~/c.png' }, { id: 'd' }] })
    const prepared = preparePrDiagram(source, '/work', '/home/me')
    expect(prepared).toMatchObject({ hash: prDiagramHash(source), relative: true })
    expect(JSON.parse((prepared as { document: string }).document).screens.map((screen: { image?: string }) => screen.image)).toEqual(['/work/shots/a.png', '/abs/b.png', '/home/me/c.png', undefined])
    expect(preparePrDiagram(DOC, '/work')).toEqual({ hash: prDiagramHash(DOC), relative: false, document: DOC })
  })

  it('reports invalid JSON, a non-object and an oversized document', () => {
    expect(preparePrDiagram('{"type":', '/w')).toMatchObject({ result: { error: 'invalid', message: expect.stringMatching(/^Not valid JSON/) } })
    expect(preparePrDiagram('[1]', '/w')).toMatchObject({ result: { error: 'invalid', message: expect.stringContaining('one JSON object') } })
    expect(preparePrDiagram(`{"x":"${'y'.repeat(70_000)}"}`, '/w')).toMatchObject({ result: { error: 'too_large' } })
  })
})

describe('locatePrDiagramRenderer', () => {
  it('prefers the env override, then ~/.claude, then ~/.claudep', async () => {
    expect(prDiagramRendererCandidates({ COMMANDO_PR_DIAGRAM_BIN: '/opt/pr.mjs' }, '/home/me')).toEqual([
      '/opt/pr.mjs', '/home/me/.claude/skills/pr-diagram/bin/pr-diagram.mjs', '/home/me/.claudep/skills/pr-diagram/bin/pr-diagram.mjs',
    ])
    expect(prDiagramRendererCandidates({}, '/home/me')).toHaveLength(2)
    const dir = await mkdtemp(join(tmpdir(), 'pr-diagram-locate-'))
    try {
      await writeFile(join(dir, 'b.mjs'), '')
      expect(await locatePrDiagramRenderer([join(dir, 'missing.mjs'), dir, join(dir, 'b.mjs')])).toBe(join(dir, 'b.mjs'))
      expect(await locatePrDiagramRenderer([join(dir, 'missing.mjs')])).toBeNull()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('ChatReplyDiagrams', () => {
  let temp: string
  let renders: string
  let images: string
  let bin: string
  let saved: Uint8Array[]
  let saveResult: { id: string } | { error: 'too_large' }

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'pr-diagram-test-'))
    renders = join(temp, 'renders')
    images = join(temp, 'images')
    bin = join(temp, 'pr-diagram.mjs')
    await mkdir(renders)
    await mkdir(images)
    await writeFile(bin, '')
    saved = []
    saveResult = { id: SVG_ID }
  })
  afterEach(async () => { await rm(temp, { recursive: true, force: true }) })

  const store = () => ({
    dir: images,
    servedPath: (id: string) => join(images, id),
    saveReplyImage: async (bytes: Uint8Array) => {
      saved.push(bytes)
      if ('id' in saveResult) await writeFile(join(images, saveResult.id), bytes)
      return saveResult
    },
  })

  /** A renderer stand-in that writes `<name>.svg` next to the document, like `render --out`. */
  function stub(behaviour: (document: string) => Promise<void> | void = () => {}) {
    const calls: { file: string; args: readonly string[]; mode?: number; document: string }[] = []
    const execute: PrDiagramExecutor = async (file, args, options) => {
      const [, command, input, flag, out] = args
      expect([command, flag, out]).toEqual(['render', '--out', options.cwd])
      calls.push({ file, args, mode: (await stat(out)).mode & 0o777, document: await readFile(input, 'utf8') })
      await behaviour(input)
      await writeFile(input.replace(/\.json$/, '.svg'), SVG)
      return { stdout: '', stderr: '' }
    }
    return { calls, execute }
  }
  const diagrams = (options: ConstructorParameters<typeof ChatReplyDiagrams>[1] = {}) =>
    new ChatReplyDiagrams(store(), { candidates: () => [bin], tempRoot: renders, ...options })

  /** Attaches, waits for the background renders it started, and attaches again. */
  async function settled(renderer: ChatReplyDiagrams, items: ChatItem[], cwd = '/work') {
    let rendered!: () => void
    const done = new Promise<void>((resolve) => { rendered = resolve })
    const first = await renderer.attach(items, cwd, () => rendered())
    await done
    return { first, second: await renderer.attach(items, cwd) }
  }

  it('returns at once without uncached diagrams, renders in the background, and names the reply when done', async () => {
    let finish!: () => void
    const { calls, execute } = stub(() => new Promise<void>((resolve) => { finish = resolve }))
    const renderer = diagrams({ execute })
    const rendered: string[][] = []
    const [first] = await renderer.attach([reply(fence(DOC))], '/work', (ids) => rendered.push(ids))
    expect(first).not.toHaveProperty('diagrams')
    await expect.poll(() => calls.length).toBe(1)
    expect(rendered).toEqual([])
    finish()
    await expect.poll(() => rendered).toEqual([['a1']])
    const [second] = await renderer.attach([reply(fence(DOC))], '/work')
    expect(second).toMatchObject({ diagrams: [{ hash: prDiagramHash(DOC), id: SVG_ID }] })
    expect(calls).toEqual([{ file: process.execPath, args: [bin, 'render', expect.stringMatching(/\/[0-9a-f]{24}\.json$/), '--out', expect.any(String)], mode: 0o700, document: DOC }])
    expect(Buffer.from(saved[0]).toString()).toBe(SVG)
    expect(await readdir(renders)).toEqual([])
  })

  it('renders a document once per hash, across updates and concurrent requests', async () => {
    const { calls, execute } = stub()
    const renderer = diagrams({ execute })
    await Promise.all([renderer.attach([reply(fence(DOC))], '/w'), renderer.attach([reply(fence(DOC), { id: 'a2' })], '/w')])
    await expect.poll(() => calls.length).toBe(1)
    await expect.poll(async () => (await renderer.attach([reply(`${fence(DOC)}\nmore text`)], '/w'))[0]).toMatchObject({ diagrams: [{ id: SVG_ID }] })
    expect(calls).toHaveLength(1)
  })

  it('keeps lasting results across a restart, without running the renderer again', async () => {
    const { calls, execute } = stub()
    const first = diagrams({ execute })
    await settled(first, [reply(`${fence(DOC)}\n${fence('[1]')}`)])
    await first.flush()
    const restarted = diagrams({ execute })
    const [item] = await restarted.attach([reply(fence(DOC))], '/work')
    expect(item).toMatchObject({ diagrams: [{ id: SVG_ID }] })
    expect(calls).toHaveLength(1)
  })

  it('renders again when an indexed SVG has been pruned', async () => {
    const { calls, execute } = stub()
    const first = diagrams({ execute })
    await settled(first, [reply(fence(DOC))])
    await first.flush()
    await rm(join(images, SVG_ID))
    const restarted = diagrams({ execute })
    const [item] = await restarted.attach([reply(fence(DOC))], '/work', () => {})
    expect(item).not.toHaveProperty('diagrams')
    await expect.poll(() => calls.length).toBe(2)
  })

  it('keys a document with relative screenshots by the chat folder', async () => {
    const { calls, execute } = stub()
    const renderer = diagrams({ execute })
    const source = JSON.stringify({ type: 'screen-flow', title: 'Flow', screens: [{ id: 'a', image: 'a.png' }] })
    await settled(renderer, [reply(fence(source))], '/one')
    await settled(renderer, [reply(fence(source))], '/two')
    expect(calls.map((call) => JSON.parse(call.document).screens[0].image)).toEqual(['/one/a.png', '/two/a.png'])
    await settled(renderer, [reply(fence(DOC))], '/one')
    expect((await renderer.attach([reply(fence(DOC))], '/two'))[0]).toMatchObject({ diagrams: [{ id: SVG_ID }] })
    expect(calls).toHaveLength(3)
  })

  it('reports precheck errors at once, without running the renderer', async () => {
    const { calls, execute } = stub()
    const [item] = await diagrams({ execute }).attach([reply([fence('{"type":'), fence('[1]')].join('\n'))], '/w')
    expect(item).toMatchObject({ diagrams: [{ error: 'invalid' }, { error: 'invalid' }] })
    expect(calls).toHaveLength(0)
  })

  it("shows the renderer's validation errors without the temporary file name, and keeps them", async () => {
    let calls = 0
    const execute: PrDiagramExecutor = async (_file, args) => {
      calls++
      const input = args[2]
      throw Object.assign(new Error('exit 1'), { code: 1, stderr: `${input}: error: title: is required\n${input}: error: stages: is required\n1 of 1 document failed\n` })
    }
    const renderer = diagrams({ execute })
    const { second } = await settled(renderer, [reply(fence('{"type":"pipeline"}'))])
    expect(second[0]).toMatchObject({ diagrams: [{ error: 'invalid', message: 'title: is required\nstages: is required' }] })
    await renderer.attach([reply(fence('{"type":"pipeline"}'))], '/work')
    expect(calls).toBe(1)
    expect(await readdir(renders)).toEqual([])
  })

  it('treats a crash that is not a validation error as a failure, tried again after a while', async () => {
    let now = 0
    let calls = 0
    const execute: PrDiagramExecutor = async () => { calls++; throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'TypeError: boom\n' }) }
    const renderer = diagrams({ execute, now: () => now })
    const { second } = await settled(renderer, [reply(fence(DOC))])
    expect(second[0]).toMatchObject({ diagrams: [{ error: 'failed', message: 'TypeError: boom' }] })
    now += 61_000
    await settled(renderer, [reply(fence(DOC))])
    expect(calls).toBe(2)
  })

  it('reports a timeout, and tries that document again once the retry window passes', async () => {
    let now = 0
    let calls = 0
    const execute: PrDiagramExecutor = async () => { calls++; throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }) }
    const renderer = diagrams({ execute, now: () => now })
    const { second } = await settled(renderer, [reply(fence(DOC))])
    expect(second[0]).toMatchObject({ diagrams: [{ error: 'timeout' }] })
    expect(calls).toBe(1)
    now += 61_000
    await settled(renderer, [reply(fence(DOC))])
    expect(calls).toBe(2)
  })

  it('reports an oversized SVG, from its size or from the store, and keeps that', async () => {
    const big = stub(async (input) => { await writeFile(input.replace(/\.json$/, '.svg'), 'x'.repeat(5 * 1024 * 1024 + 1)) })
    const huge: PrDiagramExecutor = async (file, args, options) => {
      await big.execute(file, args, options)
      await writeFile(args[2].replace(/\.json$/, '.svg'), `<svg>${'x'.repeat(5 * 1024 * 1024)}</svg>`)
      return { stdout: '', stderr: '' }
    }
    const renderer = diagrams({ execute: huge })
    const { second } = await settled(renderer, [reply(fence(DOC))])
    expect(second[0]).toMatchObject({ diagrams: [{ error: 'too_large', message: 'The diagram is larger than 5 MB.' }] })
    expect(saved).toHaveLength(0)
    saveResult = { error: 'too_large' }
    const { second: fromStore } = await settled(diagrams({ execute: stub().execute }), [reply(fence(DOC), { id: 'b' })])
    expect(fromStore[0]).toMatchObject({ diagrams: [{ error: 'too_large', message: 'The diagram is larger than 5 MB.' }] })
  })

  it('says when the renderer is missing, and finds it once it is installed', async () => {
    let now = 0
    const later = join(temp, 'later.mjs')
    const { calls, execute } = stub()
    const renderer = diagrams({ candidates: () => [later], execute, now: () => now })
    expect((await renderer.attach([reply(fence(DOC))], '/w', () => {}))[0]).toMatchObject({ diagrams: [{ error: 'renderer_missing' }] })
    expect(calls).toHaveLength(0)
    await writeFile(later, '')
    now += 31_000
    await settled(renderer, [reply(fence(DOC))])
    expect(calls).toHaveLength(1)
  })

  it('drops stale diagrams from a reply that no longer has a fence, and leaves other items alone', async () => {
    const user = { id: 'u1', turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'user_message', text: fence(DOC) } as ChatItem
    const stale = reply('plain pr-diagram mention', { diagrams: [{ hash: 'a'.repeat(64), id: `${'b'.repeat(64)}.svg` }] } as Partial<ChatItem>)
    const [first, second] = await diagrams({ execute: stub().execute }).attach([user, stale], '/w')
    expect(first).toBe(user)
    expect(second).not.toHaveProperty('diagrams')
  })

  it('runs a real renderer script through execFile', async () => {
    await writeFile(bin, [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "import { basename, join } from 'node:path'",
      'const [, , command, file, , out] = process.argv',
      "const document = JSON.parse(readFileSync(file, 'utf8'))",
      "if (!document.title) { console.error(`${file}: error: title: is required`); process.exit(1) }",
      `writeFileSync(join(out, basename(file, '.json') + '.svg'), ${JSON.stringify(SVG)})`,
    ].join('\n'))
    const renderer = diagrams({ execute: execFileExecutor })
    const items = [reply(`${fence(DOC)}\n${fence('{"type":"pipeline"}')}`)]
    let pending = 2
    let done!: () => void
    const finished = new Promise<void>((resolve) => { done = resolve })
    await renderer.attach(items, '/w', () => { if (--pending === 0) done() })
    await finished
    const [item] = await renderer.attach(items, '/w')
    expect(item).toMatchObject({ diagrams: [{ id: SVG_ID }, { error: 'invalid', message: 'title: is required' }] })
    expect(await readdir(renders)).toEqual([])
  })
})
