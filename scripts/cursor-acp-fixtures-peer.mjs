// Test-only NDJSON peer. Never launches Cursor or accesses network/auth files.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [scenario, auditPath, phase] = process.argv.slice(2);
const audit = (value) => appendFileSync(auditPath, `${JSON.stringify(value)}\n`);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
audit({
  event: 'boot', phase, pid: process.pid, cwd: process.cwd(), home: process.env.HOME,
  inheritedSecrets: ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'COMMANDO_TOKEN', 'NODE_OPTIONS', 'HTTPS_PROXY']
    .some((key) => Object.hasOwn(process.env, key)),
});
process.stderr.write('fixture-secret@example.test token=fixture-secret\n');
if (phase === '--version') {
  if (scenario === 'version-timeout') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(scenario === 'unsafe-version' ? 'fixture-secret\n' : '2026.10.01-e373342\n');
  }
} else {
  // Ready before initialize: deterministic SIGTERM resistance for timeout tests.
  if (['timeout', 'wrong-id'].includes(scenario)) {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  }
  const rl = createInterface({ input: process.stdin });
  let initId;
  let replies = 0;
  const expectedReplies = 7;
  const result = {
    protocolVersion: scenario === 'unsupported-version' ? 2 : 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      mcpCapabilities: { http: false, sse: true },
      sessionCapabilities: { list: {}, fork: false },
      secret: 'fixture-secret',
    },
    authMethods: [{ id: 'cursor_login', name: 'fixture-secret' }, { id: 'fixture-secret' }],
    agentInfo: { name: 'fixture-secret@example.test', version: 'fixture-secret' },
    _meta: { token: 'fixture-secret' },
  };
  rl.on('line', (line) => {
    const message = JSON.parse(line);
    audit({ event: 'received', message });
    if (message.method !== 'initialize') {
      replies++;
      if (replies === expectedReplies) {
        // Split a response across chunks to exercise NDJSON buffering.
        const encoded = JSON.stringify({ jsonrpc: '2.0', id: initId, result }) + '\n';
        process.stdout.write(encoded.slice(0, 20));
        setTimeout(() => process.stdout.write(encoded.slice(20)), 5);
      }
      return;
    }
    initId = message.id;
    if (scenario === 'timeout') return;
    if (scenario === 'early-exit') return process.exit(7);
    if (scenario === 'malformed') return process.stdout.write('fixture-secret: not JSON\n');
    if (scenario === 'oversized') return process.stdout.write('x'.repeat(65537));
    if (scenario === 'rpc-error') return send({ jsonrpc: '2.0', id: initId, error: { code: -1, message: 'fixture-secret' } });
    if (scenario === 'wrong-id') {
      return send({ jsonrpc: '2.0', id: typeof initId === 'number' ? String(initId) : 0, result });
    }
    if (['unsupported-version', 'unsafe-version'].includes(scenario)) return send({ jsonrpc: '2.0', id: initId, result });
    send({ jsonrpc: '2.0', id: typeof initId === 'number' ? String(initId) : 0, result });
    for (const [method, params] of [
      ['session/update', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture-secret' } } }],
      ['cursor/update_todos', { toolCallId: 'todo1', todos: [{ id: 'one', content: 'First', status: 'pending' }], merge: false }],
      ['cursor/update_todos', { toolCallId: 'todo2', todos: [{ id: 'one', content: 'First', status: 'completed' }], merge: true }],
      ['cursor/task', { toolCallId: 'task', description: 'Explore', prompt: 'fixture-secret', subagentType: 'explore', durationMs: 10 }],
      ['cursor/generate_image', { toolCallId: 'image', description: 'fixture-secret', filePath: '/must-not-read' }],
      ['cursor/ask_question', { questions: [] }],
      ['cursor/create_plan', { plan: 'fixture-secret', todos: [] }],
      ['session/request_permission', { options: [] }],
      ['fixture-secret', { secret: 'fixture-secret' }],
    ]) send({ jsonrpc: '2.0', method, params });
    for (const [id, method, params] of [
      [0, 'session/request_permission', { options: [{ optionId: 'allow-always', kind: 'allow_always' }] }],
      ['q:1', 'cursor/ask_question', { toolCallId: 'q', questions: [{ id: 'q1', prompt: 'Choose', options: [{ id: 'a', label: 'A' }], allowMultiple: true }] }],
      ['plan:1', 'cursor/create_plan', { toolCallId: 'p', plan: 'Do work', todos: [] }],
      ['unknown:1', 'fixture-secret', { token: 'fixture-secret' }],
      ['fs:1', 'fs/write_text_file', { path: '/must-not-write', content: 'fixture-secret' }],
      ['term:1', 'terminal/create', { command: 'must-not-execute' }],
      ['task:1', 'cursor/task', { prompt: 'must-not-execute' }],
    ]) send({ jsonrpc: '2.0', id, method, params });
  });
}
