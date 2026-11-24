import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentStatus } from '../shared/protocol.js'
import { parseChatSendOptions } from '../shared/agent-chat.js'
import { askAnswerText, parseSessionAsk } from '../shared/session-asks.js'
import { generatedSessionBriefCli } from './agent-hook-installer.js'
import { parseSessionBriefPatch } from './session-brief-api.js'
import { SessionBriefStore } from './session-briefs.js'

const directories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'commando-session-asks-'))
  directories.push(directory)
  return directory
}

async function store(): Promise<SessionBriefStore> {
  return new SessionBriefStore(join(await temporaryDirectory(), 'briefs.json'))
}

function claude(id: string, updatedAt: number, status: AgentStatus['status'] = 'done'): AgentStatus {
  return {
    paneId: '%1', provider: 'claude', status, summary: 'Working', source: 'hook', confidence: 'high',
    reason: 'test', updatedAt, agentSessionId: id,
    // A conversation with no work yet isn't recorded, so give it a task.
    details: { recentActivities: [], checks: [], tasks: [{ id: 't', content: 'Task', status: 'in_progress', priority: 'high', createdAt: 1, updatedAt }] },
  }
}

const push = { key: 'push-31226', question: 'Push the two small #31226 fixes as round 4?', context: 'Two one-line CodeRabbit nits.', options: ['Push as round 4', 'Leave them'], recommend: 0 }
const decline = { key: 'decline-31225', question: 'Decline the #31225 driver-tests request?', options: [] }

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('session asks in the brief store', () => {
  it('raises asks oldest first, updates one in place by key and resolves it', async () => {
    const briefs = await store()
    await briefs.applyAgentPatch('$1', 'work', '%1', { ask: push }, 100)
    await briefs.applyAgentPatch('$1', 'work', '%1', { ask: decline }, 110)
    await briefs.applyAgentPatch('$1', 'work', '%1', { ask: { ...push, question: 'Push both nits as round 4?' } }, 120)
    expect(briefs.get('%1')?.asks).toEqual([
      { ...push, question: 'Push both nits as round 4?', askedAt: 100 },
      { ...decline, askedAt: 110 },
    ])
    await briefs.applyAgentPatch('$1', 'work', '%1', { resolveAsk: 'push-31226' }, 130)
    expect(briefs.get('%1')?.asks?.map((ask) => ask.key)).toEqual(['decline-31225'])
    await briefs.applyAgentPatch('$1', 'work', '%1', { resolveAsk: 'decline-31225' }, 140)
    expect(briefs.get('%1')).not.toHaveProperty('asks')
  })

  it('closes an ask the user answers, and keeps the rest through hooks and a reload', async () => {
    const briefs = await store()
    await briefs.applyAgentPatch('$1', 'work', '%1', { ask: push }, 100)
    await briefs.applyAgentPatch('$1', 'work', '%1', { ask: decline }, 110)
    await briefs.syncFromStatuses('$1', 'work', [claude('aaaaaaaa-1111', 120)], 120)
    expect(await briefs.answerAsk('%1', 'missing')).toBeNull()
    expect((await briefs.answerAsk('%1', 'push-31226'))?.asks?.map((ask) => ask.key)).toEqual(['decline-31225'])
    const replay = new SessionBriefStore(briefs.statePath)
    await replay.load()
    expect(replay.get('%1')?.asks).toEqual([{ ...decline, askedAt: 110 }])
  })

  it('bounds open asks without dropping any', async () => {
    const briefs = await store()
    for (let index = 0; index < 10; index += 1) {
      await briefs.applyAgentPatch('$1', 'work', '%1', { ask: { ...decline, key: `ask-${index}` } }, 100 + index)
    }
    await expect(briefs.applyAgentPatch('$1', 'work', '%1', { ask: { ...decline, key: 'overflow' } }, 120))
      .rejects.toThrow('Too many open asks')
    expect(briefs.get('%1')?.asks).toHaveLength(10)
  })

  it('moves asks with their conversation and brings them back when it resumes', async () => {
    const first = 'aaaaaaaa-1111-4111-8111-111111111111'
    const second = 'bbbbbbbb-2222-4222-8222-222222222222'
    const briefs = await store()
    await briefs.syncFromStatuses('$1', 'work', [claude(first, 10)], 10)
    await briefs.applyAgentPatch('$1', 'work', '%1', { ask: push }, 11)
    await briefs.syncFromStatuses('$1', 'work', [claude(second, 20)], 20)
    expect(briefs.get('%1')).not.toHaveProperty('asks')
    expect(briefs.get('%1')?.earlierSessions?.[0]?.asks).toEqual([{ ...push, askedAt: 11 }])
    await briefs.syncFromStatuses('$1', 'work', [claude(first, 30)], 30)
    expect(briefs.get('%1')?.asks).toEqual([{ ...push, askedAt: 11 }])
  })
})

describe('parsing asks', () => {
  it('accepts a complete ask and rejects invalid fields', () => {
    expect(parseSessionAsk({ ...push, why: 'Costs one review loop.', link: 'https://github.com/o/r/pull/1' }, 5))
      .toEqual({ ...push, why: 'Costs one review loop.', link: 'https://github.com/o/r/pull/1', askedAt: 5 })
    for (const invalid of [
      { ...push, key: 'has space' },
      { ...push, question: ' ' },
      { ...push, recommend: 2 },
      { ...push, options: ['Same', 'Same'] },
      { ...push, options: Array.from({ length: 7 }, (_, index) => `Option ${index}`) },
      { ...push, link: 'javascript:alert(1)' },
    ]) expect(parseSessionAsk(invalid, 5)).toBeNull()
  })

  it('parses ask and resolveAsk patches from the hook API', () => {
    expect(parseSessionBriefPatch({ ask: push })).toEqual({ ask: push })
    expect(parseSessionBriefPatch({ resolveAsk: 'push-31226' })).toEqual({ resolveAsk: 'push-31226' })
    expect(() => parseSessionBriefPatch({ ask: { ...push, key: '' } })).toThrow('ask is invalid')
    expect(() => parseSessionBriefPatch({ resolveAsk: '../x' })).toThrow('resolveAsk is invalid')
  })

  it('lets a chat send name the ask it answers', () => {
    expect(parseChatSendOptions({ answersAsk: 'push-31226' })).toEqual({ answersAsk: 'push-31226' })
    expect(parseChatSendOptions({ answersAsk: 'bad key' })).toBeNull()
  })

  it('writes the answer so it reads on its own', () => {
    expect(askAnswerText(push, 'Leave them')).toBe('Re: Push the two small #31226 fixes as round 4? → Leave them')
  })
})

describe('session update CLI asks', () => {
  async function run(args: string[]): Promise<unknown> {
    const tokenPath = join(await temporaryDirectory(), 'token')
    await writeFile(tokenPath, 'fake-token')
    vi.stubEnv('TMUX_PANE', '%42')
    vi.stubEnv('COMMANDO_PORT', '4410')
    const request = vi.fn(async (_url: string, _init: { body: string }) => ({ ok: true, json: async () => ({ brief: {} }) }))
    vi.stubGlobal('fetch', request)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const source = generatedSessionBriefCli(tokenPath).replace('const args = process.argv.slice(2)', `const args = ${JSON.stringify(args)}`)
      await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
      return JSON.parse(request.mock.calls[0]![1].body)
    } finally { log.mockRestore() }
  }

  it('sends an ask with its options, recommendation and link', async () => {
    expect(await run(['--ask', push.question, '--key', push.key, '--context', push.context, '--option', 'Push as round 4',
      '--option', 'Leave them', '--recommend', '0', '--why', 'One more loop.', '--link', 'https://github.com/o/r/pull/1'])).toEqual({
      ask: { ...push, why: 'One more loop.', link: 'https://github.com/o/r/pull/1' },
    })
  })

  it('resolves an ask by key', async () => {
    expect(await run(['--resolve-ask', 'push-31226'])).toEqual({ resolveAsk: 'push-31226' })
  })
})
