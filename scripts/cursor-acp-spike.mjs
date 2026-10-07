#!/usr/bin/env node
// Initialize-only feasibility probe. No auth, sessions, model prompts, or approvals.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HELP = `Cursor ACP initialize-only spike (no subprocess unless --live)
Usage: node scripts/cursor-acp-spike.mjs --live [--timeout-ms 10000] [--agent /path/to/agent]
Timeout: 100–30000 ms across version + initialize, plus owned-child cleanup.
Uses disposable HOME/config/workspace; inherited credentials are excluded.
Never authenticates, creates/loads a session, prompts a model, or approves a request.
`;
const has = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const rpcId = (value) => typeof value === 'string' || Number.isSafeInteger(value);
const cancelled = { outcome: { outcome: 'cancelled' } };
const knownNotifications = ['session/update', 'cursor/update_todos', 'cursor/task', 'cursor/generate_image'];

// Only known boolean capability paths and constant identifiers enter the report.
// Do not redact arbitrary agent metadata: exclude it instead.
export function summarizeInitialize(value) {
  if (!record(value) || !Number.isSafeInteger(value.protocolVersion)) {
    throw new Error('invalid_initialize_result');
  }
  const caps = record(value.agentCapabilities) ? value.agentCapabilities : {};
  const summary = {};
  for (const path of [
    'loadSession', 'promptCapabilities.image', 'promptCapabilities.audio',
    'promptCapabilities.embeddedContext', 'mcpCapabilities.http', 'mcpCapabilities.sse',
    'sessionCapabilities.list', 'sessionCapabilities.fork', 'sessionCapabilities.resume',
  ]) {
    const parts = path.split('.');
    let current = caps;
    for (const part of parts) current = record(current) ? current[part] : undefined;
    // Some session capabilities are empty objects, not booleans.
    if (typeof current === 'boolean') summary[path] = current;
    else if (path.startsWith('sessionCapabilities.') && record(current)) summary[path] = true;
  }
  const auth = Array.isArray(value.authMethods) ? value.authMethods : [];
  return {
    protocolVersion: value.protocolVersion,
    agentCapabilities: summary,
    authMethodIds: auth.some((method) => record(method) && method.id === 'cursor_login') ? ['cursor_login'] : [],
    unreportedAuthMethodCount: auth.filter((method) => !record(method) || method.id !== 'cursor_login').length,
    agentInfoReported: false,
    unrecognizedMetadataOmitted: true,
  };
}

async function executablePath(executable) {
  if (isAbsolute(executable) || executable.includes('/')) return resolve(executable);
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory, executable);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  throw new Error('executable_not_found');
}

async function isolation() {
  const root = await mkdtemp(join(tmpdir(), 'cursor-acp-spike-'));
  try {
    const home = join(root, 'home');
    const cwd = join(root, 'workspace');
    const config = join(root, 'config');
    await Promise.all([home, cwd, config, join(root, 'cache'), join(root, 'data'), join(root, 'tmp')]
      .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
    for (const directory of [join(home, '.cursor'), join(cwd, '.cursor')]) {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'mcp.json'), '{"mcpServers":{}}\n', { mode: 0o600 });
    }
    return {
      root, cwd,
      // No spread of process.env: API keys, auth tokens, NODE_OPTIONS, proxy,
      // tmux, Commando tokens, and caller configuration overrides are absent.
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(root, 'cache'),
        XDG_DATA_HOME: join(root, 'data'), CURSOR_CONFIG_DIR: join(config, 'cursor'),
        TMPDIR: join(root, 'tmp'), LANG: 'en_US.UTF-8', NO_COLOR: '1',
      },
    };
  } catch {
    await rm(root, { recursive: true, force: true });
    throw new Error('isolation_failed');
  }
}

function ownedChild(executable, args, options) {
  const child = spawn(executable, args, { ...options, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  const lifecycle = { exitObserved: false, forcedKill: false, code: null, signal: null };
  let spawnFailed = false;
  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      Object.assign(lifecycle, { exitObserved: true, code, signal });
      resolveExit();
    });
    child.once('error', () => { spawnFailed = true; resolveExit(); });
  });
  const closed = new Promise((resolveClose) => child.once('close', resolveClose));
  child.stdin.on('error', () => {}); // EPIPE is handled by the child lifecycle.
  return {
    child, lifecycle, closed,
    async cleanup() {
      if (!lifecycle.exitObserved && !spawnFailed) {
        child.stdin.end();
        child.kill('SIGTERM');
        const timer = setTimeout(() => {
          if (!lifecycle.exitObserved) { lifecycle.forcedKill = true; child.kill('SIGKILL'); }
        }, 250);
        try { await exited; } finally { clearTimeout(timer); }
      }
      child.stdin.destroy();
      child.stdout.destroy();
    },
  };
}

async function inspectVersion(executable, args, options, timeoutMs, signal) {
  const owned = ownedChild(executable, [...args, '--version'], options);
  let output = '';
  let oversized = false;
  owned.child.stdout.setEncoding('utf8');
  owned.child.stdout.on('data', (chunk) => {
    if (output.length + chunk.length > 4096) oversized = true;
    else output += chunk;
  });
  let timer;
  let timedOut = false;
  let onAbort;
  const aborted = new Promise((resolveAbort) => { onAbort = resolveAbort; });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    await Promise.race([
      owned.closed,
      aborted,
      new Promise((resolveTimeout) => { timer = setTimeout(() => { timedOut = true; resolveTimeout(); }, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await owned.cleanup();
  }
  // Match the complete output. No stderr or arbitrary version metadata is printed.
  const version = !timedOut && !oversized && owned.lifecycle.code === 0 &&
    /^\d{4}\.\d{2}\.\d{2}-[a-f0-9]{7,40}\s*$/.test(output) ? output.trim() : null;
  return { version, timedOut, cleanup: owned.lifecycle };
}

async function initialize(executable, args, options, timeoutMs, initializeId, signal) {
  const owned = ownedChild(executable, [...args, 'acp'], options);
  const counters = { requestsCancelled: 0, requestsUnsupported: 0, unmatchedResponses: 0, notifications: {} };
  let buffer = '';
  let totalBytes = 0;
  let finished = false;
  let timer;
  let settle;
  const result = new Promise((resolveResult) => { settle = resolveResult; });
  const finish = (value) => { if (!finished) { finished = true; settle(value); } };
  const write = (value) => owned.child.stdin.write(`${JSON.stringify(value)}\n`);
  const receive = (message) => {
    if (!record(message) || message.jsonrpc !== '2.0') return finish({ status: 'invalid_envelope' });
    if (has(message, 'method')) {
      if (typeof message.method !== 'string' || has(message, 'result') || has(message, 'error')) {
        return finish({ status: 'invalid_envelope' });
      }
      if (!has(message, 'id')) {
        const key = knownNotifications.includes(message.method) ? message.method : 'other';
        counters.notifications[key] = (counters.notifications[key] ?? 0) + 1;
        return; // Notifications are NEVER answered, even known blocking methods.
      }
      if (!rpcId(message.id)) return finish({ status: 'invalid_envelope' });
      if (['session/request_permission', 'cursor/ask_question', 'cursor/create_plan'].includes(message.method)) {
        counters.requestsCancelled++;
        write({ jsonrpc: '2.0', id: message.id, result: cancelled });
      } else {
        counters.requestsUnsupported++;
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported method' } });
      }
      return;
    }
    if (!rpcId(message.id) || has(message, 'result') === has(message, 'error')) {
      return finish({ status: 'invalid_envelope' });
    }
    // Strict comparison distinguishes numeric 0 from string "0". Method-bearing
    // messages above are server requests even if their ID equals our pending ID.
    if (message.id !== initializeId) { counters.unmatchedResponses++; return; }
    if (has(message, 'error')) return finish({ status: 'initialize_rpc_error' });
    try {
      const advertised = summarizeInitialize(message.result);
      finish({ status: advertised.protocolVersion === 1 ? 'initialized' : 'unsupported_protocol_version', advertised });
    } catch { finish({ status: 'invalid_initialize_result' }); }
  };
  owned.child.stdout.setEncoding('utf8');
  owned.child.stdout.on('data', (chunk) => {
    if (finished) return;
    totalBytes += Buffer.byteLength(chunk);
    buffer += chunk;
    if (totalBytes > 1024 * 1024) return finish({ status: 'output_limit' });
    let newline;
    while (!finished && (newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > 64 * 1024) return finish({ status: 'output_limit' });
      try { receive(JSON.parse(line)); } catch { finish({ status: 'invalid_json' }); }
    }
    if (Buffer.byteLength(buffer) > 64 * 1024) finish({ status: 'output_limit' });
  });
  owned.child.once('error', () => finish({ status: 'spawn_failed' }));
  owned.child.once('close', () => finish({ status: 'child_exited_before_initialize' }));
  const onAbort = () => finish({ status: 'cancelled' });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
  write({
    jsonrpc: '2.0', id: initializeId, method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'commando-cursor-acp-spike', version: '0.1.0' },
    },
  });
  try { return { ...await result, counters, cleanup: owned.lifecycle }; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); await owned.cleanup(); }
}

// argsPrefix/initializeId are for deterministic fake stdio peers, not CLI flags.
export async function runProbe({ agent = 'agent', timeoutMs = 10000, argsPrefix = [], initializeId = 0, signal } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000 || !rpcId(initializeId)) {
    throw new Error('invalid_probe_options');
  }
  const start = Date.now();
  let isolated;
  const report = { status: 'probe_failed', installedVersion: null, timeoutMs, isolationRemoved: false };
  try {
    const executable = await executablePath(agent);
    isolated = await isolation();
    if (signal?.aborted) throw new Error('cancelled');
    const options = { cwd: isolated.cwd, env: isolated.env };
    const remaining = () => Math.max(1, timeoutMs - (Date.now() - start));
    const version = await inspectVersion(executable, argsPrefix, options, remaining(), signal);
    report.installedVersion = version.version;
    report.versionCleanup = version.cleanup;
    if (signal?.aborted) report.status = 'cancelled';
    else if (version.timedOut || Date.now() - start >= timeoutMs) report.status = 'timeout';
    else Object.assign(report, await initialize(executable, argsPrefix, options, remaining(), initializeId, signal));
  } catch (error) {
    const safe = ['executable_not_found', 'isolation_failed', 'cancelled'];
    report.status = safe.includes(error?.message) ? error.message : 'probe_failed';
  } finally {
    if (isolated) {
      try { await rm(isolated.root, { recursive: true, force: true }); report.isolationRemoved = true; }
      catch { report.status = 'isolation_cleanup_failed'; }
    }
  }
  return report;
}

async function main(argv) {
  if (argv.length === 0 || argv.includes('--help')) { process.stdout.write(HELP); return; }
  let live = false;
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--live') live = true;
    else if (flag === '--agent' && argv[index + 1] && !argv[index + 1].startsWith('--')) options.agent = argv[++index];
    else if (flag === '--timeout-ms' && /^\d+$/.test(argv[index + 1] ?? '')) options.timeoutMs = Number(argv[++index]);
    else throw new Error('invalid_cli_options');
  }
  if (!live) { process.stdout.write(HELP); return; }
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  try {
    const report = await runProbe({ ...options, signal: controller.signal });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'initialized') process.exitCode = 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Invalid probe options or probe failure. Use --help.\n');
    process.exitCode = 1;
  });
}
