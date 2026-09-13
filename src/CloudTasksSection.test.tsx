// @vitest-environment jsdom
/// <reference types="node" />
import { webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudOperation, CloudProviderInfo, CloudTask, CloudTaskDetail } from '../shared/cloud-tasks'
import type { CloudTasksApi } from './cloudTasksApi'
import { CloudTasksHud, CloudTasksSection } from './CloudTasksSection'
import { CLAUDE_CREATE_DISABLED_REASON } from './CloudTaskCreateDialog'
import { boundCloudDiff } from './CloudTaskDiff'
import { CLOUD_PENDING_STORAGE_KEY, cloudTaskStoreFor, digestCloudIntent } from './cloudTaskStore'

// Deliberately synthetic provider evidence; tests never call a CLI or provider.
function fixtureTask(overrides: Partial<CloudTask> = {}): CloudTask {
  return { id: 'local-codex', provider: 'codex', credentialContextId: 'fixture-context', verifiedAccountRef: null,
    title: 'Review empty state', prompt: 'PRIVATE original prompt', source: { environmentId: 'env_fixture', branch: 'feature/test' },
    providerTaskId: 'task_fixture', providerUrl: 'https://chatgpt.com/codex/tasks/task_fixture', identityEvidence: 'provider_receipt',
    deliveryState: 'accepted', remoteState: 'result_ready', rawState: 'ready', observationState: 'stale',
    lastObservedAt: '2026-09-13T01:00:00Z', providerUpdatedAt: null, createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T01:00:00Z',
    revision: 1, archivedAt: null, issue: null, ...overrides }
}
function fixtureOperation(task: CloudTask, overrides: Partial<CloudOperation> = {}): CloudOperation {
  return { id: 'create-op', taskId: task.id, kind: 'create', idempotencyKey: 'initial-key', requestHash: 'fixture-hash',
    payload: { provider: task.provider, credentialContextId: task.credentialContextId, prompt: task.prompt, source: task.source, accountConfirmed: true }, state: 'accepted', ownerId: null,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
    receipt: { providerTaskId: task.providerTaskId!, providerUrl: task.providerUrl!, evidence: 'provider_receipt' }, issue: null, ...overrides }
}
function fixtureApi(initial = fixtureTask()): CloudTasksApi {
  const capabilities = { create: true, link: true, list: true, inspect: true, sendMessage: false, diff: true, accountIdentity: false }
  const providers: CloudProviderInfo[] = [
    { id: 'codex', label: 'Codex Cloud', homeUrl: 'https://chatgpt.com/codex', readiness: 'ready', reason: 'Synthetic verified fixture', version: 'fixture', credentialContextId: 'fixture-context', verifiedAccountRef: null, capabilities },
    { id: 'claude', label: 'Claude Code Cloud', homeUrl: 'https://claude.ai/code', readiness: 'missing_cli', reason: 'Claude CLI not installed.', version: null, credentialContextId: 'fixture-context', verifiedAccountRef: null,
      capabilities: { ...capabilities, create: false, list: false, inspect: false, diff: false, sendMessage: true } },
  ]
  const records = new Map<string, CloudTaskDetail>([[initial.id, { task: initial, operations: [fixtureOperation(initial, { state: initial.deliveryState })] }]])
  return {
    providers: vi.fn(async () => ({ installationId: 'ui-installation', providers })),
    list: vi.fn(async () => [...records.values()].map(({ task: { prompt: _prompt, ...task } }) => task)),
    get: vi.fn(async (id) => records.get(id)!), refresh: vi.fn(async (id) => records.get(id)!),
    create: vi.fn(async (input, key) => {
      const task = fixtureTask({ id: 'created-task', provider: input.provider, source: input.source, prompt: input.prompt,
        title: input.title ?? 'New task', providerTaskId: null, providerUrl: null, identityEvidence: null, deliveryState: 'prepared', remoteState: 'unknown', observationState: 'unavailable' })
      const operation = fixtureOperation(task, { id: 'created-op', idempotencyKey: key, state: 'prepared', receipt: null, payload: input })
      records.set(task.id, { task, operations: [operation] })
      return { task, operation, reused: false }
    }),
    link: vi.fn(async (input, key, id) => {
      const task = fixtureTask({ ...records.get(id ?? '')?.task, id: id ?? 'linked-task', provider: input.provider,
        providerTaskId: input.providerTaskId, identityEvidence: 'user_link', observationState: 'unavailable', revision: 2 })
      const operation = fixtureOperation(task, { id: 'link-op', idempotencyKey: key, kind: 'link', payload: input,
        receipt: { providerTaskId: input.providerTaskId, providerUrl: task.providerUrl!, evidence: 'user_link' } })
      records.set(task.id, { task, operations: [...(records.get(task.id)?.operations ?? []), operation] })
      return { task, operation, reused: false }
    }),
    message: vi.fn(async (id, input, key) => {
      const detail = records.get(id)!
      const operation = fixtureOperation(detail.task, { id: 'message-op', idempotencyKey: key, kind: 'message', payload: input, state: 'delivery_unknown', receipt: null })
      records.set(id, { task: detail.task, operations: [...detail.operations, operation] })
      return { task: detail.task, operation, reused: false }
    }),
    patch: vi.fn(async (id, patch) => {
      const previous = records.get(id)!
      const detail = { ...previous, task: { ...previous.task, ...patch, revision: previous.task.revision + 1 } }
      records.set(id, detail)
      return detail
    }),
    diff: vi.fn(async () => ({ text: '+<img src=x onerror="alert(1)">\n-<script>attack</script>', truncated: true })),
    operation: vi.fn(async (id) => [...records.values()].flatMap((record) => record.operations).find((op) => op.id === id)!), byKey: vi.fn(async () => null),
    resumeOperation: vi.fn(async (id) => {
      const previous = [...records.values()].find((record) => record.operations.some((op) => op.id === id))!
      const operation = { ...previous.operations.find((op) => op.id === id)!, state: 'dispatching' as const }
      const task = { ...previous.task, revision: previous.task.revision + 1 }
      records.set(task.id, { task, operations: previous.operations.map((op) => op.id === id ? operation : op) })
      return { task, operation, reused: true }
    }),
  }
}
beforeEach(() => { localStorage.clear(); vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function openCreate(api: CloudTasksApi) {
  render(<CloudTasksSection api={api} />)
  const button = screen.getByRole('button', { name: '+ New task' })
  await waitFor(() => expect(button).toBeEnabled())
  button.focus(); fireEvent.click(button)
  return within(screen.getByRole('dialog'))
}
function fillCreate(dialog: ReturnType<typeof within>) {
  fireEvent.change(dialog.getByLabelText('Existing environment ID'), { target: { value: 'manual-environment' } })
  fireEvent.change(dialog.getByLabelText('Requested branch'), { target: { value: 'branch/manual' } })
  fireEvent.change(dialog.getByLabelText('Task prompt'), { target: { value: 'A specific private task' } })
  fireEvent.click(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ }))
}

describe('cloud list/detail and integration exports', () => {
  it('works without tmux, shares list reads with HUD, and demand-displays the prompt on selection', async () => {
    const api = fixtureApi()
    const select = vi.fn()
    render(<><CloudTasksSection api={api} /><CloudTasksHud api={api} onSelectTask={select} /></>)
    const list = within(screen.getByRole('region', { name: 'Saved cloud tasks' }))
    const card = await list.findByRole('button', { name: /Codex: Review empty state. Result ready/ })
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.get).not.toHaveBeenCalled()
    expect(screen.queryByText('PRIVATE original prompt')).not.toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('region', { name: 'Cloud tasks HUD' })).getByRole('button', { name: /Review empty state/ }))
    expect(select).toHaveBeenCalledWith('local-codex')
    fireEvent.click(card)
    expect(await screen.findByText('PRIVATE original prompt')).toBeInTheDocument()
    expect(screen.getByText(/Ready for review, not proof/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Review empty state' })).toHaveFocus()
    const content = document.querySelector('.cloud-content')!
    expect(content).toHaveClass('cloud-content--detail-open')
    const focus = vi.spyOn(card, 'focus').mockImplementation(() => {
      // Mirrors the browser failure: focus must not be attempted while the narrow list is still hidden.
      expect(content).not.toHaveClass('cloud-content--detail-open')
      HTMLElement.prototype.focus.call(card)
    })
    fireEvent.click(screen.getByRole('button', { name: /Back to tasks/ }))
    expect(content).not.toHaveClass('cloud-content--detail-open')
    expect(card).toHaveFocus()
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('keeps stale details and safe provider links usable when daemon reads fail', async () => {
    const api = fixtureApi()
    render(<CloudTasksSection api={api} selectedTaskId="local-codex" />)
    await screen.findByText('PRIVATE original prompt')
    vi.mocked(api.providers).mockRejectedValue(new Error('offline'))
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    expect(screen.getByText('PRIVATE original prompt')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in Codex ↗' })).toHaveAttribute('href', 'https://chatgpt.com/codex/tasks/task_fixture')
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '+ New task' })).toBeDisabled()
    expect(screen.getByText(/Daemon unavailable/)).toBeInTheDocument()
  })

  it('edits local title and archives/unarchives without changing remote execution', async () => {
    const api = fixtureApi()
    render(<CloudTasksSection api={api} selectedTaskId="local-codex" />)
    const input = await screen.findByLabelText('Local title')
    fireEvent.change(input, { target: { value: 'Renamed locally' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save title' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('local-codex', { title: 'Renamed locally' }))
    await screen.findByRole('heading', { name: 'Renamed locally' })
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await screen.findByRole('button', { name: 'Unarchive' })
    expect(within(screen.getByRole('region', { name: 'Saved cloud tasks' })).queryByRole('button', { name: /Renamed locally/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Archived'))
    expect(screen.getByRole('button', { name: /Codex: Renamed locally.*Archived/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }))
    await screen.findByRole('button', { name: 'Archive' })
    expect(api.patch).toHaveBeenLastCalledWith('local-codex', { archivedAt: null })
    expect(api.create).not.toHaveBeenCalled()
  })

  it('loads diff only on demand, escapes markup, and validates provider links', async () => {
    const api = fixtureApi(fixtureTask({ providerUrl: 'javascript:alert(1)' }))
    render(<CloudTasksSection api={api} selectedTaskId="local-codex" />)
    await screen.findByText('PRIVATE original prompt')
    expect(api.diff).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Open in Codex ↗' })).toHaveAttribute('href', 'https://chatgpt.com/codex')
    fireEvent.click(screen.getByRole('button', { name: 'Load diff' }))
    expect(await screen.findByLabelText('Unified diff')).toHaveTextContent('<img src=x onerror="alert(1)">')
    expect(document.querySelector('img, script')).toBeNull()
    expect(screen.getByText(/Diff truncated at/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Open full result/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /apply|merge|cancel task/i })).not.toBeInTheDocument()
  })

  it('preserves accepted Claude state while an uncertain follow-up requires separate evidence', async () => {
    const task = fixtureTask({ id: 'local-claude', provider: 'claude', providerTaskId: 'session_fixture', providerUrl: 'https://claude.ai/code/session_fixture', remoteState: 'unknown' })
    const api = fixtureApi(task)
    const available = await api.providers()
    available.providers[1].readiness = 'ready'
    render(<CloudTasksSection api={api} selectedTaskId={task.id} />)
    const message = await screen.findByLabelText('Message')
    expect(screen.getByRole('button', { name: 'Send new message' })).toBeDisabled()
    fireEvent.change(message, { target: { value: 'Check the edge case' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /owns this session/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send new message' }))
    await screen.findByText(/This message remains delivery unknown/)
    expect(api.message).toHaveBeenCalledWith(task.id, { credentialContextId: 'fixture-context', message: 'Check the edge case', accountConfirmed: true }, expect.any(String))
    expect(screen.getByText('Follow-up · Delivery unknown')).toBeInTheDocument()
    expect(screen.getAllByText('Submitted · live status in Claude').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Send new message' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Load diff' })).not.toBeInTheDocument()
    expect(api.refresh).not.toHaveBeenCalled()
  })
})

describe('cloud task dialog and browser-intent UX', () => {
  it('traps keyboard and programmatic focus, closes on Escape, and restores the opener', async () => {
    const dialog = await openCreate(fixtureApi())
    const root = screen.getByRole('dialog')
    const first = dialog.getByRole('button', { name: 'Close cloud task dialog' })
    expect(first).toHaveFocus()
    expect(root).toHaveAttribute('aria-modal', 'true')
    expect(root).toHaveAttribute('data-native-terminal-occluder')
    first.focus(); fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(first).toHaveFocus()
    screen.getByRole('heading', { name: 'Select a cloud task' }).focus()
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ New task' })).toHaveFocus()
  })

  it('disables unverified Claude creation with precise reason but links an existing session without the CLI', async () => {
    const api = fixtureApi()
    const dialog = await openCreate(api)
    fireEvent.change(dialog.getByLabelText('Provider'), { target: { value: 'claude' } })
    expect(dialog.getByText(new RegExp('receipt/detach'))).toHaveTextContent(CLAUDE_CREATE_DISABLED_REASON)
    expect(dialog.getByRole('button', { name: 'Record cloud task' })).toBeDisabled()
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Link existing' }))
    const linkDialog = within(screen.getByRole('dialog'))
    fireEvent.change(linkDialog.getByLabelText('Provider'), { target: { value: 'claude' } })
    fireEvent.change(linkDialog.getByLabelText('Provider task or session ID'), { target: { value: 'session_known' } })
    fireEvent.click(linkDialog.getByRole('checkbox', { name: /confirm the current CLI account/ }))
    expect(linkDialog.getByRole('button', { name: 'Link identity only' })).toBeEnabled()
    fireEvent.click(linkDialog.getByRole('button', { name: 'Link identity only' }))
    await waitFor(() => expect(api.link).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', credentialContextId: 'fixture-context', providerTaskId: 'session_known', accountConfirmed: true }), expect.any(String), undefined))
    expect(api.create).not.toHaveBeenCalled()
  })

  it('submits manual Codex environment/ref once, displays source summary, and labels 202 as recorded locally', async () => {
    const api = fixtureApi()
    const dialog = await openCreate(api)
    fillCreate(dialog)
    expect(dialog.getByText(/manual-environment · branch\/manual/)).toBeInTheDocument()
    const submit = dialog.getByRole('button', { name: 'Record cloud task' })
    fireEvent.click(submit); fireEvent.click(submit)
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', credentialContextId: 'fixture-context', prompt: 'A specific private task', source: { environmentId: 'manual-environment', branch: 'branch/manual' }, accountConfirmed: true }), expect.any(String))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getAllByText('Recorded locally').length).toBeGreaterThan(0)
    expect(screen.getByText(/A local acknowledgement is not cloud acceptance/)).toBeInTheDocument()
  })

  it('re-enters an unknown reload draft under its original key after explicit digest-matching reconfirmation', async () => {
    const input = { provider: 'codex' as const, credentialContextId: 'fixture-context', prompt: 'A specific private task', source: { environmentId: 'manual-environment', branch: 'branch/manual' }, accountConfirmed: true }
    localStorage.setItem(CLOUD_PENDING_STORAGE_KEY, JSON.stringify([{ key: 'lost-key', digest: await digestCloudIntent({ kind: 'create', input }), installationId: 'ui-installation' }]))
    const api = fixtureApi()
    render(<CloudTasksSection api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Re-enter original intent…' }))
    const dialog = within(screen.getByRole('dialog'))
    await waitFor(() => expect(api.byKey).toHaveBeenCalledWith('lost-key'))
    expect(screen.getByText(/Unknown draft/)).toBeInTheDocument()
    expect(dialog.getByLabelText('Task prompt')).toHaveValue('')
    expect(dialog.getByRole('button', { name: 'Reconfirm and recover original intent' })).toBeDisabled()
    fillCreate(dialog)
    expect(api.create).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('button', { name: 'Reconfirm and recover original intent' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    expect(api.create).toHaveBeenCalledWith(input, 'lost-key')
  })

  it('blocks a mismatched re-entry until a new intent is explicitly acknowledged', async () => {
    localStorage.setItem(CLOUD_PENDING_STORAGE_KEY, JSON.stringify([{ key: 'lost-key', digest: 'different-draft-digest', installationId: 'ui-installation' }]))
    const api = fixtureApi()
    render(<CloudTasksSection api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Re-enter original intent…' }))
    const dialog = within(screen.getByRole('dialog'))
    fillCreate(dialog)
    fireEvent.click(dialog.getByRole('button', { name: 'Reconfirm and recover original intent' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('does not match')
    expect(api.create).not.toHaveBeenCalled()
    expect(dialog.getByLabelText('Task prompt')).toBeEnabled()
    fireEvent.click(dialog.getByRole('checkbox', { name: /explicitly authorize a new intent/ }))
    fireEvent.click(dialog.getByRole('button', { name: 'Explicitly record new intent' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.create).mock.calls[0][1]).not.toBe('lost-key')
    expect(JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!).some((entry: { key: string }) => entry.key === 'lost-key')).toBe(true)
  })

  it('re-enters a message against the original local target, not a new create', async () => {
    const task = fixtureTask({ id: 'local-claude', provider: 'claude', providerTaskId: 'session_fixture', providerUrl: 'https://claude.ai/code/session_fixture' })
    const input = { credentialContextId: 'fixture-context', message: 'Original message', accountConfirmed: true }
    localStorage.setItem(CLOUD_PENDING_STORAGE_KEY, JSON.stringify([{ key: 'message-lost', digest: await digestCloudIntent({ kind: 'message', taskId: task.id, input }), installationId: 'ui-installation' }]))
    const api = fixtureApi(task)
    ;(await api.providers()).providers[1].readiness = 'ready'
    render(<CloudTasksSection api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Re-enter original intent…' }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('Original operation'), { target: { value: 'message' } })
    fireEvent.change(dialog.getByLabelText('Original local task target'), { target: { value: task.id } })
    fireEvent.change(dialog.getByLabelText('Message'), { target: { value: input.message } })
    fireEvent.click(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ }))
    fireEvent.click(dialog.getByRole('button', { name: 'Reconfirm and recover original intent' }))
    await waitFor(() => expect(api.message).toHaveBeenCalledWith(task.id, input, 'message-lost'))
    expect(api.create).not.toHaveBeenCalled()
  })

  it('invalidates creation confirmation when provider context changes while the dialog is open', async () => {
    const api = fixtureApi()
    const dialog = await openCreate(api)
    fillCreate(dialog)
    const available = await api.providers()
    available.providers[0] = { ...available.providers[0], credentialContextId: 'replacement-context' }
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    expect(dialog.getByRole('alert')).toHaveTextContent('Provider account/context changed')
    expect(dialog.getByRole('button', { name: 'Record cloud task' })).toBeDisabled()
    fireEvent.click(dialog.getByRole('button', { name: 'Record cloud task' }))
    expect(api.create).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ }))
    fireEvent.click(dialog.getByRole('button', { name: 'Record cloud task' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ credentialContextId: 'replacement-context' }), expect.any(String)))
  })

  it('offers explicit source/account-confirmed resume only for prepared operations', async () => {
    const task = fixtureTask({ deliveryState: 'prepared', providerTaskId: null, providerUrl: null, identityEvidence: null })
    const api = fixtureApi(task)
    render(<CloudTasksSection api={api} selectedTaskId={task.id} />)
    const form = within(await screen.findByRole('form', { name: 'Resume prepared create' }))
    expect(form.getByText(/Original source:/)).toHaveTextContent('env_fixture')
    expect(form.getByRole('button', { name: 'Resume prepared operation' })).toBeDisabled()
    fireEvent.click(form.getByRole('checkbox', { name: /reconfirm this original request/ }))
    fireEvent.click(form.getByRole('button', { name: 'Resume prepared operation' }))
    await waitFor(() => expect(api.resumeOperation).toHaveBeenCalledWith('create-op', { credentialContextId: 'fixture-context', accountConfirmed: true }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume prepared operation' })).not.toBeInTheDocument())
    expect(api.create).not.toHaveBeenCalled()
  })

  it('renders conflicting late receipt identity and safe URL independently of the linked task identity', async () => {
    const task = fixtureTask({ providerTaskId: 'task_linked', providerUrl: 'https://chatgpt.com/codex/tasks/task_linked', identityEvidence: 'user_link' })
    const op = fixtureOperation(task, { state: 'delivery_unknown', receipt: { providerTaskId: 'task_late', providerUrl: 'https://chatgpt.com/codex/tasks/task_late', evidence: 'provider_receipt' } })
    const api = fixtureApi(task)
    vi.mocked(api.get).mockResolvedValue({ task, operations: [op] })
    vi.mocked(api.refresh).mockResolvedValue({ task, operations: [op] })
    render(<CloudTasksSection api={api} selectedTaskId={task.id} />)
    expect(await screen.findByText('task_late')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in Codex ↗' })).toHaveAttribute('href', task.providerUrl)
    expect(screen.getByRole('link', { name: 'Open operation receipt in Codex ↗' })).toHaveAttribute('href', op.receipt!.providerUrl)
    expect(screen.getByText(/Both identities are retained/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume prepared operation' })).not.toBeInTheDocument()
  })

  it('freezes a lost-response form and exposes same-intent recovery after closing', async () => {
    const api = fixtureApi()
    vi.mocked(api.create).mockRejectedValue(new Error('lost 202'))
    const dialog = await openCreate(api)
    fillCreate(dialog)
    fireEvent.click(dialog.getByRole('button', { name: 'Record cloud task' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Delivery unknown')
    expect(dialog.getByLabelText('Task prompt')).toBeDisabled()
    expect(dialog.getByRole('button', { name: 'Record cloud task' })).toBeDisabled()
    fireEvent.click(dialog.getByRole('button', { name: 'Close cloud task dialog' }))
    expect(screen.getByRole('button', { name: 'Recover / retry same intent' })).toBeEnabled()
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)).not.toContain('private task')
  })
})

describe('bounded diff rendering', () => {
  it('enforces line and UTF-8 byte limits even for a malformed oversized server response', () => {
    const lines = boundCloudDiff({ text: Array(5_002).fill('+line').join('\n'), truncated: false })
    expect(lines.truncated).toBe(true)
    expect(lines.text.split('\n')).toHaveLength(5_000)
    const bytes = boundCloudDiff({ text: '界'.repeat(100_000), truncated: false })
    expect(bytes.truncated).toBe(true)
    expect(new TextEncoder().encode(bytes.text).length).toBeLessThanOrEqual(256 * 1024)
  })
})
