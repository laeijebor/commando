// End-to-end check for the companion daemon surfaces: owner answer channel on
// /ws and over HTTP, hook hold/release, provider usage, Codex turn completion,
// and push device routes. Runs against a live daemon on an isolated tmux
// server (tmux >= 3.6, UTF-8 locale so format separators survive):
//
//   tmux -L commando-qa -f /dev/null new-session -d -s qa
//   LANG=C.UTF-8 COMMANDO_TMUX_SOCKET_NAME=commando-qa COMMANDO_PORT=4410 \
//     COMMANDO_TOKEN=<owner-token> COMMANDO_AGENT_HOOK_TOKEN_PATH=<hook-token-file> \
//     npx tsx server/index.ts
//   COMMANDO_E2E_OWNER_TOKEN=<owner-token> COMMANDO_E2E_HOOK_TOKEN=<hook-token> \
//     node e2e/companion-daemon.e2e.mjs %0
//
// The push send is expected to be attempted (and to fail without network); the
// script only checks the device routes, never the Expo delivery.
import WebSocket from 'ws'

const PORT = process.env.COMMANDO_PORT ?? '4410'
const BASE = `http://127.0.0.1:${PORT}`
const OWNER = process.env.COMMANDO_E2E_OWNER_TOKEN
const HOOK = process.env.COMMANDO_E2E_HOOK_TOKEN
if (!OWNER || !HOOK) {
  console.error('Set COMMANDO_E2E_OWNER_TOKEN and COMMANDO_E2E_HOOK_TOKEN')
  process.exit(2)
}
const PANE = process.argv[2] ?? '%0'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- owner /ws client ---------------------------------------------------
const messages = []
const waiters = []
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${OWNER}`)
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  messages.push(msg)
  for (const w of [...waiters]) if (w.test(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg) }
})
const waitFor = (test, ms = 8000) => new Promise((resolve, reject) => {
  const found = messages.find(test)
  if (found) return resolve(found)
  const t = setTimeout(() => reject(new Error('timeout waiting for message')), ms)
  waiters.push({ test, resolve: (m) => { clearTimeout(t); resolve(m) } })
})
await new Promise((r) => ws.on('open', r))
const send = (m) => ws.send(JSON.stringify(m))
send({ type: 'watch_interactions', enabled: true, requestId: 'wi-1' })
send({ type: 'watch_usage', enabled: true, requestId: 'wu-1' })

const usage = await waitFor((m) => m.type === 'provider_usage').catch(() => null)
check('provider_usage arrives after watch_usage', !!usage, usage ? `providers=${usage.usage.map((u) => `${u.provider}:${u.state}`).join(',')}` : '')

// --- 1. permission request via Claude hook, answered over /ws ---------
const hookPost = (provider, body) => fetch(`${BASE}/api/agent-status/hooks/${provider}`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${HOOK}`, 'Content-Type': 'application/json', 'X-Commando-Pane': PANE },
  body: JSON.stringify(body),
})
const started = Date.now()
const held = hookPost('claude', {
  hook_event_name: 'PermissionRequest', session_id: 'sess-e2e', tool_name: 'Bash',
  request: { id: 'perm-1', kind: 'permission', prompt: 'Run git push?', toolName: 'Bash' },
})
const st = await waitFor((m) => m.type === 'agent_status' && m.status.paneId === PANE && m.status.status === 'needs_input' && m.status.details?.requests?.some((r) => r.id === 'perm-1'))
check('needs_input status with pending request broadcast on /ws', !!st, `summary="${st.status.summary}"`)
await sleep(300)
send({ type: 'answer_agent_request', paneId: PANE, interactionId: 'perm-1', answer: { action: 'allow_once' }, requestId: 'ans-1' })
const ack = await waitFor((m) => m.type === 'agent_request_answered' && m.requestId === 'ans-1')
check('agent_request_answered ack', ack.changed === true, JSON.stringify(ack))
const hookRes = await held
const hookJson = await hookRes.json()
check('held hook POST resolved with the answer', hookRes.status === 200 && hookJson.answer?.action === 'allow_once', `${Date.now() - started}ms ${JSON.stringify(hookJson)}`)
const cleared = await waitFor((m) => m.type === 'agent_status' && m.status.paneId === PANE && !(m.status.details?.requests?.length))
check('request removed from status after answer', cleared.status.status === 'working', `status=${cleared.status.status}`)
// idempotent replay
send({ type: 'answer_agent_request', paneId: PANE, interactionId: 'perm-1', answer: { action: 'allow_once' }, requestId: 'ans-1' })
const replay = await waitFor((m) => m.type === 'agent_request_answered' && m.requestId === 'ans-1' && m.changed === false)
check('duplicate requestId re-acks with changed:false', !!replay)
// answering something not pending
send({ type: 'answer_agent_request', paneId: PANE, interactionId: 'perm-1', answer: { action: 'deny' }, requestId: 'ans-2' })
const err = await waitFor((m) => m.type === 'error' && m.requestId === 'ans-2')
check('answering a settled request errors request_unavailable', err.code === 'request_unavailable', err.code)

// --- 2. question via Claude hook, answered over HTTP route ------------
const held2 = hookPost('claude', {
  hook_event_name: 'PreToolUse', session_id: 'sess-e2e', tool_name: 'AskUserQuestion',
  request: { id: 'q-1', kind: 'question', prompt: 'Which auth flow?', questions: [{ header: 'Auth', question: 'Which auth flow?', options: [{ label: 'Owner email' }, { label: 'Pairing' }], multiple: false, custom: true }] },
})
await waitFor((m) => m.type === 'agent_status' && m.status.paneId === PANE && m.status.details?.requests?.some((r) => r.id === 'q-1'))
await sleep(200)
const httpRes = await fetch(`${BASE}/api/agent-requests/${encodeURIComponent(PANE)}/q-1/answer`, {
  method: 'POST', headers: { 'Authorization': `Bearer ${OWNER}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ answer: { action: 'answer', answers: [['Owner email']] }, idempotencyKey: 'http-1' }),
})
const httpJson = await httpRes.json()
check('HTTP answer route accepted (pane id percent-encoded)', httpRes.status === 200 && httpJson.ok === true, `${httpRes.status} ${JSON.stringify(httpJson)}`)
const hook2 = await (await held2).json()
check('question hook resolved with answers', hook2.answer?.answers?.[0]?.[0] === 'Owner email', JSON.stringify(hook2))
const replayHttp = await fetch(`${BASE}/api/agent-requests/${encodeURIComponent(PANE)}/q-1/answer`, {
  method: 'POST', headers: { 'Authorization': `Bearer ${OWNER}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ answer: { action: 'answer', answers: [['Owner email']] }, idempotencyKey: 'http-1' }),
})
const replayJson = await replayHttp.json()
check('HTTP replay with same idempotencyKey is a no-op 200', replayHttp.status === 200 && replayJson.changed === false, `${replayHttp.status} ${JSON.stringify(replayJson)}`)
const unauth = await fetch(`${BASE}/api/agent-requests/${encodeURIComponent(PANE)}/q-1/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
check('HTTP answer route rejects unauthenticated', unauth.status === 401, String(unauth.status))

// --- 3. hook not held when nobody watches ------------------------------
send({ type: 'watch_interactions', enabled: false, requestId: 'wi-2' })
await sleep(200)
const t0 = Date.now()
const unheld = await hookPost('claude', {
  hook_event_name: 'PermissionRequest', session_id: 'sess-e2e', tool_name: 'Bash',
  request: { id: 'perm-2', kind: 'permission', prompt: 'Run tests?', toolName: 'Bash' },
})
const unheldJson = await unheld.json()
check('hook returns immediately with no consumer', Date.now() - t0 < 2000 && unheldJson.answer === undefined, `${Date.now() - t0}ms ${JSON.stringify(unheldJson)}`)

// --- 4. Codex turn complete -------------------------------------------
const codex = await hookPost('codex', { event: { type: 'agent-turn-complete', 'thread-id': 'thr-1', 'turn-id': 't-1', 'input-messages': ['Add retry to the feedback poll'], 'last-assistant-message': '🟢 Added retry with backoff; 12 tests pass.' }, receivedAt: Date.now() })
const codexJson = await codex.json()
const codexStatus = await waitFor((m) => m.type === 'agent_status' && m.status.paneId === PANE && m.status.provider === 'codex' && m.status.status === 'done')
check('Codex agent-turn-complete → hook-sourced done with recap', codex.status === 200 && codexStatus.status.source === 'hook' && codexStatus.status.details?.recap?.summary?.includes('Added retry'), `${JSON.stringify(codexJson)} recap="${codexStatus.status.details?.recap?.summary}" intent="${codexStatus.status.details?.intent}"`)

// --- 5. GET /api/usage + push devices ----------------------------------
const u = await fetch(`${BASE}/api/usage`, { headers: { Authorization: `Bearer ${OWNER}` } })
const uj = await u.json()
check('GET /api/usage', u.status === 200 && Array.isArray(uj.usage), `${u.status} providers=${uj.usage?.length}`)
const put = await fetch(`${BASE}/api/push/devices/phone-1`, { method: 'PUT', headers: { 'Authorization': `Bearer ${OWNER}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expoPushToken: 'ExponentPushToken[e2e-token]', name: 'Leo iPhone', platform: 'ios', rules: { needsInput: true, done: true, failed: true, mutedSessions: [] } }) })
const putJson = await put.json()
check('PUT /api/push/devices/:id', put.status === 200 && putJson.device?.id === 'phone-1', `${put.status} ${JSON.stringify(putJson).slice(0, 120)}`)
const list = await (await fetch(`${BASE}/api/push/devices`, { headers: { Authorization: `Bearer ${OWNER}` } })).json()
check('GET /api/push/devices lists it', list.devices?.length === 1)
const del = await fetch(`${BASE}/api/push/devices/phone-1`, { method: 'DELETE', headers: { Authorization: `Bearer ${OWNER}` } })
check('DELETE /api/push/devices/:id', del.status === 200)

ws.close()
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
