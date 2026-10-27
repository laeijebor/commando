import { expect, test as base, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { createServer, type ViteDevServer } from 'vite'
import { cloudConnectionKey } from '../shared/cloud-tasks'
import { CloudDaemonFixture, hostileText, installationId, localSnapshot, operation, pendingKey, providers, task, teamMaxConnections } from './fixtures/cloud-tasks/daemon'

// Real App and production CSS. No daemon, provider process, or shared tmux server.
const port = Number(process.env.COMMANDO_E2E_VITE_PORT ?? 5297)
const baseUrl = `http://127.0.0.1:${port}`
let vite: ViteDevServer
const test = base.extend<{ daemon: CloudDaemonFixture }>({
  daemon: async ({ page, context }, use, testInfo) => {
    const daemon = new CloudDaemonFixture()
    await daemon.install(page, context, baseUrl)
    await use(daemon)
    const logPath = testInfo.outputPath('cloud-qa-traffic.json')
    await writeFile(logPath, JSON.stringify({
      requests: daemon.requests, websocket: daemon.messages, unexpected: daemon.unexpected,
      pageErrors: daemon.pageErrors, consoleErrors: daemon.consoleErrors, intentionalNetworkFailures: daemon.expectedFailures,
      intentionalRecoveryMisses: daemon.expectedNotFound,
      peakConcurrentRefreshes: daemon.peakRefreshes,
    }, null, 2))
    await testInfo.attach('cloud-qa-traffic.json', { contentType: 'application/json', path: logPath })
    if (testInfo.status !== testInfo.expectedStatus) await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true })
    expect(daemon.unexpected, 'Every daemon/external request must be explicitly mocked').toEqual([])
    expect(daemon.pageErrors, 'No uncaught product errors').toEqual([])
    const notFound = 'Failed to load resource: the server responded with a status of 404 (Not Found)'
    expect(daemon.consoleErrors.filter((error) => !error.includes('net::ERR_CONNECTION_FAILED') && error !== notFound), 'No unexpected console errors').toEqual([])
    expect(daemon.consoleErrors.filter((error) => error.includes('net::ERR_CONNECTION_FAILED'))).toHaveLength(daemon.expectedFailures.length)
    expect(daemon.consoleErrors.filter((error) => error === notFound)).toHaveLength(daemon.expectedNotFound.length)
    expect(daemon.messages.filter((message) => ['input', 'input_bytes', 'paste', 'key'].includes(message.type)), 'Cloud actions must never type into tmux').toEqual([])
  },
})
test.use({ trace: 'retain-on-failure', timezoneId: 'UTC' })
test.beforeAll(async () => {
  vite = await createServer({ server: { host: '127.0.0.1', port, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:9', '/screenshots': 'http://127.0.0.1:9', '/ws': { target: 'ws://127.0.0.1:9', ws: true } },
  } })
  await vite.listen()
})
test.afterAll(async () => { await vite?.close() })

async function openPanel(page: Page, name: 'HUD' | 'session tree') {
  const opener = page.getByRole('button', { name: `Open ${name}`, exact: true })
  if (await opener.isVisible()) {
    const closer = page.locator('aside.panel-open').getByRole('button', { name: /^Hide (HUD|session tree)$/ })
    if (await closer.count()) await closer.click()
    await opener.click()
    await expect(page.locator('aside.panel-open')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
  }
}
async function navigate(page: Page, area: 'Cloud tasks' | 'Workspace') {
  await openPanel(page, 'session tree')
  await page.getByRole('navigation', { name: 'Commando areas' }).getByRole('button', { name: new RegExp(`^${area}`) }).click()
}
async function start(page: Page) {
  await page.goto(`${baseUrl}/#token=cloud-qa-fixture`)
  await navigate(page, 'Cloud tasks')
  await expect(page.getByRole('button', { name: '+ New task', exact: true })).toBeEnabled()
}
const detail = (page: Page) => page.getByRole('article', { name: 'Selected cloud task' })
const list = (page: Page) => page.getByRole('region', { name: 'Saved cloud tasks', exact: true })
const pending = (page: Page) => page.getByRole('region', { name: 'Pending intent recovery' })
async function fillCreate(page: Page, title = 'Synthetic creation', prompt = 'Inspect synthetic fixture only.') {
  await page.getByRole('button', { name: '+ New task', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New cloud task' })
  await dialog.getByLabel('Title (optional)').fill(title)
  await dialog.getByLabel('Existing environment ID').fill('env_qa')
  await dialog.getByLabel('Requested branch').fill('qa/cloud')
  await dialog.getByLabel('Task prompt').fill(prompt)
  return dialog
}
async function contained(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No document horizontal overflow').toBe(true)
  const bounds = await page.locator('.cloud-section').boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  const size = viewport.width === 390 ? 'narrow' : 'desktop'
  test.describe(size, () => {
    test.use({ viewport })

    test('zero tmux: link without CLI, keyboard dialog and narrow Back', async ({ page, daemon }, testInfo) => {
      await start(page)
      await expect(list(page)).toContainText('no local session is required')
      const opener = page.getByRole('button', { name: 'Link existing', exact: true })
      await opener.click()
      const dialog = page.getByRole('dialog', { name: 'Link existing cloud task' })
      await expect(dialog).toHaveAttribute('data-native-terminal-occluder', '')
      await expect(dialog.getByRole('button', { name: 'Close cloud task dialog' })).toBeFocused()
      await dialog.getByRole('combobox', { name: /^Connection/ }).selectOption(cloudConnectionKey('claude', 'qa-context'))
      await expect(dialog).toContainText('missing_cli')
      await dialog.getByLabel('Title (optional)').fill('Linked Claude without local session')
      await dialog.getByLabel('Provider task or session ID').fill('https://evil.example/session_qa')
      await dialog.getByRole('checkbox', { name: /I confirm/ }).check()
      await expect(dialog.getByRole('button', { name: 'Link identity only' })).toBeDisabled()
      await dialog.getByLabel('Provider task or session ID').fill('session_qa')
      await expect(dialog.getByRole('checkbox', { name: /I confirm/ })).not.toBeChecked()
      await dialog.getByRole('checkbox', { name: /I confirm/ }).check()
      const submit = dialog.getByRole('button', { name: 'Link identity only' })
      await expect(submit).toBeEnabled()
      await submit.focus()
      await page.keyboard.press('Tab')
      await expect(dialog.getByRole('button', { name: 'Close cloud task dialog' })).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(submit).toBeFocused()
      await page.screenshot({ path: testInfo.outputPath(`${size}-link-dialog.png`) })
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(opener).toBeFocused()
      await opener.click()
      await dialog.getByRole('combobox', { name: /^Connection/ }).selectOption(cloudConnectionKey('claude', 'qa-context'))
      await dialog.getByLabel('Title (optional)').fill('Linked Claude without local session')
      await dialog.getByLabel('Provider task or session ID').fill('session_qa')
      await dialog.getByRole('checkbox', { name: /I confirm/ }).check()
      await submit.click()
      await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Linked Claude without local session')
      await expect(detail(page)).toContainText('Linked · unverified')
      await expect(detail(page)).toContainText('Identity supplied by you')
      await expect(detail(page)).toContainText('Live status is only available in Claude')
      await expect(detail(page).getByRole('link', { name: 'Open in Claude ↗' })).toHaveAttribute('href', 'https://claude.ai/code/session_qa')
      await expect(detail(page).getByRole('button', { name: 'Load diff' })).toHaveCount(0)
      await expect(detail(page).getByRole('button', { name: 'Send new message' })).toHaveCount(0)
      await contained(page)
      await page.screenshot({ path: testInfo.outputPath(`${size}-linked-no-tmux.png`) })
      if (size === 'narrow') {
        await expect(list(page)).toBeHidden()
        await detail(page).getByRole('button', { name: '← Back to tasks' }).click()
        const card = list(page).getByRole('button', { name: /Linked Claude/ })
        await testInfo.attach('back-focus.json', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(() => ({
          activeElement: document.activeElement?.outerHTML.slice(0, 500),
          selectedCardVisible: !!document.querySelector('.cloud-list [aria-current="true"]')?.getClientRects().length,
        }))) })
        await page.screenshot({ path: testInfo.outputPath(`${size}-back-to-list.png`) })
        await expect(card, 'Narrow Back must restore focus after revealing the list').toBeFocused()
        await card.press('Enter')
        await expect(detail(page).getByRole('heading', { level: 2 })).toBeFocused()
      }
      expect(daemon.mutations().map(({ method, path }) => `${method} ${path}`)).toEqual(['POST /api/cloud-tasks/link'])
      expect(daemon.snapshot.sessions).toHaveLength(0)
      expect(daemon.requests.some((request) => request.path.endsWith('/refresh'))).toBe(false)
    })

    test('Team and Max connections isolate identical session IDs, messages and unavailable profiles', async ({ page, daemon }, testInfo) => {
      daemon.providerResponse = teamMaxConnections()
      daemon.loseMessageResponse = false
      daemon.save(task({ title: 'Codex connection anchor', credentialContextId: 'codex:default' }))
      await start(page)
      const profiles = [{ label: 'Claude Team', context: 'claude:team' }, { label: 'Claude Max', context: 'claude:max' }]
      const linkedIds: Record<string, string> = {}
      const showList = async () => {
        if (size === 'narrow' && await detail(page).isVisible()) await detail(page).getByRole('button', { name: '← Back to tasks' }).click()
      }
      for (const profile of profiles) {
        await page.getByRole('button', { name: 'Link existing', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Link existing cloud task' })
        const connection = dialog.getByRole('combobox', { name: /^Connection/ })
        await expect(connection).toHaveValue(cloudConnectionKey('codex', 'codex:default'))
        await expect(connection.locator('option')).toHaveText(['Claude Team', 'Claude Max', 'Codex Cloud'])
        await connection.selectOption(cloudConnectionKey('claude', profile.context))
        // Same title and provider identity deliberately require connection labels to distinguish records.
        await dialog.getByLabel('Title (optional)').fill('Shared Claude session')
        await dialog.getByLabel('Provider task or session ID').fill('session_shared_qa')
        const confirmation = dialog.getByRole('checkbox', { name: /I confirm/ })
        const submit = dialog.getByRole('button', { name: 'Link identity only' })
        await confirmation.check()
        if (profile.context === 'claude:team') {
          await connection.selectOption(cloudConnectionKey('claude', 'claude:max'))
          await expect(confirmation).not.toBeChecked()
          await expect(submit).toBeDisabled()
          await expect(dialog).toContainText('Connection: Claude Max')
          await connection.selectOption(cloudConnectionKey('claude', 'claude:team'))
          await expect(confirmation).not.toBeChecked()
          await confirmation.check()
        } else {
          // Wake polling with the modal open; no injected component/store state or direct API calls.
          daemon.providerResponse.providers.reverse()
          await page.evaluate(() => window.dispatchEvent(new Event('focus')))
          await expect(connection.locator('option')).toHaveText(['Codex Cloud', 'Claude Max', 'Claude Team'])
          await expect(connection).toHaveValue(cloudConnectionKey('claude', 'claude:max'))
          await expect(confirmation).toBeChecked()
          await expect(submit).toBeEnabled()
          await page.screenshot({ path: testInfo.outputPath(`${size}-connections-reordered.png`) })
        }
        await submit.click()
        await expect(dialog).toHaveCount(0)
        await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Shared Claude session')
        await expect(detail(page).getByText(profile.label, { exact: true })).toBeVisible()
        await expect(detail(page)).toContainText(`Confirmation context: ${profile.context}`)
        const linked = [...daemon.details.values()].find(({ task }) => task.credentialContextId === profile.context)!.task
        linkedIds[profile.context] = linked.id
        await detail(page).getByLabel('Message', { exact: true }).fill(`Follow-up through ${profile.label}`)
        await detail(page).getByRole('checkbox', { name: /I confirm/ }).check()
        await detail(page).getByRole('button', { name: 'Send new message' }).click()
        await expect(detail(page).locator('.cloud-activity')).toContainText('Follow-up · Message sent')
        await expect(detail(page).locator('.cloud-activity')).toContainText(`Follow-up through ${profile.label}`)
        await showList()
        await expect(list(page).getByRole('button', { name: new RegExp(`^${profile.label}: Shared Claude session`) }).getByText(profile.label, { exact: true })).toBeVisible()
      }
      expect(linkedIds['claude:team']).not.toBe(linkedIds['claude:max'])
      expect([...daemon.details.values()].filter(({ task }) => task.providerTaskId === 'session_shared_qa')).toHaveLength(2)
      expect(daemon.mutations().filter((request) => request.path === '/api/cloud-tasks/link').map(({ body }) => body)).toEqual(profiles.map((profile) => ({
        provider: 'claude', credentialContextId: profile.context, providerTaskId: 'session_shared_qa', title: 'Shared Claude session', accountConfirmed: true,
      })))
      await page.getByRole('heading', { name: 'Cloud tasks', exact: true, level: 1 }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath(`${size}-team-max-task-list.png`) })

      await page.reload()
      await navigate(page, 'Cloud tasks')
      await expect(list(page).getByRole('button')).toHaveCount(3)
      for (const profile of profiles) await expect(list(page).getByRole('button', { name: new RegExp(`^${profile.label}:`) })).toBeVisible()
      await navigate(page, 'Workspace')
      await openPanel(page, 'HUD')
      const hud = page.getByRole('region', { name: 'Cloud tasks HUD' })
      await expect(hud.getByRole('button')).toHaveCount(3)
      for (const profile of profiles) await expect(hud.getByRole('button', { name: new RegExp(`^${profile.label}:`) }).getByText(profile.label, { exact: true })).toBeVisible()
      await expect(hud.getByRole('button', { name: /^Codex Cloud:/ })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`${size}-team-max-hud.png`) })
      await hud.getByRole('button', { name: /^Claude Max:/ }).click()
      await expect(detail(page).getByText('Claude Max', { exact: true })).toBeVisible()
      await expect(detail(page).locator('.cloud-activity')).toContainText('Follow-up through Claude Max')
      await expect(detail(page).locator('.cloud-activity')).not.toContainText('Follow-up through Claude Team')
      await page.getByRole('heading', { name: 'Cloud tasks', exact: true, level: 1 }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath(`${size}-max-task-selected.png`) })
      daemon.providerResponse.providers.reverse()
      await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Refresh tasks', exact: true })).toBeEnabled()
      await expect(page.locator('.cloud-list [aria-current="true"]')).toHaveAttribute('data-cloud-task-id', linkedIds['claude:max'])
      await expect(detail(page).getByText('Claude Max', { exact: true })).toBeVisible()

      await detail(page).getByLabel('Message', { exact: true }).fill('Must never fall back to Team')
      await detail(page).getByRole('checkbox', { name: /I confirm/ }).check()
      daemon.providerResponse.providers = daemon.providerResponse.providers.filter((provider) => provider.credentialContextId !== 'claude:max')
      await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click()
      await expect(detail(page)).toContainText('another profile will not be substituted')
      await expect(detail(page)).toContainText('claude:max')
      await expect(detail(page).getByRole('button', { name: 'Send new message' })).toHaveCount(0)
      await expect(detail(page).getByRole('button', { name: 'Refresh status' })).toHaveCount(0)
      await expect(detail(page).getByRole('button', { name: 'Refresh saved record' })).toBeEnabled()
      await expect(detail(page).getByRole('link', { name: 'Open in Claude ↗' })).toHaveAttribute('href', 'https://claude.ai/code/session_shared_qa')
      await expect(detail(page).getByText('Claude Team', { exact: true })).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath(`${size}-max-connection-unavailable.png`) })
      await showList()
      await expect(list(page).getByRole('button')).toHaveCount(3)
      await expect(list(page).getByRole('button', { name: /^Claude · claude:max:/ })).toBeVisible()
      await list(page).getByRole('button', { name: /^Claude Team:/ }).click()
      await expect(detail(page)).toContainText('Confirmation context: claude:team')
      await detail(page).getByLabel('Message', { exact: true }).fill('Team remains available after Max removal')
      await detail(page).getByRole('checkbox', { name: /I confirm/ }).check()
      await detail(page).getByRole('button', { name: 'Send new message' }).click()
      await expect(detail(page).locator('.cloud-activity')).toContainText('Team remains available after Max removal')
      expect(daemon.mutations().filter((request) => request.path.endsWith('/messages')).map(({ path, body }) => ({ path, body }))).toEqual([
        ...profiles.map((profile) => ({ path: `/api/cloud-tasks/${linkedIds[profile.context]}/messages`,
          body: { credentialContextId: profile.context, message: `Follow-up through ${profile.label}`, accountConfirmed: true } })),
        { path: `/api/cloud-tasks/${linkedIds['claude:team']}/messages`, body: { credentialContextId: 'claude:team',
          message: 'Team remains available after Max removal', accountConfirmed: true } },
      ])
      expect(daemon.creates()).toHaveLength(0)
      expect(daemon.requests.filter((request) => request.path.endsWith('/refresh'))).toHaveLength(0)
    })

    test('capability gate and local 202 become accepted only after a provider receipt', async ({ page, daemon }, testInfo) => {
      daemon.providerResponse = providers(true)
      await start(page)
      const dialog = await fillCreate(page)
      const submit = dialog.getByRole('button', { name: 'Record cloud task' })
      await expect(submit).toBeDisabled()
      await dialog.getByRole('combobox', { name: /^Connection/ }).selectOption(cloudConnectionKey('claude', 'qa-context'))
      await dialog.getByLabel('Existing checkout path').fill('/tmp/cloud-qa-fixture')
      await dialog.getByRole('checkbox', { name: /I confirm/ }).check()
      await expect(dialog).toContainText('Claude creation is unverified')
      await expect(submit).toBeDisabled()
      await dialog.getByRole('combobox', { name: /^Connection/ }).selectOption(cloudConnectionKey('codex', 'qa-context'))
      await dialog.getByLabel('Existing environment ID').fill('env_qa')
      await expect(dialog.getByRole('checkbox', { name: /I confirm/ })).not.toBeChecked()
      await dialog.getByRole('checkbox', { name: /I confirm/ }).check()
      await expect(dialog).toContainText('Destination: Codex Cloud')
      await submit.click()
      await expect(dialog).toHaveCount(0)
      await expect(detail(page)).toContainText('A local acknowledgement is not cloud acceptance')
      await expect(detail(page)).toContainText('Recorded locally')
      await expect(detail(page)).not.toContainText('Provider receipt saved')
      expect(daemon.creates()).toHaveLength(1)
      expect(daemon.creates()[0]).toMatchObject({ body: { provider: 'codex', credentialContextId: 'qa-context', prompt: 'Inspect synthetic fixture only.', source: { environmentId: 'env_qa', branch: 'qa/cloud' }, accountConfirmed: true } })
      expect(daemon.creates()[0].key).toMatch(/^[0-9a-f-]{36}$/)
      const index = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), pendingKey)
      expect(index).toEqual([{ key: daemon.creates()[0].key, digest: expect.stringMatching(/^[0-9a-f]{64}$/), installationId }])
      await page.screenshot({ path: testInfo.outputPath(`${size}-local-202.png`) })
      const recorded = daemon.details.get('qa-created')!
      const accepted = task({ ...recorded.task, revision: 2, deliveryState: 'accepted', providerTaskId: 'task_receipt',
        providerUrl: 'https://chatgpt.com/codex/tasks/task_receipt', identityEvidence: 'provider_receipt', remoteState: 'queued', observationState: 'fresh' })
      daemon.save(accepted, [operation(accepted, { ...recorded.operations[0], state: 'accepted', receipt: {
        providerTaskId: accepted.providerTaskId!, providerUrl: accepted.providerUrl!, evidence: 'provider_receipt',
      } })])
      await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click()
      await expect(detail(page)).toContainText('Provider receipt saved')
      await expect(detail(page).locator('.cloud-notice').first()).toContainText('Queued')
      await expect(detail(page)).not.toContainText('A local acknowledgement is not cloud acceptance')
      await expect(pending(page)).toHaveCount(0)
      expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), pendingKey)).toEqual([])
      expect(daemon.creates()).toHaveLength(1)
      await page.screenshot({ path: testInfo.outputPath(`${size}-provider-receipt.png`) })
    })

    test('prepared resume after reload reconfirms readiness/context and dispatches only the original operation', async ({ page, daemon }, testInfo) => {
      daemon.providerResponse = providers(true)
      await start(page)
      const dialog = await fillCreate(page, 'Prepared request awaiting reconfirmation')
      await dialog.getByRole('checkbox', { name: /I confirm/ }).check()
      await dialog.getByRole('button', { name: 'Record cloud task' }).click()
      await expect(detail(page)).toContainText('Recorded locally')
      const original = structuredClone(daemon.details.get('qa-created')!.operations[0])
      await page.reload()
      await navigate(page, 'Cloud tasks')
      await pending(page).getByRole('button', { name: 'View recorded task' }).click()
      const form = detail(page).getByRole('form', { name: 'Resume prepared create' })
      const resume = form.getByRole('button', { name: 'Resume prepared operation' })
      const confirm = form.getByRole('checkbox', { name: /I reconfirm/ })
      await expect(resume).toBeDisabled()
      await expect(confirm).not.toBeChecked()
      await expect(form).toContainText('Recorded request: Inspect synthetic fixture only.')
      await expect(form).toContainText('env_qa')
      expect(daemon.mutations()).toHaveLength(1)

      daemon.providerResponse = providers()
      await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click()
      await expect(confirm).toBeDisabled()
      daemon.providerResponse = providers(true)
      await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click()
      await expect(confirm).toBeEnabled()
      await confirm.check()
      await expect(resume).toBeEnabled()
      daemon.providerResponse.providers[0].credentialContextId = 'qa-changed-context'
      await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click()
      await expect(form).toContainText('Restore the original credential context')
      await expect(confirm).not.toBeChecked()
      await expect(resume).toBeDisabled()
      await form.scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath(`${size}-prepared-context-blocked.png`) })
      daemon.providerResponse = providers(true)
      await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click()
      await expect(confirm).toBeEnabled()
      await confirm.check()
      await resume.click()
      await expect(form).toHaveCount(0)
      await expect(detail(page).locator('.cloud-activity')).toContainText('Provider receipt saved')
      await expect(pending(page)).toHaveCount(0)
      const dispatches = daemon.requests.filter((request) => request.path.endsWith('/dispatch'))
      expect(dispatches).toEqual([{ method: 'POST', path: `/api/cloud-operations/${original.id}/dispatch`,
        body: { credentialContextId: 'qa-context', accountConfirmed: true }, key: undefined }])
      const dispatchIndex = daemon.requests.indexOf(dispatches[0])
      expect(daemon.requests[dispatchIndex - 1]).toMatchObject({ method: 'GET', path: `/api/cloud-operations/${original.id}` })
      expect(daemon.details.get('qa-created')!.operations[0]).toMatchObject({ id: original.id,
        idempotencyKey: original.idempotencyKey, payload: original.payload, state: 'accepted' })
      expect(daemon.creates()).toHaveLength(1)
      await detail(page).getByRole('heading', { level: 2 }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath(`${size}-prepared-resumed.png`) })

      // The saved operation changes after rendering: re-read must stop a stale resume action.
      const raced = task({ id: 'qa-resume-race', title: 'Prepared request changed on daemon', deliveryState: 'prepared',
        providerTaskId: null, providerUrl: null, identityEvidence: null, remoteState: 'unknown' })
      daemon.save(raced)
      await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click()
      if (size === 'narrow') await detail(page).getByRole('button', { name: '← Back to tasks' }).click()
      await list(page).getByRole('button', { name: /Prepared request changed/ }).click()
      await confirm.check()
      daemon.save({ ...raced, revision: 2, deliveryState: 'delivery_unknown' })
      await resume.click()
      await expect(detail(page)).toContainText('A timeout or list miss cannot prove this request did not arrive')
      await expect(form).toHaveCount(0)
      expect(daemon.requests.filter((request) => request.path.endsWith('/dispatch'))).toHaveLength(1)
      expect(daemon.creates()).toHaveLength(1)
    })

    for (const lost of ['lost-recorded', 'lost-unrecorded'] as const) {
      test(`${lost}: reload recovers by key without replay or prompt persistence`, async ({ page, daemon }, testInfo) => {
        daemon.providerResponse = providers(true)
        daemon.createMode = lost
        await start(page)
        const dialog = await fillCreate(page, 'Lost response fixture', 'PRIVATE-QA-PROMPT-never-persist-this')
        await dialog.getByRole('checkbox', { name: /I confirm/ }).check()
        await dialog.getByRole('button', { name: 'Record cloud task' }).click()
        await expect(dialog.getByRole('alert')).toContainText('Delivery unknown')
        await expect(dialog.getByRole('button', { name: 'Record cloud task' })).toBeDisabled()
        await page.keyboard.press('Escape')
        await expect(pending(page).getByRole('button', { name: 'Recover / retry same intent' })).toBeVisible()
        if (lost === 'lost-recorded') {
          await pending(page).getByRole('button', { name: 'Recover / retry same intent' }).click()
          await expect(pending(page)).toContainText('Task intent · Delivery unknown')
          expect(daemon.creates()).toHaveLength(1)
        }
        const storage = await page.evaluate(() => ({ ...localStorage }))
        expect(JSON.stringify(storage)).not.toContain('PRIVATE-QA-PROMPT')
        expect(JSON.stringify(storage)).not.toContain('Lost response fixture')
        const firstKey = daemon.creates()[0].key!
        await page.reload()
        await navigate(page, 'Cloud tasks')
        await expect(pending(page)).toBeVisible()
        await expect(pending(page)).not.toContainText('Checking recorded intent')
        await expect(pending(page).getByRole('button', { name: 'Recover / retry same intent' })).toHaveCount(0)
        expect(daemon.requests.some((request) => request.path === `/api/cloud-operations/by-key/${firstKey}`)).toBe(true)
        if (lost === 'lost-recorded') {
          await expect(pending(page)).toContainText('Task intent · Delivery unknown')
          await pending(page).getByRole('button', { name: 'View recorded task' }).click()
          await expect(detail(page)).toContainText('A timeout or list miss cannot prove this request did not arrive')
          await expect(detail(page)).toContainText('PRIVATE-QA-PROMPT-never-persist-this')
        } else {
          await expect(pending(page)).toContainText('Unknown draft — no operation found')
          await pending(page).getByRole('button', { name: 'Re-enter original intent…' }).click()
          const reentry = page.getByRole('dialog', { name: 'Re-enter original cloud intent' })
          await expect(reentry.getByLabel('Task prompt')).toHaveValue('')
          await reentry.getByLabel('Existing environment ID').fill('env_qa')
          await reentry.getByLabel('Requested branch').fill('qa/cloud')
          await reentry.getByLabel('Task prompt').fill('A deliberately new intent')
          await reentry.getByRole('checkbox', { name: /I confirm/ }).check()
          await reentry.getByRole('button', { name: 'Reconfirm and recover original intent' }).click()
          await expect(reentry.getByRole('alert')).toContainText('does not match')
          expect(daemon.creates()).toHaveLength(1)
          await reentry.getByRole('checkbox', { name: /This changed draft needs a new key/ }).check()
          await expect(reentry.getByRole('button', { name: 'Explicitly record new intent' })).toBeEnabled()
          await page.keyboard.press('Escape')
        }
        await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Refresh tasks', exact: true })).toBeEnabled()
        expect(daemon.creates()).toHaveLength(1)
        await page.screenshot({ path: testInfo.outputPath(`${size}-${lost}-recovery.png`) })
      })
    }

    test('uncertain follow-up is not accepted by the session receipt; a new message requires duplicate confirmation', async ({ page, daemon }, testInfo) => {
      daemon.providerResponse = providers(true)
      daemon.save(task({ id: 'qa-claude', provider: 'claude', title: 'Claude message recovery', providerTaskId: 'session_qa',
        providerUrl: 'https://claude.ai/code/session_qa', remoteState: 'unknown', rawState: null, observationState: 'unavailable' }))
      await start(page)
      await list(page).getByRole('button', { name: /Claude message recovery/ }).click()
      await detail(page).getByLabel('Message', { exact: true }).fill('First uncertain follow-up')
      const confirm = detail(page).getByRole('checkbox', { name: /I confirm/ })
      const send = detail(page).getByRole('button', { name: 'Send new message' })
      await expect(send).toBeDisabled()
      await confirm.check()
      await send.click()
      await expect(detail(page).getByRole('alert')).toContainText('Delivery unknown')
      await expect(confirm).not.toBeChecked()
      await page.reload()
      await navigate(page, 'Cloud tasks')
      await pending(page).getByRole('button', { name: 'View recorded task' }).click()
      const activity = detail(page).locator('.cloud-activity')
      await expect(activity).toContainText('Follow-up · Delivery unknown')
      await expect(activity).toContainText('message-specific receipt evidence is required')
      await expect(activity).not.toContainText('Message sent')
      await expect(detail(page)).toContainText('Submitted · live status in Claude')
      await expect(detail(page).getByRole('button', { name: 'Link known task identity' })).toHaveCount(0)
      await detail(page).getByLabel('Message', { exact: true }).fill('Explicitly new follow-up')
      await confirm.check()
      await expect(send).toBeDisabled()
      await detail(page).getByRole('checkbox', { name: /An earlier message or intent is unresolved/ }).check()
      daemon.loseMessageResponse = false
      await send.click()
      await expect(activity).toContainText('Follow-up · Message sent')
      await expect(activity).toContainText('Follow-up · Delivery unknown')
      await expect(confirm).not.toBeChecked()
      const messages = daemon.mutations().filter((request) => request.path.endsWith('/messages'))
      expect(messages).toHaveLength(2)
      expect(messages[0].key).not.toBe(messages[1].key)
      expect(daemon.creates()).toHaveLength(0)
      await activity.scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath(`${size}-message-uncertainty.png`) })
    })

    test('stale and offline retain last-known result and provider link; reconnect preserves focus', async ({ page, context, daemon }, testInfo) => {
      daemon.providerResponse = providers(true)
      daemon.save(task({ observationState: 'stale' }))
      await start(page)
      await list(page).getByRole('button', { name: /Review synthetic/ }).click()
      await expect(detail(page)).toContainText('Observation: stale. Showing last-known information.')
      await expect(detail(page)).toContainText('Ready for review, not proof of success or passed tests.')
      const titleInput = detail(page).getByLabel('Local title')
      await titleInput.fill('Unsubmitted local edit')
      daemon.unavailable = true
      await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Daemon unavailable' })).toContainText('Last loaded')
      for (const name of ['Archive', 'Refresh status', 'Save title']) await expect(detail(page).getByRole('button', { name, exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Link existing', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: '+ New task', exact: true })).toBeDisabled()
      const providerLink = detail(page).getByRole('link', { name: 'Open in Codex ↗' })
      await expect(providerLink).toHaveAttribute('href', 'https://chatgpt.com/codex/tasks/task_qa')
      await expect(providerLink).toHaveAttribute('rel', 'noopener noreferrer')
      await expect(providerLink).toHaveAttribute('target', '_blank')
      await providerLink.focus()
      await context.setOffline(true)
      await expect(page.getByRole('status').filter({ hasText: 'Offline. Showing last-known' })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`${size}-offline-stale.png`) })
      daemon.unavailable = false
      const readsBefore = daemon.requests.filter((request) => request.path === '/api/cloud-providers').length
      await context.setOffline(false)
      await expect(detail(page).getByRole('button', { name: 'Archive', exact: true })).toBeEnabled()
      await expect(providerLink).toBeFocused()
      await expect(titleInput).toHaveValue('Unsubmitted local edit')
      expect(daemon.requests.filter((request) => request.path === '/api/cloud-providers').length - readsBefore).toBe(1)
      expect(daemon.mutations()).toHaveLength(0)
    })

    test('on-demand diff and provider text stay plaintext, bounded and read-only', async ({ page, daemon }, testInfo) => {
      daemon.providerResponse = providers(true)
      daemon.save(task({ prompt: hostileText, title: 'Untrusted provider result', rawState: hostileText,
        providerUrl: 'https://chatgpt.com.evil.example/codex/tasks/task_qa' }))
      daemon.diff = { text: `+${hostileText}\n${'+bounded\n'.repeat(5_100)}`, truncated: false }
      await start(page)
      await list(page).getByRole('button', { name: /Untrusted provider/ }).click()
      expect(daemon.requests.filter((request) => request.path.endsWith('/diff'))).toHaveLength(0)
      await expect(detail(page).getByRole('link', { name: 'Open in Codex ↗' })).toHaveAttribute('href', 'https://chatgpt.com/codex')
      await expect(detail(page).getByRole('link', { name: /Open full result/ })).toHaveCount(0)
      await expect(detail(page).locator('.cloud-prompt')).toHaveText(hostileText)
      await detail(page).getByRole('button', { name: 'Load diff', exact: true }).click()
      const diff = detail(page).getByLabel('Unified diff')
      await expect(diff).toContainText(hostileText)
      await expect(detail(page).getByRole('status')).toContainText('Diff truncated')
      expect((await diff.textContent())!.split('\n')).toHaveLength(5_000)
      expect(new TextEncoder().encode((await diff.textContent())!).byteLength).toBeLessThanOrEqual(256 * 1024)
      expect(await diff.locator('*').count()).toBe(0)
      expect(await page.evaluate(() => 'cloudQaExecuted' in window)).toBe(false)
      await expect(detail(page).locator('img, script')).toHaveCount(0)
      await expect(detail(page).getByRole('button', { name: /apply|merge|checkout|cancel|send new message/i })).toHaveCount(0)
      expect(daemon.requests.filter((request) => request.path.endsWith('/diff'))).toHaveLength(1)
      expect(daemon.mutations()).toHaveLength(0)
      await contained(page)
      await diff.scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath(`${size}-plaintext-diff.png`) })
    })

    test('HUD and archive preserve local selection, filters and tasks after origin removal', async ({ page, daemon }, testInfo) => {
      daemon.snapshot = localSnapshot()
      daemon.providerResponse = providers(true)
      daemon.save(task({ origin: { sessionId: '$6', paneTargetId: daemon.snapshot.panes[1].targetId } }))
      daemon.save(task({ id: 'qa-claude', provider: 'claude', title: 'Claude receipt only', providerTaskId: 'session_qa',
        providerUrl: 'https://claude.ai/code/session_qa', remoteState: 'unknown', rawState: null, observationState: 'unavailable' }))
      await page.goto(`${baseUrl}/#token=cloud-qa-fixture`)
      await openPanel(page, 'session tree')
      await page.locator('.managed-session-main').filter({ hasText: 'local-review' }).click()
      await expect(page.locator('.managed-session-main[aria-current="true"]')).toHaveText('local-review')
      await openPanel(page, 'HUD')
      const filter = page.getByRole('button', { name: /Filter to working agents \(0\)/ })
      await filter.click()
      const hud = page.getByRole('region', { name: 'Cloud tasks HUD' })
      await expect(hud.getByRole('button')).toHaveCount(2)
      await expect(hud).toContainText('Live status only in Claude')
      await hud.getByRole('button', { name: /Review synthetic/ }).click()
      await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Review synthetic cloud result')
      await expect(page.locator('.managed-session-main[aria-current="true"]')).toHaveText('local-review')
      await detail(page).getByRole('button', { name: 'Archive', exact: true }).click()
      await expect(detail(page).getByRole('button', { name: 'Unarchive', exact: true })).toBeVisible()
      if (size === 'narrow') await detail(page).getByRole('button', { name: '← Back to tasks' }).click()
      await expect(list(page).getByRole('button', { name: /Review synthetic/ })).toHaveCount(0)
      await list(page).getByRole('checkbox', { name: 'Archived', exact: true }).check()
      await expect(list(page).getByRole('button', { name: /Review synthetic/ })).toContainText('Archived locally')
      await page.screenshot({ path: testInfo.outputPath(`${size}-archived.png`) })
      await list(page).getByRole('button', { name: /Review synthetic/ }).click()
      await detail(page).getByRole('button', { name: 'Unarchive', exact: true }).click()
      await navigate(page, 'Workspace')
      await expect(page.locator('.managed-session-main[aria-current="true"]')).toHaveText('local-review')
      await expect(page.locator('[data-pane-id="%21"]')).toBeVisible()
      await openPanel(page, 'HUD')
      await expect(page.getByRole('button', { name: 'Clear working agents (0)' })).toHaveAttribute('aria-pressed', 'true')
      await expect(hud.getByRole('button')).toHaveCount(2)
      await hud.getByRole('button', { name: /Review synthetic/ }).click()
      daemon.publish({ revision: 2, capturedAt: Date.now(), ports: [], panes: [], sessions: [], windows: [] })
      await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Review synthetic cloud result')
      await expect(detail(page)).toContainText('Result ready')
      await expect(detail(page).getByRole('link', { name: 'Open in Codex ↗' })).toHaveAttribute('href', 'https://chatgpt.com/codex/tasks/task_qa')
      expect(daemon.mutations().map(({ method, path, body }) => ({ method, path, body }))).toEqual([
        { method: 'PATCH', path: '/api/cloud-tasks/qa-codex', body: { archivedAt: expect.any(String) } },
        { method: 'PATCH', path: '/api/cloud-tasks/qa-codex', body: { archivedAt: null } },
      ])
      expect(daemon.requests.filter((request) => request.path === '/api/cloud-tasks/qa-claude/refresh')).toHaveLength(0)
      await page.screenshot({ path: testInfo.outputPath(`${size}-origin-removed.png`) })
    })
  })
}

test('24 active tasks: foreground polling reaches the last task without flooding or changing selection', async ({ page, daemon }, testInfo) => {
  daemon.providerResponse = providers(true)
  daemon.completeOnRefresh = true
  daemon.refreshDelayMs = 35
  for (let index = 1; index <= 24; index++) daemon.save(task({ id: `qa-bulk-${index}`, title: `Cloud task ${String(index).padStart(2, '0')}`,
    providerTaskId: `task_bulk_${index}`, providerUrl: `https://chatgpt.com/codex/tasks/task_bulk_${index}`,
    remoteState: 'queued', rawState: 'queued' }))
  await start(page)
  await expect(list(page).getByRole('button')).toHaveCount(24)
  await expect(page.getByRole('button', { name: 'Refresh tasks', exact: true })).toBeEnabled()
  await expect(list(page).getByRole('button', { name: /Result ready/ })).toHaveCount(24)
  const refreshes = () => daemon.requests.filter((request) => request.path.endsWith('/refresh'))
  expect(new Set(refreshes().map((request) => request.path)).size).toBe(24)
  expect(refreshes()).toHaveLength(24)
  expect(daemon.peakRefreshes).toBeLessThanOrEqual(4)
  await list(page).getByRole('button', { name: /Cloud task 24\./ }).click()
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Cloud task 24')
  // The same user action polls again, preserving the selected last task and all rows.
  for (const saved of daemon.details.values()) saved.task = { ...saved.task, revision: saved.task.revision + 1, remoteState: 'running', rawState: 'running' }
  await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Refresh tasks', exact: true })).toBeEnabled()
  await expect(list(page).getByRole('button', { name: /Result ready/ })).toHaveCount(24)
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Cloud task 24')
  await expect(list(page).getByRole('button', { name: /Cloud task 24\./ })).toHaveAttribute('aria-current', 'true')
  expect(refreshes()).toHaveLength(48)
  expect(daemon.peakRefreshes).toBeLessThanOrEqual(4)
  expect(daemon.mutations()).toHaveLength(0)
  await expect(page.getByRole('status').filter({ hasText: 'Some observations could not be refreshed' })).toHaveCount(0)
  await detail(page).getByRole('heading', { level: 2 }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('desktop-24-tasks-polled.png') })
})

for (const width of [639, 640]) {
  test(`breakpoint ${width}px: list/detail switch and multibyte diff cap`, async ({ page, daemon }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    daemon.providerResponse = providers(true)
    daemon.save(task({ title: 'Long-source-boundary-'.repeat(10), source: { repository: 'acme/repository-'.repeat(20), branch: 'qa/branch-'.repeat(20) } }))
    daemon.diff = { text: `+${'😀'.repeat(70_000)}\n+END-MUST-NOT-RENDER`, truncated: false }
    await start(page)
    await list(page).getByRole('button').click()
    await expect(detail(page)).toBeVisible()
    if (width === 639) await expect(list(page)).toBeHidden()
    else await expect(list(page)).toBeVisible()
    await detail(page).getByRole('button', { name: 'Load diff' }).click()
    await expect(detail(page).getByRole('status')).toContainText('Diff truncated')
    const text = await detail(page).getByLabel('Unified diff').textContent()
    expect(new TextEncoder().encode(text!).byteLength).toBeLessThanOrEqual(256 * 1024)
    expect(text).not.toContain('END-MUST-NOT-RENDER')
    await contained(page)
    await detail(page).getByRole('heading', { level: 2 }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`breakpoint-${width}.png`) })
  })
}
