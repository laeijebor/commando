import type { BrowserContext, Page, WebSocketRoute } from '@playwright/test'
import type { CommandoSnapshot, TmuxPane } from '../../../shared/protocol'
import type {
  CloudCreateInput, CloudDiff, CloudLinkInput, CloudMessageInput, CloudOperation, CloudProvidersResponse,
  CloudTask, CloudTaskAction, CloudTaskDetail,
} from '../../../shared/cloud-tasks'

// Synthetic HTTP contracts, not evidence of a real provider CLI/account capability.
export const installationId = 'cloud-qa-isolated-installation'
export const pendingKey = 'commando-cloud-pending-intents-v1'
export const timestamp = '2026-09-12T12:00:00.000Z'
export const hostileText = '<img src="https://invalid.example/pixel" onerror="window.cloudQaExecuted=true"> <script>window.cloudQaExecuted=true</script>'

export function providers(ready = false): CloudProvidersResponse {
  return { installationId, providers: ['codex', 'claude'].map((id) => ({
    id: id as 'codex' | 'claude', label: id === 'codex' ? 'Codex Cloud' : 'Claude Code Cloud',
    homeUrl: id === 'codex' ? 'https://chatgpt.com/codex' : 'https://claude.ai/code',
    readiness: ready ? 'ready' : 'missing_cli', version: ready ? 'synthetic-qa' : null,
    reason: ready ? 'Synthetic verified capability fixture.' : 'CLI missing. Link an existing task without launching work.',
    credentialContextId: 'qa-context', verifiedAccountRef: null,
    capabilities: { create: ready && id === 'codex', link: true, list: ready && id === 'codex',
      inspect: ready && id === 'codex', sendMessage: ready && id === 'claude', diff: ready && id === 'codex', accountIdentity: false },
  })) }
}

export function task(overrides: Partial<CloudTask> = {}): CloudTask {
  return {
    id: 'qa-codex', provider: 'codex', credentialContextId: 'qa-context', verifiedAccountRef: null,
    title: 'Review synthetic cloud result', prompt: 'Check the fixture without changing local files.',
    source: { environmentId: 'env_qa', repository: 'acme/qa-fixture', branch: 'qa/cloud' },
    providerTaskId: 'task_qa', providerUrl: 'https://chatgpt.com/codex/tasks/task_qa',
    identityEvidence: 'provider_receipt', deliveryState: 'accepted', remoteState: 'result_ready',
    rawState: 'ready', observationState: 'fresh', lastObservedAt: timestamp, providerUpdatedAt: timestamp,
    createdAt: timestamp, updatedAt: timestamp, revision: 1, archivedAt: null, issue: null, ...overrides,
  }
}

export function operation(target: CloudTask, overrides: Partial<CloudOperation> = {}): CloudOperation {
  return {
    id: `op-${target.id}`, taskId: target.id, kind: 'create', idempotencyKey: `key-${target.id}`,
    requestHash: 'a'.repeat(64), payload: { provider: target.provider, credentialContextId: target.credentialContextId, prompt: target.prompt, source: target.source, accountConfirmed: true },
    state: target.deliveryState, ownerId: null, createdAt: timestamp, updatedAt: timestamp,
    receipt: target.providerTaskId && target.providerUrl && target.identityEvidence
      ? { providerTaskId: target.providerTaskId, providerUrl: target.providerUrl, evidence: target.identityEvidence } : null,
    issue: null, ...overrides,
  }
}

export function localSnapshot(): CommandoSnapshot {
  const panes: TmuxPane[] = [12, 21].map((id, index) => ({
    id: `%${id}`, targetId: `550e8400-e29b-41d4-a716-4466554400${id}`,
    index: 0, windowId: index ? '@5' : '@2', sessionId: index ? '$6' : '$3',
    title: index ? 'review-agent' : 'editor', command: 'zsh', path: '/tmp/cloud-qa-fixture',
    active: true, dead: false, width: 80, height: 24, cursorX: 0, cursorY: 0,
    alternateSavedX: 0, alternateSavedY: 0, alternateOn: false, cursorVisible: true,
    cursorShape: 'block', cursorBlinking: false, scrollRegionUpper: 0, scrollRegionLower: 23,
    wrapFlag: true, originFlag: false, insertFlag: false, keypadFlag: false,
    keypadCursorFlag: false, mouseAnyFlag: false, mouseSgrFlag: false, paneTabs: [],
  }))
  return { revision: 1, capturedAt: Date.now(), ports: [], panes,
    sessions: panes.map((pane, index) => ({ id: pane.sessionId, name: index ? 'local-review' : 'local-editor',
      attached: !index, activeWindowId: pane.windowId, windowIds: [pane.windowId] })),
    windows: panes.map((pane) => ({ id: pane.windowId, index: 0, sessionId: pane.sessionId, name: pane.title,
      active: true, layout: `dbde,80x24,0,0,${pane.id.slice(1)}`, paneIds: [pane.id] })),
  }
}

export type RequestRecord = { method: string; path: string; body: unknown; key?: string }
export class CloudDaemonFixture {
  snapshot: CommandoSnapshot = { revision: 1, capturedAt: Date.now(), ports: [], panes: [], sessions: [], windows: [] }
  providerResponse = providers()
  details = new Map<string, CloudTaskDetail>()
  requests: RequestRecord[] = []
  messages: { type: string }[] = []
  unexpected: string[] = []
  pageErrors: string[] = []
  consoleErrors: string[] = []
  expectedFailures: string[] = []
  expectedNotFound: string[] = []
  createMode: 'prepared' | 'lost-recorded' | 'lost-unrecorded' = 'prepared'
  loseMessageResponse = true
  unavailable = false
  completeOnRefresh = false
  refreshDelayMs = 0
  activeRefreshes = 0
  peakRefreshes = 0
  diff: CloudDiff = { text: `--- a/result.txt\n+++ b/result.txt\n@@ -1 +1 @@\n-old\n+${hostileText}\n`, truncated: false }
  private sockets = new Set<WebSocketRoute>()

  save(target: CloudTask, operations = [operation(target)]) {
    const detail = { task: target, operations }
    this.details.set(target.id, detail)
    return detail
  }
  publish(snapshot = this.snapshot) {
    this.snapshot = snapshot
    this.snapshot.revision += 1
    for (const socket of this.sockets) socket.send(JSON.stringify({ type: 'snapshot', snapshot }))
  }
  mutations() { return this.requests.filter((request) => request.method !== 'GET' && !request.path.endsWith('/refresh')) }
  creates() { return this.requests.filter((request) => request.method === 'POST' && request.path === '/api/cloud-tasks') }

  async install(page: Page, context: BrowserContext, baseUrl: string) {
    page.on('pageerror', (error) => this.pageErrors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') this.consoleErrors.push(message.text()) })
    await context.routeWebSocket((url) => url.pathname === '/ws', (socket) => {
      this.sockets.add(socket)
      socket.send(JSON.stringify({ type: 'snapshot', snapshot: this.snapshot }))
      socket.onMessage((message) => this.messages.push(JSON.parse(String(message))))
      socket.onClose(() => this.sockets.delete(socket))
    })
    await context.route('**/*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const path = url.pathname
      const method = request.method()
      if (url.origin !== baseUrl || path.startsWith('/screenshots')) {
        this.unexpected.push(`${method} ${url}`)
        return route.abort()
      }
      if (!path.startsWith('/api/')) return route.continue()
      const body: unknown = request.postData() ? request.postDataJSON() : null
      const key = request.headers()['idempotency-key']
      this.requests.push({ method, path, body, key })
      const reply = (json: unknown, status = 200) => route.fulfill({ json, status })
      const fail = () => { this.expectedFailures.push(path); return route.abort('connectionfailed') }
      if (path === '/api/auth/bootstrap' && method === 'GET') return reply({ enabled: false, needsOwner: false, ownerEmail: null })
      if (path === '/api/snapshot' && method === 'GET') return reply(this.snapshot)
      if (path === '/api/git/summary' && method === 'GET') return reply({ isRepo: false })
      if (path === '/api/prs/prefs' && method === 'GET') return reply({ prefs: { version: 1, pinnedRepos: [], recentRepos: [], lastRepo: null, lastFilter: 'open', lastScope: 'mine' } })
      if (path === '/api/prs/repos' && method === 'GET') return reply({ repos: [] })
      if (path === '/api/prs/repo' && method === 'GET') return reply({ repo: null })
      if (path === '/api/session-management/preferences' && method === 'GET') return reply({ preferences: {
        version: 1, groups: [], ungroupedSessionIds: this.snapshot.sessions.map((session) => session.id),
      } })
      if (path === '/api/cloud-providers' && method === 'GET') return this.unavailable ? fail() : reply(this.providerResponse)
      if (path === '/api/cloud-tasks' && method === 'GET') return reply({ tasks: [...this.details.values()].map(({ task: { prompt: _prompt, ...summary } }) => summary) })
      if (path.startsWith('/api/cloud-operations/by-key/') && method === 'GET') {
        const lookup = decodeURIComponent(path.slice('/api/cloud-operations/by-key/'.length))
        const op = [...this.details.values()].flatMap((detail) => detail.operations).find((op) => op.idempotencyKey === lookup)
        if (!op) this.expectedNotFound.push(path)
        return reply({ operation: op ?? null }, op ? 200 : 404)
      }
      // Reject outdated fixtures/clients rather than silently accepting an unconfirmed context.
      if (method === 'POST' && /^\/api\/cloud-(tasks|operations)(\/|$)/.test(path) && !path.endsWith('/refresh')) {
        const input = body as { credentialContextId?: unknown; accountConfirmed?: unknown } | null
        if (input?.accountConfirmed !== true || typeof input.credentialContextId !== 'string'
          || !this.providerResponse.providers.some((provider) => provider.credentialContextId === input.credentialContextId)) {
          this.unexpected.push(`Unconfirmed credential context: ${method} ${path}`)
          return route.abort()
        }
      }
      const operationMatch = path.match(/^\/api\/cloud-operations\/([^/]+)(\/dispatch)?$/)
      if (operationMatch) {
        const detail = [...this.details.values()].find((detail) => detail.operations.some((op) => op.id === decodeURIComponent(operationMatch[1])))
        const op = detail?.operations.find((op) => op.id === decodeURIComponent(operationMatch[1]))
        if (detail && op) {
          if (!operationMatch[2] && method === 'GET') return reply({ operation: op })
          if (operationMatch[2] && method === 'POST' && op.state === 'prepared') {
            const accepted = { ...detail.task, revision: detail.task.revision + 1, deliveryState: 'accepted' as const,
              providerTaskId: 'task_resumed', providerUrl: 'https://chatgpt.com/codex/tasks/task_resumed',
              identityEvidence: 'provider_receipt' as const, remoteState: 'queued' as const }
            const receipt = { providerTaskId: accepted.providerTaskId, providerUrl: accepted.providerUrl, evidence: accepted.identityEvidence }
            const resumed = { ...op, state: 'accepted' as const, receipt }
            this.save(accepted, detail.operations.map((item) => item.id === op.id ? resumed : item))
            return reply({ task: accepted, operation: resumed, reused: true } satisfies CloudTaskAction, 202)
          }
        }
      }
      if (path === '/api/cloud-tasks/link' && method === 'POST' && key) {
        const input = body as CloudLinkInput
        const linked = task({ id: `qa-linked-${this.details.size}`, provider: input.provider, title: input.title ?? 'Linked task', prompt: '',
          credentialContextId: input.credentialContextId, source: input.source ?? {}, providerTaskId: input.providerTaskId,
          providerUrl: input.provider === 'claude' ? `https://claude.ai/code/${input.providerTaskId}` : `https://chatgpt.com/codex/tasks/${input.providerTaskId}`,
          identityEvidence: 'user_link', remoteState: 'unknown', rawState: null, observationState: 'unavailable', lastObservedAt: null })
        const op = operation(linked, { kind: 'link', payload: input, idempotencyKey: key })
        this.save(linked, [op])
        return reply({ task: linked, operation: op, reused: false } satisfies CloudTaskAction, 202)
      }
      if (path === '/api/cloud-tasks' && method === 'POST' && key) {
        const input = body as CloudCreateInput
        const created = task({ id: 'qa-created', provider: input.provider, title: input.title ?? 'Created fixture', prompt: input.prompt,
          credentialContextId: input.credentialContextId, source: input.source, deliveryState: this.createMode === 'lost-recorded' ? 'delivery_unknown' : 'prepared',
          providerTaskId: null, providerUrl: null, identityEvidence: null, remoteState: 'unknown', rawState: null,
          observationState: 'unavailable', lastObservedAt: null })
        const op = operation(created, { payload: input, idempotencyKey: key })
        if (this.createMode !== 'lost-unrecorded') this.save(created, [op])
        if (this.createMode !== 'prepared') return fail()
        return reply({ task: created, operation: op, reused: false } satisfies CloudTaskAction, 202)
      }
      const messageMatch = path.match(/^\/api\/cloud-tasks\/([^/]+)\/messages$/)
      if (messageMatch && method === 'POST' && key) {
        const detail = this.details.get(decodeURIComponent(messageMatch[1]))
        if (detail) {
          const op = operation(detail.task, { id: `message-${key}`, kind: 'message', payload: body as CloudMessageInput,
            idempotencyKey: key, state: this.loseMessageResponse ? 'delivery_unknown' : 'accepted',
            receipt: this.loseMessageResponse ? null : operation(detail.task).receipt })
          this.save({ ...detail.task, revision: detail.task.revision + 1 }, [...detail.operations, op])
          if (this.loseMessageResponse) return fail()
          return reply({ task: this.details.get(detail.task.id)!.task, operation: op, reused: false } satisfies CloudTaskAction, 202)
        }
      }
      const match = path.match(/^\/api\/cloud-tasks\/([^/]+)(?:\/(refresh|diff))?$/)
      if (match) {
        const detail = this.details.get(decodeURIComponent(match[1]))
        if (detail) {
          if (match[2] === 'diff' && method === 'GET') return reply(this.diff)
          if (match[2] === 'refresh' && method === 'POST') {
            this.activeRefreshes++
            this.peakRefreshes = Math.max(this.peakRefreshes, this.activeRefreshes)
            try {
              if (this.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMs))
              if (this.completeOnRefresh) detail.task = { ...detail.task, revision: detail.task.revision + 1,
                remoteState: 'result_ready', rawState: 'ready', observationState: 'fresh' }
              return await reply(detail)
            } finally { this.activeRefreshes-- }
          }
          if (!match[2] && method === 'GET') return reply(detail)
          if (!match[2] && method === 'PATCH') {
            const patch = body as Partial<Pick<CloudTask, 'title' | 'archivedAt'>>
            detail.task = { ...detail.task, ...patch, revision: detail.task.revision + 1 }
            return reply(detail)
          }
        }
      }
      this.unexpected.push(`${method} ${path}`)
      return route.abort()
    })
  }
}
