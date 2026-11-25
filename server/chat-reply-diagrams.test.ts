import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '../shared/agent-chat.js'
import { prDiagramHash } from '../shared/pr-diagram.js'
import { ChatReplyDiagrams, execFileExecutor, locatePrDiagramRenderer, prDiagramFences, prDiagramRendererCandidates, type PrDiagramExecutor } from './chat-reply-diagrams.js'

const reply = (text: string, extra: Partial<ChatItem> = {}): ChatItem => ({ id: 'a1', turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'assistant_message', text, ...extra } as ChatItem)
const fence = (source: string) => `Here it is:\n\n\`\`\`pr-diagram\n${source}\n\`\`\`\n`
const DOC = '{"type":"pipeline","title":"Ship"}'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

describe('prDiagramFences', () => {
  it('finds closed pr-diagram fences in order, each once, and skips other code and a fence still streaming', () => {
    const text = [fence('{"a":1}'), '```json\n{"b":2}\n```', '~~~pr-diagram\n{"c":3}\n~~~', fence('{"a":1}'), '```pr-diagram\n{"open":true}'].join('\n')
    expect(prDiagramFences(text)).toEqual(['{"a":1}', '{"c":3}'])
    expect(prDiagramFences('mentions pr-diagram but has no fence')).toEqual([])
    expect(prDiagramFences('```pr-diagram\n```')).toEqual([])
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
  let bin: string
  let saved: Uint8Array[]
  const store = { saveReplyImage: async (bytes: Uint8Array) => { saved.push(bytes); return { id: `${'e'.repeat(64)}.svg` } } }
  const candidates = () => [bin]

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'pr-diagram-test-'))
    renders = join(temp, 'renders')
    bin = join(temp, 'pr-diagram.mjs')
    await mkdir(renders)
    await writeFile(bin, '')
    saved = []
  })
  afterEach(async () => { await rm(temp, { recursive: true, force: true }) })

  /** A renderer stand-in that writes `<name>.svg` next to the document, like `render --out`. */
  function stub(behaviour: (document: string) => Promise<void> | void = () => {}) {
    const calls: { file: string; args: readonly string[]; mode?: number }[] = []
    const execute: PrDiagramExecutor = async (file, args, options) => {
      const [, command, input, flag, out] = args
      expect([command, flag, out]).toEqual(['render', '--out', options.cwd])
      calls.push({ file, args, mode: (await stat(out)).mode & 0o777 })
      await behaviour(input)
      await writeFile(input.replace(/\.json$/, '.svg'), SVG)
      return { stdout: '', stderr: '' }
    }
    return { calls, execute }
  }
  const diagrams = (options: ConstructorParameters<typeof ChatReplyDiagrams>[1] = {}) =>
    new ChatReplyDiagrams(store, { candidates, tempRoot: renders, ...options })

  it('renders each fence with execFile-style arguments in a private folder, stores the SVG and cleans up', async () => {
    const { calls, execute } = stub()
    const [item] = await diagrams({ execute }).attach([reply(fence(DOC))])
    expect(item).toMatchObject({ diagrams: [{ hash: prDiagramHash(DOC), id: `${'e'.repeat(64)}.svg` }] })
    expect(calls).toEqual([{ file: process.execPath, args: [bin, 'render', expect.stringMatching(/\/[0-9a-f]{24}\.json$/), '--out', expect.any(String)], mode: 0o700 }])
    expect(Buffer.from(saved[0]).toString()).toBe(SVG)
    expect(await readdir(renders)).toEqual([])
  })

  it('renders a document once per hash, across updates and concurrent requests', async () => {
    const { calls, execute } = stub()
    const renderer = diagrams({ execute })
    await Promise.all([renderer.attach([reply(fence(DOC))]), renderer.attach([reply(fence(DOC), { id: 'a2' })])])
    await renderer.attach([reply(`${fence(DOC)}\nmore text`)])
    expect(calls).toHaveLength(1)
  })

  it("doesn't hold up a streaming reply, and attaches the result to a later update", async () => {
    let finish!: () => void
    const { calls, execute } = stub(() => new Promise<void>((resolve) => { finish = resolve }))
    const renderer = diagrams({ execute })
    const [streaming] = await renderer.attach([reply(fence(DOC), { status: 'running' })])
    expect(streaming).not.toHaveProperty('diagrams')
    await expect.poll(() => calls.length).toBe(1)
    const done = renderer.attach([reply(fence(DOC))])
    finish()
    expect((await done)[0]).toMatchObject({ diagrams: [{ id: expect.any(String) }] })
    expect(calls).toHaveLength(1)
  })

  it('reports invalid JSON, a non-object and an oversized document without running the renderer', async () => {
    const { calls, execute } = stub()
    const [item] = await diagrams({ execute }).attach([reply([fence('{"type":'), fence('[1]'), fence(`{"x":"${'y'.repeat(70_000)}"}`)].join('\n'))])
    expect(item).toMatchObject({ diagrams: [
      { error: 'invalid', message: expect.stringMatching(/^Not valid JSON/) },
      { error: 'invalid', message: expect.stringContaining('one JSON object') },
      { error: 'too_large' },
    ] })
    expect(calls).toHaveLength(0)
  })

  it("shows the renderer's validation errors without the temporary file name", async () => {
    const execute: PrDiagramExecutor = async (_file, args) => {
      const input = args[2]
      throw Object.assign(new Error('exit 1'), { code: 1, stderr: `${input}: error: title: is required\n${input}: error: stages: is required\n1 of 1 document failed\n` })
    }
    const [item] = await diagrams({ execute }).attach([reply(fence('{"type":"pipeline"}'))])
    expect(item).toMatchObject({ diagrams: [{ error: 'invalid', message: 'title: is required\nstages: is required' }] })
    expect(await readdir(renders)).toEqual([])
  })

  it('reports a timeout, and tries that document again once the retry window passes', async () => {
    let now = 0
    let calls = 0
    const execute: PrDiagramExecutor = async () => { calls++; throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }) }
    const renderer = diagrams({ execute, now: () => now })
    expect((await renderer.attach([reply(fence(DOC))]))[0]).toMatchObject({ diagrams: [{ error: 'timeout' }] })
    await renderer.attach([reply(fence(DOC))])
    expect(calls).toBe(1)
    now += 61_000
    await renderer.attach([reply(fence(DOC))])
    expect(calls).toBe(2)
  })

  it('says when the renderer is missing, and finds it once it is installed', async () => {
    let now = 0
    const later = join(temp, 'later.mjs')
    const { calls, execute } = stub()
    const renderer = diagrams({ candidates: () => [later], execute, now: () => now })
    expect((await renderer.attach([reply(fence(DOC))]))[0]).toMatchObject({ diagrams: [{ error: 'renderer_missing' }] })
    await writeFile(later, '')
    now += 31_000
    expect((await renderer.attach([reply(fence(DOC))]))[0]).toMatchObject({ diagrams: [{ id: expect.any(String) }] })
    expect(calls).toHaveLength(1)
  })

  it('drops stale diagrams from a reply that no longer has a fence, and leaves other items alone', async () => {
    const user = { id: 'u1', turnId: 't1', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'user_message', text: fence(DOC) } as ChatItem
    const stale = reply('plain pr-diagram mention', { diagrams: [{ hash: 'a'.repeat(64), id: `${'b'.repeat(64)}.svg` }] } as Partial<ChatItem>)
    const [first, second] = await diagrams({ execute: stub().execute }).attach([user, stale])
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
    const [item] = await renderer.attach([reply(`${fence(DOC)}\n${fence('{"type":"pipeline"}')}`)])
    expect(item).toMatchObject({ diagrams: [{ id: expect.any(String) }, { error: 'invalid', message: 'title: is required' }] })
    expect(await readdir(renders)).toEqual([])
  })
})
