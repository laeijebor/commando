import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CloudTaskService } from '../cloud-task-service.js'
import { CloudTaskStore } from '../cloud-task-store.js'
import type { CloudCliRequest, CloudCliResult } from '../cloud-provider.js'
import { ClaudeCloudAdapter } from './claude-cli.js'

describe('Claude create journal boundary', () => {
  it.each(['accepted', 'delivery_unknown', 'rejected'] as const)('pins source before dispatch and recovers %s without replay', async (state) => {
    const root = await mkdtemp(join(tmpdir(), 'commando-claude-journal-'))
    const path = join(root, 'tasks.sqlite')
    const commit = 'a'.repeat(40)
    const remoteUrl = 'https://github.com/acme/repo.git'
    const input = { provider: 'claude', credentialContextId: 'fixture-context', accountConfirmed: true, prompt: state === 'rejected' ? 'x'.repeat(15_000) : 'Synthetic task',
      source: { checkoutPath: '/user/checkout', branch: 'main' } }
    const response = (stdout = ''): CloudCliResult => ({ stdout, stderr: '', exitCode: 0, signal: null, spawned: true, timedOut: false, truncated: false })
    let store = new CloudTaskStore(path)
    let service: CloudTaskService | undefined
    const calls: CloudCliRequest[] = []
    let scratch = ''
    const runner = vi.fn(async (request: CloudCliRequest) => {
      calls.push(request)
      if (request.args[0] === '--version') return response('2.1.316 (Claude Code)')
      if (request.executable === 'git') {
        if (request.args[0] === 'remote') return response(remoteUrl)
        if (request.args[0] === 'ls-remote') return response(`${commit}\trefs/heads/main`)
        if (request.args.includes('clone')) {
          scratch = dirname(request.args.at(-1)!)
          await mkdir(request.args.at(-1)!)
        }
        if (request.args[0] === 'rev-parse') return response(commit)
        return response()
      }
      if (request.args.includes('new-session')) {
        expect(store.getOperationByKey('synthetic-create')?.state).toBe('dispatching')
        expect(store.listTasks()[0].source).toEqual({ ...input.source, remoteUrl, commit })
      }
      if (request.args.includes('capture-pane')) return response(state === 'accepted'
        ? 'Created cloud session: Synthetic\nView: https://claude.ai/code/session_ABCDEFGHIJ1234?from=cli&m=0\nResume with: claude --teleport session_ABCDEFGHIJ1234\n' : 'Unexpected output\n')
      if (request.args.includes('display-message')) return response('1')
      return response()
    })
    try {
      const adapter = new ClaudeCloudAdapter({ runner, verifiedVersion: '2.1.314', credentialContextId: input.credentialContextId, createOptions: { runner } })
      service = new CloudTaskService({ store, providers: [adapter] })
      expect((await service.listProviders()).providers[0].createPromptByteLimit).toEqual(expect.any(Number))
      const action = await service.createTask(input, 'synthetic-create')
      expect(action.task.source).toEqual({ ...input.source, remoteUrl, commit })
      await vi.waitFor(() => expect(service!.getOperation(action.operation.id).state).toBe(state))
      if (state === 'rejected') expect(service.getTask(action.task.id).task.issue).toMatchObject({
        code: 'prompt_too_long_for_terminal', message: expect.stringContaining('Shorten the prompt'),
      })
      const count = calls.length
      expect((await service.createTask(input, 'synthetic-create')).reused).toBe(true)
      expect(calls.length).toBe(count)
      await service.stop()
      service = undefined
      store.close()
      store = new CloudTaskStore(path)
      service = new CloudTaskService({ store, providers: [adapter] })
      expect(service.getTask(action.task.id).task).toMatchObject({ source: { remoteUrl, branch: 'main', commit }, deliveryState: state,
        identityEvidence: state === 'accepted' ? 'provider_receipt' : null })
      expect((await service.createTask(input, 'synthetic-create')).reused).toBe(true)
      expect(calls.filter((r) => r.args.includes('new-session'))).toHaveLength(state === 'rejected' ? 0 : 1)
    } finally {
      await service?.stop()
      store.close()
      if (scratch) await rm(scratch, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  })
})
