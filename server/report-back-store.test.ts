import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REPORT_BACK_TOKEN_PREFIX, ReportBackStore, ReportBackStoreError } from './report-back-store.js'

const tempDirs: string[] = []

function makeStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'commando-report-back-store-'))
  tempDirs.push(dir)
  return join(dir, 'report-back-state.json')
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('ReportBackStore', () => {
  it('mints hashed tokens with 0600 permissions and never stores plaintext on disk', () => {
    const statePath = makeStatePath()
    let clock = 1_700_000_000_000
    const store = new ReportBackStore({ statePath, now: () => clock })

    const { token, info } = store.mintToken({ taskId: 'cloud-task-1', label: 'Fix login' })
    expect(token.startsWith(REPORT_BACK_TOKEN_PREFIX)).toBe(true)
    expect(token.length).toBeGreaterThan(40)
    expect(info).toEqual({
      tokenId: info.tokenId,
      taskId: 'cloud-task-1',
      label: 'Fix login',
      createdAt: clock,
    })

    const mode = statSync(statePath).mode & 0o777
    expect(mode).toBe(0o600)

    const raw = readFileSync(statePath, 'utf8')
    expect(raw).not.toContain(token)
    expect(store.listTokens()).toEqual([info])
  })

  it('authenticates valid tokens, updates lastUsedAt, and rejects invalid/revoked/expired tokens', () => {
    const statePath = makeStatePath()
    let clock = 1_000
    const store = new ReportBackStore({ statePath, now: () => clock })

    const { token, info } = store.mintToken({ taskId: 'task-a', ttlMs: 5_000 })
    expect(store.authenticate('cmrb_wrong')).toBeNull()
    expect(store.authenticate('')).toBeNull()
    expect(store.authenticate('x'.repeat(1_000))).toBeNull()

    clock = 2_500
    const authed = store.authenticate(token)
    expect(authed).toEqual({ ...info, lastUsedAt: 2_500 })

    // Re-loading from disk preserves hash and lastUsedAt.
    const reloaded = new ReportBackStore({ statePath, now: () => clock })
    expect(reloaded.listTokens()).toEqual([{ ...info, lastUsedAt: 2_500 }])

    // Expires at createdAt + ttlMs.
    clock = 6_000
    expect(store.authenticate(token)).toBeNull()

    // Revocation rejects even non-expiring tokens.
    const second = store.mintToken({ taskId: 'task-b' })
    expect(store.authenticate(second.token)?.taskId).toBe('task-b')
    clock = 7_000
    const revoked = store.revokeToken(second.info.tokenId)
    expect(revoked?.revokedAt).toBe(7_000)
    expect(store.authenticate(second.token)).toBeNull()
    expect(store.revokeToken('missing-id')).toBeNull()
  })

  it('records updates, questions, statuses, and human replies with cursor-based reads', () => {
    const statePath = makeStatePath()
    let clock = 10_000
    const store = new ReportBackStore({ statePath, now: () => clock })
    store.mintToken({ taskId: 'task-1', label: 'Migration' })

    const update = store.postUpdate('task-1', 'Running tests', { label: 'Migration' })
    expect(update.task.status).toBe('running')
    expect(update.task.label).toBe('Migration')
    expect(update.event.kind).toBe('update')

    clock = 11_000
    const asked = store.askUser('task-1', 'Deploy to staging?')
    expect(asked.task.status).toBe('waiting')
    expect(asked.task.pendingQuestion).toEqual({
      id: asked.questionId,
      question: 'Deploy to staging?',
      createdAt: 11_000,
    })

    // Empty cursor before any human reply.
    expect(store.readMessages('task-1')).toEqual({ messages: [], nextCursor: '0' })

    clock = 12_000
    const reply1 = store.postHumanReply('task-1', 'Yes, deploy now')
    expect(reply1.reply.cursor).toBe('1')
    expect(reply1.reply.questionId).toBe(asked.questionId)
    expect(reply1.task.pendingQuestion).toBeUndefined()
    expect(reply1.task.status).toBe('running')

    clock = 13_000
    const reply2 = store.postHumanReply('task-1', 'Ping me after smoke tests')
    expect(reply2.reply.cursor).toBe('2')

    const firstRead = store.readMessages('task-1')
    expect(firstRead.messages.map((m) => [m.cursor, m.message])).toEqual([
      ['1', 'Yes, deploy now'],
      ['2', 'Ping me after smoke tests'],
    ])
    expect(firstRead.nextCursor).toBe('2')

    const incremental = store.readMessages('task-1', '1')
    expect(incremental.messages.map((m) => [m.cursor, m.message])).toEqual([
      ['2', 'Ping me after smoke tests'],
    ])
    expect(incremental.nextCursor).toBe('2')

    const caughtUp = store.readMessages('task-1', '2')
    expect(caughtUp).toEqual({ messages: [], nextCursor: '2' })

    clock = 14_000
    const done = store.setStatus('task-1', 'done', 'Deployed and verified')
    expect(done.task.status).toBe('done')
    expect(done.task.summary).toBe('Deployed and verified')
    expect(done.task.events).toHaveLength(5)

    // Survives restart from disk.
    const reloaded = new ReportBackStore({ statePath, now: () => clock })
    expect(reloaded.getTask('task-1')).toEqual(done.task)
    expect(reloaded.readMessages('task-1', '1').messages).toHaveLength(1)
  })

  it('clears pending question when status moves away from waiting', () => {
    const statePath = makeStatePath()
    const store = new ReportBackStore({ statePath })
    store.askUser('task-q', 'Proceed?')
    expect(store.getTask('task-q')?.pendingQuestion).toBeDefined()

    const updated = store.setStatus('task-q', 'blocked', 'Missing secret')
    expect(updated.task.pendingQuestion).toBeUndefined()
    expect(updated.task.status).toBe('blocked')
  })

  it('bounds event and reply history while keeping reply cursors monotonic', () => {
    const statePath = makeStatePath()
    const store = new ReportBackStore({ statePath, maxEventsPerTask: 3, maxRepliesPerTask: 2 })

    for (let i = 1; i <= 5; i++) {
      store.postUpdate('task-cap', `update ${i}`)
    }
    expect(store.getTask('task-cap')?.events.map((e) => e.message)).toEqual([
      'update 3',
      'update 4',
      'update 5',
    ])

    for (let i = 1; i <= 4; i++) {
      store.postHumanReply('task-cap', `reply ${i}`)
    }
    const read = store.readMessages('task-cap')
    expect(read.messages.map((m) => [m.cursor, m.message])).toEqual([
      ['3', 'reply 3'],
      ['4', 'reply 4'],
    ])
    expect(read.nextCursor).toBe('4')
  })

  it('rejects invalid inputs and refuses to silently overwrite corrupt state files', () => {
    const statePath = makeStatePath()
    const store = new ReportBackStore({ statePath })

    expect(() => store.mintToken({ taskId: '../escape' })).toThrow(ReportBackStoreError)
    expect(() => store.mintToken({ taskId: 'bad task' })).toThrow(ReportBackStoreError)
    expect(() => store.mintToken({ taskId: 'ok', ttlMs: 0 })).toThrow(ReportBackStoreError)
    expect(() => store.readMessages('ok', '-1')).toThrow(ReportBackStoreError)
    expect(() => store.setStatus('ok', 'unknown')).toThrow(ReportBackStoreError)

    writeFileSync(statePath, '{not json', { mode: 0o600 })
    expect(() => new ReportBackStore({ statePath })).toThrow(ReportBackStoreError)
  })
})
