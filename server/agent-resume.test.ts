import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentResume, AgentStatus } from '../shared/protocol.js'
import { AgentResumeService, type AgentResumeDeps, type ResumePane } from './agent-resume.js'

const TARGET = '11111111-1111-4111-8111-111111111111'
const OTHER_TARGET = '22222222-2222-4222-8222-222222222222'
const SESSION = 'ba080dbd-899d-41d3-a94d-44032d806009'
const OLD_SERVER = '100:1000'
const NEW_SERVER = '200:2000'
const CLAUDE = '/Users/me/.local/bin/claude --dangerously-skip-permissions'

function pane(overrides: Partial<ResumePane> = {}): ResumePane {
  return {
    id: '%1', targetId: TARGET, sessionId: '$1', command: '2.1.295', path: '/repo', processId: 500, active: false,
    ...overrides,
  }
}

function hookStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    paneId: '%1', provider: 'claude', agentSessionId: SESSION, status: 'working', summary: '', source: 'hook',
    confidence: 'high', reason: '', updatedAt: 0, ...overrides,
  }
}

describe('AgentResumeService', () => {
  let directory: string
  let now: number
  let timers: Array<{ at: number; callback: () => void }>
  let panes: Map<string, ResumePane>
  let sent: Array<{ paneId: string; command: string }>
  let resumes: Map<string, AgentResume>
  let deps: AgentResumeDeps
  let services: AgentResumeService[]

  const service = (overrides: Partial<AgentResumeDeps> = {}) => {
    const created = new AgentResumeService({ ...deps, ...overrides })
    services.push(created)
    return created
  }

  async function advance(ms: number): Promise<void> {
    const until = now + ms
    for (;;) {
      timers.sort((left, right) => left.at - right.at)
      const next = timers[0]
      if (!next || next.at > until) break
      timers.shift()
      now = next.at
      next.callback()
      // Let the runner's async steps settle before the next timer.
      await settle()
    }
    now = until
    await settle()
  }

  async function settle(): Promise<void> {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'commando-agent-resume-'))
    now = 1_000_000
    timers = []
    panes = new Map()
    sent = []
    resumes = new Map()
    services = []
    deps = {
      statePath: join(directory, 'agent-resume.json'),
      readProcessTable: vi.fn(async () => `  700   500 ${CLAUDE}\n  701   501 ${CLAUDE}\n`),
      readProcessEnvironment: vi.fn(async () => `${CLAUDE} SECRET=x CLAUDE_CONFIG_DIR=/Users/me/.claudep\n`),
      currentPane: (targetId) => panes.get(targetId),
      sendCommand: async (target, command) => { sent.push({ paneId: target.id, command }) },
      pathExists: async () => true,
      onChange: (change) => {
        if (change.type === 'upsert') resumes.set(change.resume.targetId, change.resume)
        else resumes.delete(change.targetId)
      },
      now: () => now,
      setTimer: (callback, ms) => { timers.push({ at: now + ms, callback }) },
      onError: (error) => { throw error },
    }
  })

  afterEach(async () => {
    await Promise.all(services.map((created) => created.flush()))
    await rm(directory, { recursive: true, force: true })
  })

  async function recordOn(server: string, resume = service(), target = pane()): Promise<AgentResumeService> {
    panes.set(target.targetId, target)
    await resume.observeHookStatus(hookStatus({ paneId: target.id }), target, server)
    return resume
  }

  it('records the resume command from the running agent, without other environment', async () => {
    const resume = await recordOn(OLD_SERVER)
    expect(resume.get(TARGET)).toMatchObject({
      provider: 'claude',
      sessionId: SESSION,
      path: '/repo',
      serverId: OLD_SERVER,
      command: `env CLAUDE_CONFIG_DIR=/Users/me/.claudep /Users/me/.local/bin/claude --dangerously-skip-permissions --resume ${SESSION}`,
    })
    await resume.flush()
    const saved = await readFile(deps.statePath!, 'utf8')
    expect(saved).not.toContain('SECRET')
  })

  it('reads the process table once per conversation, not per hook event', async () => {
    const resume = await recordOn(OLD_SERVER)
    await resume.observeHookStatus(hookStatus(), pane(), OLD_SERVER)
    expect(deps.readProcessTable).toHaveBeenCalledTimes(1)
  })

  it('ignores inferred statuses and unresumable sessions', async () => {
    const resume = service()
    await resume.observeHookStatus(hookStatus({ source: 'heuristic' }), pane(), OLD_SERVER)
    await resume.observeHookStatus(hookStatus({ provider: 'codex', agentSessionId: 'codex:%1' }), pane(), OLD_SERVER)
    expect(resume.get(TARGET)).toBeUndefined()
  })

  it('forgets an agent the user exited while tmux kept running', async () => {
    const resume = await recordOn(OLD_SERVER)
    resume.reconcile([pane({ command: 'zsh' })], OLD_SERVER)
    expect(resume.get(TARGET)).toBeUndefined()
    await advance(60_000)
    expect(sent).toEqual([])
  })

  it('resumes a pane restored on a new tmux server once its shell is ready', async () => {
    const resume = await recordOn(OLD_SERVER)
    panes.set(TARGET, pane({ id: '%9', command: 'zsh' }))
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER)
    expect(resumes.get(TARGET)?.state).toBe('queued')
    await advance(3_000)
    expect(sent).toEqual([])
    await advance(2_000)
    expect(sent).toEqual([{ paneId: '%9', command: resume.get(TARGET)!.command }])
    expect(resumes.get(TARGET)?.state).toBe('resuming')

    // The resumed agent's own hook confirms it and moves the record to the new server.
    panes.set(TARGET, pane({ id: '%9' }))
    await resume.observeHookStatus(hookStatus({ paneId: '%9' }), panes.get(TARGET), NEW_SERVER)
    expect(resumes.get(TARGET)?.state).toBe('resumed')
    expect(resume.get(TARGET)?.serverId).toBe(NEW_SERVER)
  })

  it('records from discovery, so a resumed agent moves to the new server without a status change', async () => {
    const resume = await recordOn(OLD_SERVER)
    panes.set(TARGET, pane({ id: '%9', command: 'zsh' }))
    const status = hookStatus({ paneId: '%9' })
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER, () => status)
    await advance(5_000)
    expect(sent).toHaveLength(1)

    // The registry still holds the same status; only the pane's process changed.
    panes.set(TARGET, pane({ id: '%9' }))
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER, () => status)
    await advance(0)
    expect(resume.get(TARGET)?.serverId).toBe(NEW_SERVER)
    expect(resumes.get(TARGET)?.state).toBe('resumed')

    // Exiting it now is deliberate, so the next restart leaves the pane alone.
    resume.reconcile([pane({ id: '%9', command: 'zsh' })], NEW_SERVER, () => status)
    expect(resume.get(TARGET)).toBeUndefined()
  })

  it('backs off reading the process table when the agent is not a child of the pane shell', async () => {
    const readTable = vi.fn(async () => '')
    const resume = service({ readProcessTable: readTable })
    panes.set(TARGET, pane())
    resume.reconcile([pane()], OLD_SERVER, () => hookStatus())
    await advance(0)
    resume.reconcile([pane()], OLD_SERVER, () => hookStatus())
    await advance(0)
    expect(readTable).toHaveBeenCalledTimes(1)
    expect(resume.get(TARGET)).toBeUndefined()
    await advance(30_000)
    resume.reconcile([pane()], OLD_SERVER, () => hookStatus())
    await advance(0)
    expect(readTable).toHaveBeenCalledTimes(2)
  })

  it('tries each restore once, even across repeated discoveries', async () => {
    const resume = await recordOn(OLD_SERVER)
    panes.set(TARGET, pane({ command: 'zsh' }))
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER)
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER)
    await advance(60_000)
    expect(sent).toHaveLength(1)
  })

  it('staggers resumes and starts with the active pane', async () => {
    const resume = await recordOn(OLD_SERVER)
    await recordOn(OLD_SERVER, resume, pane({ id: '%2', targetId: OTHER_TARGET, processId: 501 }))
    panes.set(TARGET, pane({ command: 'zsh' }))
    panes.set(OTHER_TARGET, pane({ id: '%2', targetId: OTHER_TARGET, command: 'zsh', active: true }))
    resume.reconcile([...panes.values()], NEW_SERVER)
    await advance(4_000)
    expect(sent.map((entry) => entry.paneId)).toEqual(['%2'])
    await advance(2_000)
    expect(sent.map((entry) => entry.paneId)).toEqual(['%2'])
    await advance(500)
    expect(sent.map((entry) => entry.paneId)).toEqual(['%2', '%1'])
  })

  it('leaves a pane alone when someone already started something in it', async () => {
    const resume = await recordOn(OLD_SERVER)
    panes.set(TARGET, pane({ command: 'zsh' }))
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER)
    panes.set(TARGET, pane({ command: 'vim' }))
    await advance(10_000)
    expect(sent).toEqual([])
    expect(resumes.has(TARGET)).toBe(false)
  })

  it('reports a folder that no longer exists', async () => {
    const resume = await recordOn(OLD_SERVER, service({ pathExists: async () => false }))
    panes.set(TARGET, pane({ command: 'zsh' }))
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER)
    await advance(5_000)
    expect(resumes.get(TARGET)).toMatchObject({ state: 'failed', error: 'The folder no longer exists: /repo' })
  })

  it('fails when the agent does not start, and retries on request', async () => {
    const resume = await recordOn(OLD_SERVER)
    panes.set(TARGET, pane({ command: 'zsh' }))
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER)
    await advance(5_000)
    await advance(20_000)
    expect(resumes.get(TARGET)?.state).toBe('failed')

    expect(resume.retry()).toBe(1)
    await advance(3_000)
    expect(sent).toHaveLength(2)
    expect(resumes.get(TARGET)?.state).toBe('resuming')
  })

  it('requeues after a daemon restart that came before the send', async () => {
    const first = await recordOn(OLD_SERVER)
    panes.set(TARGET, pane({ command: 'zsh' }))
    first.reconcile([panes.get(TARGET)!], NEW_SERVER)
    await first.flush()

    const second = service()
    await second.load()
    expect(second.get(TARGET)?.attemptedServerId).toBeUndefined()
    second.reconcile([panes.get(TARGET)!], NEW_SERVER)
    expect(resumes.get(TARGET)?.state).toBe('queued')
  })

  it('forgets a record whose agent came back on this server and then went away', async () => {
    const first = await recordOn(OLD_SERVER)
    panes.set(TARGET, pane({ command: 'zsh' }))
    first.reconcile([panes.get(TARGET)!], NEW_SERVER)
    await advance(5_000)
    expect(first.get(TARGET)?.attemptedServerId).toBe(NEW_SERVER)
    await first.flush()

    // The daemon restarted after sending, before learning the outcome.
    resumes.clear()
    const second = service()
    await second.load()
    second.reconcile([panes.get(TARGET)!], NEW_SERVER)
    expect(second.get(TARGET)).toBeUndefined()
  })

  it('never retypes a failed resume on a later restart unless retried', async () => {
    const resume = await recordOn(OLD_SERVER)
    panes.set(TARGET, pane({ command: 'zsh' }))
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER)
    await advance(25_000)
    expect(resumes.get(TARGET)?.state).toBe('failed')
    expect(resume.get(TARGET)).toBeUndefined()

    resume.reconcile([panes.get(TARGET)!], '300:3000')
    await advance(30_000)
    expect(sent).toHaveLength(1)
  })

  it('runs the pane at the front of the queue when an active pane jumps ahead', async () => {
    const resume = await recordOn(OLD_SERVER)
    await recordOn(OLD_SERVER, resume, pane({ id: '%2', targetId: OTHER_TARGET, processId: 501 }))
    panes.set(TARGET, pane({ command: 'zsh' }))
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER)
    await advance(1_000)
    panes.set(OTHER_TARGET, pane({ id: '%2', targetId: OTHER_TARGET, command: 'zsh', active: true }))
    resume.reconcile([panes.get(OTHER_TARGET)!], NEW_SERVER)
    await advance(30_000)
    expect(sent.map((entry) => entry.paneId).sort()).toEqual(['%1', '%2'])
  })

  it('does not type over input the user started in a waiting pane', async () => {
    const lines = new Map([['%1', '➜  repo '], ['%2', '➜  repo ']])
    const resume = await recordOn(OLD_SERVER, service({ readPromptLine: async (target) => lines.get(target.id)! }))
    await recordOn(OLD_SERVER, resume, pane({ id: '%2', targetId: OTHER_TARGET, processId: 501 }))
    panes.set(TARGET, pane({ command: 'zsh' }))
    panes.set(OTHER_TARGET, pane({ id: '%2', targetId: OTHER_TARGET, command: 'zsh' }))
    resume.reconcile([...panes.values()], NEW_SERVER)
    await advance(4_000)
    expect(sent.map((entry) => entry.paneId)).toEqual(['%1'])
    // The second pane waits out the stagger while the user starts typing in it.
    lines.set('%2', '➜  repo git checkout ma')
    await advance(2_500)
    expect(sent.map((entry) => entry.paneId)).toEqual(['%1'])
    expect(resumes.get(OTHER_TARGET)).toMatchObject({ state: 'failed', error: 'The pane has unsent input, so nothing was typed. Clear it, then retry.' })
  })

  it('does not type into a pane the user typed in during the shell-ready wait', async () => {
    let typedAt: number | undefined
    const resume = await recordOn(OLD_SERVER, service({ lastInputAt: () => typedAt }))
    panes.set(TARGET, pane({ command: 'zsh' }))
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER)
    await advance(1_000)
    typedAt = now
    await advance(4_000)
    expect(sent).toEqual([])
    expect(resumes.get(TARGET)?.state).toBe('failed')
  })

  it('offers a retry when typing into the pane fails', async () => {
    const resume = await recordOn(OLD_SERVER, service({ sendCommand: async () => { throw new Error('pane not found') } }))
    panes.set(TARGET, pane({ command: 'zsh' }))
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER)
    await advance(5_000)
    expect(resumes.get(TARGET)).toMatchObject({ state: 'failed', error: 'Could not type into the pane: pane not found' })
    expect(resume.retry(undefined, NEW_SERVER)).toBe(1)
  })

  it('clears a failed resume whose pane has gone when retried', async () => {
    const resume = await recordOn(OLD_SERVER, service({ pathExists: async () => false }))
    panes.set(TARGET, pane({ command: 'zsh' }))
    resume.reconcile([panes.get(TARGET)!], NEW_SERVER)
    await advance(5_000)
    expect(resumes.get(TARGET)?.state).toBe('failed')
    panes.delete(TARGET)
    resume.retry(undefined, NEW_SERVER)
    expect(resumes.has(TARGET)).toBe(false)
    expect(resume.retry()).toBe(0)
  })

  it('backs off when reading the process table fails', async () => {
    const readTable = vi.fn(async () => { throw new Error('ps timed out') })
    const resume = service({ readProcessTable: readTable, onError: () => {} })
    resume.reconcile([pane()], OLD_SERVER, () => hookStatus())
    await advance(0)
    resume.reconcile([pane()], OLD_SERVER, () => hookStatus())
    await advance(0)
    expect(readTable).toHaveBeenCalledTimes(1)
  })

  it('hands records to an archive and queues them again after its restore', async () => {
    const resume = await recordOn(OLD_SERVER)
    const agents = resume.archivedAgents([TARGET, OTHER_TARGET])
    expect(Object.keys(agents)).toEqual([TARGET])
    resume.forgetTargets([TARGET])
    expect(resume.get(TARGET)).toBeUndefined()

    resume.restoreArchived(agents)
    panes.set(TARGET, pane({ id: '%5', command: 'zsh' }))
    // An archive restore happens on the same tmux server.
    resume.reconcile([panes.get(TARGET)!], OLD_SERVER)
    await advance(5_000)
    expect(sent).toEqual([{ paneId: '%5', command: agents[TARGET]!.command }])
  })
})
