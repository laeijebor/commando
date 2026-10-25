// @vitest-environment jsdom
/// <reference types="node" />
import { webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_PROMPT_LIMIT, cloudConnectionKey, type CloudOperation, type CloudProviderInfo, type CloudTask, type CloudTaskDetail } from '../shared/cloud-tasks'
import { CloudTasksHttpError, type CloudTasksApi } from './cloudTasksApi'
import { CloudTasksHud, CloudTasksSection } from './CloudTasksSection'
import { CLAUDE_CREATE_DISABLED_REASON, CloudTaskCreateDialog } from './CloudTaskCreateDialog'
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
function fixtureApi(initial = fixtureTask(), extra: CloudTask[] = []): CloudTasksApi {
  const capabilities = { create: true, link: true, list: true, inspect: true, sendMessage: false, diff: true, accountIdentity: false }
  const providers: CloudProviderInfo[] = [
    { id: 'codex', label: 'Codex Cloud', homeUrl: 'https://chatgpt.com/codex', readiness: 'ready', reason: 'Synthetic verified fixture', version: 'fixture', credentialContextId: 'fixture-context', verifiedAccountRef: null, capabilities },
    { id: 'claude', label: 'Claude Code Cloud', homeUrl: 'https://claude.ai/code', readiness: 'missing_cli', reason: 'Claude CLI not installed.', version: null, credentialContextId: 'fixture-context', verifiedAccountRef: null,
      capabilities: { ...capabilities, create: false, list: false, inspect: false, diff: false, sendMessage: true } },
  ]
  const records = new Map<string, CloudTaskDetail>([initial, ...extra].map((task) => [task.id, { task, operations: [fixtureOperation(task, { state: task.deliveryState })] }]))
  return {
    providers: vi.fn(async () => ({ installationId: 'ui-installation', providers })),
    list: vi.fn(async () => [...records.values()].map(({ task: { prompt: _prompt, ...task } }) => task)),
    get: vi.fn(async (id) => records.get(id)!), refresh: vi.fn(async (id) => records.get(id)!),
    create: vi.fn(async (input, key) => {
      const task = fixtureTask({ id: 'created-task', provider: input.provider, credentialContextId: input.credentialContextId, source: input.source, prompt: input.prompt,
        title: input.title ?? 'New task', providerTaskId: null, providerUrl: null, identityEvidence: null, deliveryState: 'prepared', remoteState: 'unknown', observationState: 'unavailable' })
      const operation = fixtureOperation(task, { id: 'created-op', idempotencyKey: key, state: 'prepared', receipt: null, payload: input })
      records.set(task.id, { task, operations: [operation] })
      return { task, operation, reused: false }
    }),
    link: vi.fn(async (input, key, id) => {
      const task = fixtureTask({ ...records.get(id ?? '')?.task, id: id ?? 'linked-task', provider: input.provider, credentialContextId: input.credentialContextId,
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
    const card = await list.findByRole('button', { name: /Codex Cloud: Review empty state. Result ready/ })
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
    expect(screen.getByRole('button', { name: /Codex Cloud: Renamed locally.*Archived/ })).toBeInTheDocument()
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
  it('blocks a multibyte create prompt by UTF-8 bytes and allows exactly the byte limit', async () => {
    const api = fixtureApi()
    const dialog = await openCreate(api)
    fillCreate(dialog)
    const prompt = dialog.getByLabelText('Task prompt')
    const submit = dialog.getByRole('button', { name: 'Record cloud task' })
    fireEvent.change(prompt, { target: { value: '日'.repeat(6_000) } })
    fireEvent.click(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ }))
    expect(prompt).toHaveAttribute('aria-invalid', 'true')
    expect(prompt).toHaveAccessibleDescription(/16,384-byte UTF-8 limit/)
    expect(dialog.getByRole('alert')).toHaveTextContent('Task prompt exceeds')
    expect(submit).toBeDisabled()
    fireEvent.submit(submit.closest('form')!)
    expect(api.create).not.toHaveBeenCalled()
    // 5,461 Japanese characters plus one ASCII byte = 16,384 bytes.
    const boundary = '日'.repeat(Math.floor(CLOUD_PROMPT_LIMIT / 3)) + 'a'.repeat(CLOUD_PROMPT_LIMIT % 3)
    fireEvent.change(prompt, { target: { value: boundary } })
    fireEvent.click(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ }))
    expect(prompt).toHaveAttribute('aria-invalid', 'false')
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument()
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ prompt: boundary }), expect.any(String)))
  })

  it('keeps a definitively rejected form editable and submits its corrected draft without duplicate-risk confirmation', async () => {
    const api = fixtureApi()
    vi.mocked(api.create).mockRejectedValueOnce(new CloudTasksHttpError(400, 'invalid_request', 'Invalid prompt'))
    const dialog = await openCreate(api)
    fillCreate(dialog)
    fireEvent.click(dialog.getByRole('button', { name: 'Record cloud task' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Invalid prompt')
    expect(dialog.getByRole('alert')).not.toHaveTextContent(/unknown|recover/)
    expect(dialog.getByLabelText('Task prompt')).toBeEnabled()
    const originalKey = vi.mocked(api.create).mock.calls[0][1]
    expect(cloudTaskStoreFor(api).getSnapshot().pending).toEqual([])
    fireEvent.change(dialog.getByLabelText('Task prompt'), { target: { value: 'Corrected draft' } })
    fireEvent.click(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ }))
    expect(dialog.queryByRole('checkbox', { name: /earlier intent|duplicates|new intent/i })).not.toBeInTheDocument()
    fireEvent.click(dialog.getByRole('button', { name: 'Record cloud task' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.create).mock.calls[1][1]).not.toBe(originalKey)
    expect(vi.mocked(api.create).mock.calls[1][0].prompt).toBe('Corrected draft')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('blocks a multibyte follow-up by UTF-8 bytes before creating an intent', async () => {
    const task = fixtureTask({ id: 'local-claude', provider: 'claude', providerTaskId: 'session_fixture', providerUrl: 'https://claude.ai/code/session_fixture' })
    const api = fixtureApi(task)
    const providers = await api.providers()
    providers.providers[1].readiness = 'ready'
    render(<CloudTasksSection api={api} selectedTaskId={task.id} />)
    const message = await screen.findByLabelText('Message')
    const submit = screen.getByRole('button', { name: 'Send new message' })
    fireEvent.change(message, { target: { value: '😀'.repeat(CLOUD_PROMPT_LIMIT / 4 + 1) } })
    fireEvent.click(screen.getByRole('checkbox', { name: /owns this session/ }))
    expect(message).toHaveAttribute('aria-invalid', 'true')
    expect(message).toHaveAccessibleDescription(/16,384-byte UTF-8 limit/)
    expect(submit).toBeDisabled()
    fireEvent.submit(submit.closest('form')!)
    expect(api.message).not.toHaveBeenCalled()
    expect(cloudTaskStoreFor(api).getSnapshot().pending).toEqual([])
    fireEvent.change(message, { target: { value: '😀'.repeat(CLOUD_PROMPT_LIMIT / 4) } })
    expect(message).toHaveAttribute('aria-invalid', 'false')
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    await waitFor(() => expect(api.message).toHaveBeenCalledOnce())
  })

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
    fireEvent.change(dialog.getByLabelText('Connection'), { target: { value: cloudConnectionKey('claude', 'fixture-context') } })
    expect(dialog.getByText(new RegExp('receipt/detach'))).toHaveTextContent(CLAUDE_CREATE_DISABLED_REASON)
    expect(dialog.getByRole('button', { name: 'Record cloud task' })).toBeDisabled()
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Link existing' }))
    const linkDialog = within(screen.getByRole('dialog'))
    fireEvent.change(linkDialog.getByLabelText('Connection'), { target: { value: cloudConnectionKey('claude', 'fixture-context') } })
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
    expect(dialog.getByLabelText('Connection')).toHaveValue(cloudConnectionKey('codex', 'fixture-context'))
    expect(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ })).toBeDisabled()
    fireEvent.change(dialog.getByLabelText('Connection'), { target: { value: cloudConnectionKey('codex', 'replacement-context') } })
    fillCreate(dialog)
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

function profileTask(context: string, overrides: Partial<CloudTask> = {}): CloudTask {
  return fixtureTask({ id: `local-${context}`, provider: 'claude', credentialContextId: context,
    title: 'Same task title', providerTaskId: 'session_shared', providerUrl: 'https://claude.ai/code/session_shared',
    remoteState: 'unknown', observationState: 'unavailable', ...overrides })
}
async function profileFixture(initial = fixtureTask(), extra: CloudTask[] = []) {
  const api = fixtureApi(initial, extra)
  const response = await api.providers()
  const codex = response.providers[0]
  const team: CloudProviderInfo = { ...response.providers[1], label: 'Claude Team', credentialContextId: 'claude:team',
    readiness: 'ready', reason: 'Synthetic Team evidence only', capabilities: { ...response.providers[1].capabilities, create: true, sendMessage: true } }
  const max: CloudProviderInfo = { ...team, label: 'Claude Max', credentialContextId: 'claude:max', readiness: 'unverified',
    reason: 'Max capability not verified', capabilities: { ...team.capabilities, create: false, sendMessage: false } }
  // Claude deliberately comes first: a unique Codex connection is still the initial default.
  response.providers.splice(0, response.providers.length, team, max, codex)
  return { api, response, team, max, codex }
}

describe('multiple provider connections', () => {
  it('offers exact Team/Max/Codex keys and gates creation independently while clearing switched confirmation', async () => {
    const { api, team, max, codex } = await profileFixture()
    const dialog = await openCreate(api)
    const select = dialog.getByLabelText('Connection')
    expect(select).toHaveValue(cloudConnectionKey(codex.id, codex.credentialContextId))
    for (const info of [team, max, codex]) expect(dialog.getByRole('option', { name: info.label })).toHaveValue(cloudConnectionKey(info.id, info.credentialContextId))
    expect(select.querySelector('option[value="claude"]')).toBeNull()
    fireEvent.change(select, { target: { value: cloudConnectionKey(team.id, team.credentialContextId) } })
    fireEvent.change(dialog.getByLabelText('Existing checkout path'), { target: { value: '/disposable/source' } })
    fireEvent.change(dialog.getByLabelText('Requested branch'), { target: { value: 'main' } })
    fireEvent.change(dialog.getByLabelText('Task prompt'), { target: { value: 'Synthetic task' } })
    fireEvent.click(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ }))
    expect(dialog.getByRole('button', { name: 'Record cloud task' })).toBeEnabled()
    fireEvent.change(select, { target: { value: cloudConnectionKey(max.id, max.credentialContextId) } })
    expect(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ })).not.toBeChecked()
    expect(dialog.getByRole('button', { name: 'Record cloud task' })).toBeDisabled()
    expect(dialog.getByText(/Max capability not verified/)).toBeInTheDocument()
    expect(api.create).not.toHaveBeenCalled()
  })

  it.each(['claude:team', 'claude:max'])('links through exactly %s and preserves explicit selection/confirmation on reorder', async (context) => {
    const { api, response } = await profileFixture()
    render(<CloudTasksSection api={api} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Link existing' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Link existing' }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('Connection'), { target: { value: cloudConnectionKey('claude', context) } })
    fireEvent.change(dialog.getByLabelText('Provider task or session ID'), { target: { value: 'session_shared' } })
    fireEvent.click(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ }))
    response.providers.reverse()
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    expect(dialog.getByLabelText('Connection')).toHaveValue(cloudConnectionKey('claude', context))
    expect(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ })).toBeChecked()
    fireEvent.click(dialog.getByRole('button', { name: 'Link identity only' }))
    await waitFor(() => expect(api.link).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', credentialContextId: context, providerTaskId: 'session_shared' }), expect.any(String), undefined))
  })

  it('retains a removed selected connection as unavailable instead of selecting the remaining Claude profile', async () => {
    const { api, response, team, codex } = await profileFixture()
    const dialog = await openCreate(api)
    fireEvent.change(dialog.getByLabelText('Connection'), { target: { value: cloudConnectionKey('claude', 'claude:max') } })
    fireEvent.click(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ }))
    response.providers.splice(0, response.providers.length, team, codex)
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    expect(dialog.getByLabelText('Connection')).toHaveValue(cloudConnectionKey('claude', 'claude:max'))
    expect(dialog.getByRole('option', { name: 'Claude · claude:max (unavailable)' })).toBeDisabled()
    expect(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ })).toBeDisabled()
    expect(dialog.getByRole('button', { name: 'Record cloud task' })).toBeDisabled()
    expect(api.create).not.toHaveBeenCalled()
  })

  it('distinguishes same-family/same-title/same-remote-ID tasks in the list, heading context, and HUD', async () => {
    const maxTask = profileTask('claude:max')
    const teamTask = profileTask('claude:team')
    const { api, response, team, codex } = await profileFixture(maxTask, [teamTask])
    render(<><CloudTasksSection api={api} selectedTaskId={maxTask.id} /><CloudTasksHud api={api} onSelectTask={vi.fn()} /></>)
    const list = within(screen.getByRole('region', { name: 'Saved cloud tasks' }))
    const hud = within(screen.getByRole('region', { name: 'Cloud tasks HUD' }))
    expect(await list.findByRole('button', { name: /Claude Max: Same task title/ })).toBeInTheDocument()
    expect(list.getByRole('button', { name: /Claude Team: Same task title/ })).toBeInTheDocument()
    expect(hud.getByRole('button', { name: /Claude Max: Same task title/ })).toHaveTextContent('Claude Max')
    expect(hud.getByRole('button', { name: /Claude Team: Same task title/ })).toHaveTextContent('Claude Team')
    expect(within(screen.getByRole('article', { name: 'Selected cloud task' })).getByText('Claude Max')).toBeInTheDocument()
    response.providers.splice(0, response.providers.length, team, codex)
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    expect(list.getByRole('button', { name: /Claude · claude:max: Same task title/ })).toBeInTheDocument()
    expect(hud.getByRole('button', { name: /Claude · claude:max: Same task title/ })).toBeInTheDocument()
    expect(screen.getByText(/another profile will not be substituted/)).toHaveTextContent('claude:max')
    expect(screen.getByRole('link', { name: 'Open in Claude ↗' })).toHaveAttribute('href', maxTask.providerUrl)
  })

  it.each(['claude:team', 'claude:max'])('messages a persisted %s task using its context regardless of provider order', async (context) => {
    const task = profileTask(context)
    const { api, response, max } = await profileFixture(task)
    max.readiness = 'ready'; max.capabilities.sendMessage = true
    render(<CloudTasksSection api={api} selectedTaskId={task.id} />)
    const message = await screen.findByLabelText('Message')
    fireEvent.change(message, { target: { value: 'Exact-profile follow-up' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /owns this session/ }))
    response.providers.reverse()
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    expect(screen.getByRole('checkbox', { name: /owns this session/ })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Send new message' }))
    await waitFor(() => expect(api.message).toHaveBeenCalledWith(task.id, { credentialContextId: context, message: 'Exact-profile follow-up', accountConfirmed: true }, expect.any(String)))
  })

  it('does not inherit enabled Team messaging for a disabled or missing Max task', async () => {
    const task = profileTask('claude:max')
    const { api, response, team, codex } = await profileFixture(task)
    render(<CloudTasksSection api={api} selectedTaskId={task.id} />)
    await screen.findByText('PRIVATE original prompt')
    expect(screen.queryByRole('button', { name: 'Send new message' })).not.toBeInTheDocument()
    response.providers.splice(0, response.providers.length, team, codex)
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    expect(screen.queryByRole('button', { name: 'Send new message' })).not.toBeInTheDocument()
    expect(api.message).not.toHaveBeenCalled()
  })

  it('keeps recovery linking locked to a persisted missing Max connection', async () => {
    const task = profileTask('claude:max', { deliveryState: 'delivery_unknown' })
    const { api, response, team, codex } = await profileFixture(task)
    render(<CloudTasksSection api={api} selectedTaskId={task.id} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Link known task identity' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByLabelText('Connection')).toHaveValue(cloudConnectionKey('claude', 'claude:max'))
    expect(dialog.getByLabelText('Connection')).toBeDisabled()
    fireEvent.change(dialog.getByLabelText('Provider task or session ID'), { target: { value: 'session_known' } })
    fireEvent.click(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ }))
    response.providers.splice(0, response.providers.length, team, codex)
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    expect(dialog.getByRole('button', { name: 'Link identity only' })).toBeDisabled()
    expect(dialog.getByLabelText('Connection')).toHaveValue(cloudConnectionKey('claude', 'claude:max'))
    expect(api.link).not.toHaveBeenCalled()
  })

  it('locks message re-entry to the original Max tuple and preserves its existing digest/key format', async () => {
    const task = profileTask('claude:max')
    const input = { credentialContextId: 'claude:max', message: 'Original profile-bound message', accountConfirmed: true }
    const digest = await digestCloudIntent({ kind: 'message', taskId: task.id, input })
    localStorage.setItem(CLOUD_PENDING_STORAGE_KEY, JSON.stringify([{ key: 'max-key', digest, installationId: 'ui-installation' }]))
    const { api, response, team, max, codex } = await profileFixture(task)
    max.readiness = 'ready'; max.capabilities.sendMessage = true
    render(<CloudTasksSection api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Re-enter original intent…' }))
    const dialog = within(screen.getByRole('dialog'))
    fireEvent.change(dialog.getByLabelText('Original operation'), { target: { value: 'message' } })
    fireEvent.change(dialog.getByLabelText('Original local task target'), { target: { value: task.id } })
    expect(dialog.getByLabelText('Connection')).toHaveValue(cloudConnectionKey('claude', 'claude:max'))
    expect(dialog.getByLabelText('Connection')).toBeDisabled()
    fireEvent.change(dialog.getByLabelText('Message'), { target: { value: input.message } })
    fireEvent.click(dialog.getByRole('checkbox', { name: /confirm the current CLI account/ }))
    response.providers.splice(0, response.providers.length, team, codex)
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    expect(dialog.getByRole('button', { name: 'Reconfirm and recover original intent' })).toBeDisabled()
    expect(api.message).not.toHaveBeenCalled()
    response.providers.push(max)
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    // Reconfirm explicitly after restoring the connection, regardless of the retained checkbox state.
    const confirmation = dialog.getByRole('checkbox', { name: /confirm the current CLI account/ })
    if ((confirmation as HTMLInputElement).checked) fireEvent.click(confirmation)
    fireEvent.click(confirmation)
    fireEvent.click(dialog.getByRole('button', { name: 'Reconfirm and recover original intent' }))
    await waitFor(() => expect(api.message).toHaveBeenCalledWith(task.id, input, 'max-key'))
    expect(JSON.parse(localStorage.getItem(CLOUD_PENDING_STORAGE_KEY)!)[0].digest).toBe(digest)
  })

  it('resumes a prepared Max operation only with its own configured, verified connection', async () => {
    const task = profileTask('claude:max', { deliveryState: 'prepared' })
    const { api, response, team, max, codex } = await profileFixture(task)
    render(<CloudTasksSection api={api} selectedTaskId={task.id} />)
    const form = within(await screen.findByRole('form', { name: 'Resume prepared create' }))
    expect(form.getByRole('button', { name: 'Resume prepared operation' })).toBeDisabled()
    expect(form.getByRole('checkbox')).toBeDisabled()
    response.providers.splice(0, response.providers.length, team, codex)
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    expect(form.getByRole('checkbox')).toBeDisabled()
    max.readiness = 'ready'; max.capabilities.create = true
    response.providers.unshift(max)
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    fireEvent.click(form.getByRole('checkbox'))
    fireEvent.click(form.getByRole('button', { name: 'Resume prepared operation' }))
    await waitFor(() => expect(api.resumeOperation).toHaveBeenCalledWith('create-op', { credentialContextId: 'claude:max', accountConfirmed: true }))
  })

  it.each([true, false])('initializes after async provider load (unique Codex present: %s) without later rebinding', async (withCodex) => {
    const { api, response, team, codex } = await profileFixture()
    if (!withCodex) response.providers.splice(response.providers.indexOf(codex), 1)
    let resolve!: (value: typeof response) => void
    vi.mocked(api.providers).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    render(<CloudTaskCreateDialog api={api} onClose={vi.fn()} />)
    expect(screen.getByLabelText('Connection')).toHaveValue('')
    await act(async () => { resolve(response) })
    const chosen = withCodex ? codex : team
    const chosenKey = cloudConnectionKey(chosen.id, chosen.credentialContextId)
    expect(screen.getByLabelText('Connection')).toHaveValue(chosenKey)
    response.providers.reverse()
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    expect(screen.getByLabelText('Connection')).toHaveValue(chosenKey)
    chosen.credentialContextId = 'replacement-profile'
    await act(async () => { await cloudTaskStoreFor(api).refresh() })
    expect(screen.getByLabelText('Connection')).toHaveValue(chosenKey)
    expect(screen.getByRole('option', { name: /\(unavailable\)/ })).toBeDisabled()
  })
})
