import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalogs } from '../shared/tmux-create.js'
import { nameFromReply, namingPrompt, NamingFailure, parseSuggestRequest, SessionNamer, type NameRunner, type SessionNamerOptions } from './session-namer.js'

const catalogs: ModelCatalogs = {
  codex: { models: [{ value: 'gpt-6-luna', displayName: 'GPT-6-Luna' }, { value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }], updatedAt: 1 },
  'claude:/h/.claudep': { models: [{ value: 'haiku', displayName: 'Haiku 5.5' }], updatedAt: 1 },
}
const image = { id: `${'a'.repeat(64)}.png`, name: 'shot.png' }

async function namer(run: NameRunner, options: Partial<SessionNamerOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'session-namer-'))
  const path = join(dir, 'naming.json')
  let now = 1_000_000
  const made = new SessionNamer({
    path, run, catalogs: async () => catalogs, imagePath: (ref) => `/images/${ref.id}`, now: () => now, ...options,
  })
  return { namer: made, path, advance: (ms: number) => { now += ms } }
}

const signal = () => new AbortController().signal

describe('SessionNamer', () => {
  it('names with GPT-6-Luna from the prompt and screenshots, and reports which model named it', async () => {
    const run = vi.fn<NameRunner>(async () => '`Prompt-first session modal.`\n')
    const { namer: subject } = await namer(run)
    expect(await subject.suggest({ prompt: 'Make the modal prompt first', images: [image] }, signal())).toEqual({ name: 'prompt-first-session-modal', by: 'GPT-6-Luna' })
    expect(run).toHaveBeenCalledWith({ provider: 'codex', model: 'gpt-6-luna' }, expect.stringContaining('Task:\nMake the modal prompt first'), [`/images/${image.id}`], expect.any(AbortSignal))
    expect((await subject.describe()).status).toEqual({ state: 'available', lastNamedAt: 1_000_000 })
  })

  it("remembers a model that can't work here, falls back to the chat's model, and tries again after a login change or Try again", async () => {
    let login = 'v1'
    const run = vi.fn<NameRunner>(async (model) => {
      if (model.provider === 'codex') throw new NamingFailure('hard', 'Not logged in')
      return 'fix-flaky-login'
    })
    const { namer: subject, path } = await namer(run, { fingerprint: async () => login })
    const chat = { provider: 'claude' as const, configDir: '/h/.claudep', model: 'haiku' }
    expect(await subject.suggest({ prompt: 'Fix the flaky login test', chat }, signal())).toEqual({ name: 'fix-flaky-login', by: 'Haiku 5.5' })
    expect((await subject.describe()).status).toMatchObject({ state: 'unavailable', reason: 'Not logged in' })
    expect(JSON.parse(await readFile(path, 'utf8')).failures['codex::gpt-6-luna']).toMatchObject({ kind: 'unavailable', fingerprint: 'v1' })

    run.mockClear()
    await subject.suggest({ prompt: 'Again', chat }, signal())
    expect(run.mock.calls.map(([model]) => model.provider)).toEqual(['claude'])

    login = 'v2'
    expect((await subject.describe()).status.state).toBe('available')
    run.mockImplementation(async (model) => { if (model.provider === 'codex') throw new NamingFailure('hard', 'Not logged in'); return 'x' })
    await subject.suggest({ prompt: 'Again', chat }, signal())
    expect((await subject.describe()).status.state).toBe('unavailable')
    expect((await subject.retry()).status.state).toBe('available')
  })

  it('rests the naming model for an hour after two timeouts in a row', async () => {
    const run = vi.fn<NameRunner>((_model, _prompt, _images, abort) => new Promise((_, reject) => abort.addEventListener('abort', () => reject(new Error('aborted')))))
    const { namer: subject, advance } = await namer(run)
    await subject.update({ timeoutSeconds: 2 })
    expect(await subject.suggest({ prompt: 'One' }, signal())).toEqual({ name: null })
    expect((await subject.describe()).status.state).toBe('available')
    await subject.suggest({ prompt: 'Two' }, signal())
    expect((await subject.describe()).status).toMatchObject({ state: 'resting', reason: 'GPT-6-Luna timed out twice in a row' })
    advance(61 * 60_000)
    expect((await subject.describe()).status.state).toBe('available')
  }, 10_000)

  it('learns nothing when the user skips the wait', async () => {
    const skip = new AbortController()
    const run = vi.fn<NameRunner>((_model, _prompt, _images, abort) => new Promise((_, reject) => abort.addEventListener('abort', () => reject(new Error('aborted')))))
    const { namer: subject } = await namer(run)
    const pending = subject.suggest({ prompt: 'Go', chat: { provider: 'claude' } }, skip.signal)
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    skip.abort()
    expect(await pending).toEqual({ name: null })
    expect(run).toHaveBeenCalledOnce()
    expect((await subject.describe()).status.state).toBe('available')
  })

  it("skips a Codex naming model missing from Codex's list, and never sends Claude a screenshot alone", async () => {
    const run = vi.fn<NameRunner>(async () => 'never')
    const { namer: subject } = await namer(run)
    await subject.update({ namingModel: { provider: 'codex', model: 'gpt-retired' } })
    expect((await subject.describe()).status).toMatchObject({ state: 'unavailable', reason: expect.stringContaining("isn't in Codex's model list") })
    expect(await subject.suggest({ images: [image], chat: { provider: 'claude' } }, signal())).toEqual({ name: null })
    expect(run).not.toHaveBeenCalled()
  })

  it("uses only the chat's model when set to, on its default model when it has none", async () => {
    const run = vi.fn<NameRunner>(async () => 'named')
    const { namer: subject } = await namer(run)
    await subject.update({ mode: 'chat-model' })
    await subject.suggest({ prompt: 'Go', chat: { provider: 'codex', model: 'default' } }, signal())
    expect(run.mock.calls.map(([model]) => model)).toEqual([{ provider: 'codex' }])
    await subject.suggest({ prompt: 'Go', chat: { provider: 'muse' } }, signal())
    expect(run).toHaveBeenCalledOnce()
  })

  it('validates settings changes and keeps them across restarts', async () => {
    const { namer: subject, path } = await namer(vi.fn())
    await expect(subject.update({ timeoutSeconds: 0 })).rejects.toThrow(/timeoutSeconds/)
    await expect(subject.update({ mode: 'sometimes' })).rejects.toThrow(/mode/)
    await expect(subject.update({ namingModel: { provider: 'muse', model: 'x' } })).rejects.toThrow(/namingModel/)
    await expect(subject.update({ namingModel: { provider: 'claude', model: 'haiku', configDir: '/etc' } })).rejects.toThrow(/namingModel/)
    await subject.update({ namingModel: { provider: 'claude', model: 'haiku', configDir: join(process.env.HOME ?? '/h', '.claudep') }, timeoutSeconds: 15 })
    const reread = new SessionNamer({ path, run: vi.fn(), catalogs: async () => catalogs })
    expect((await reread.describe()).settings).toEqual({ mode: 'naming-model', namingModel: { provider: 'claude', model: 'haiku', configDir: join(process.env.HOME ?? '/h', '.claudep') }, timeoutSeconds: 15 })
  })
})

describe('naming text', () => {
  it('asks for a short kebab name and cleans up what comes back', () => {
    expect(namingPrompt('', 2)).toBe('Name this coding session in 2 to 4 lowercase words joined by hyphens, from the attached screenshots. Reply with the name only.')
    expect(namingPrompt('Fix it', 1)).toContain('from the task and screenshots')
    expect(nameFromReply('\n  Name: "Tidy README."\nbecause…')).toBe('tidy-readme')
    expect(nameFromReply('')).toBe('')
  })

  it('accepts only well-formed suggestion requests', () => {
    expect(parseSuggestRequest({ prompt: 'x', images: [image], chat: { provider: 'codex', model: 'gpt-6.1-sol' } })).toEqual({ prompt: 'x', images: [image], chat: { provider: 'codex', model: 'gpt-6.1-sol' } })
    expect(() => parseSuggestRequest({ images: [{ id: '../x' }] })).toThrow(/images/)
    expect(() => parseSuggestRequest({ chat: { provider: 'claude', configDir: '/etc' } })).toThrow(/configDir/)
    expect(() => parseSuggestRequest({ chat: { provider: 'claude', model: '--yolo' } })).toThrow(/model/)
  })
})
