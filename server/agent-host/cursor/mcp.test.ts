import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearServerAuth,
  createCursorMcpCli,
  CursorMcpController,
  cursorProjectDir,
  cursorProjectSlug,
  extractCursorMcpAuthUrl,
  findCursorProjectRoot,
  parseCursorMcpConfigFile,
  parseCursorMcpList,
  parseCursorMcpTools,
  stripAnsi,
  type CursorMcpCli,
  type CursorMcpLoginProcess,
} from './mcp.js'

const tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'commando-cursor-mcp-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('Cursor MCP helpers and parsers', () => {
  it('computes workspace slugs and project directories matching Cursor CLI', async () => {
    expect(cursorProjectSlug('/Users/me/dev/my_repo')).toBe('Users-me-dev-my-repo')
    const root = await makeTempDir()
    const nested = join(root, 'packages', 'web')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(nested, { recursive: true })
    expect(findCursorProjectRoot(nested)).toBe(root)

    const home = join(root, 'home')
    expect(cursorProjectDir(nested, {}, home)).toBe(join(home, '.cursor', 'projects', cursorProjectSlug(root)))
    expect(cursorProjectDir(nested, { CURSOR_DATA_DIR: '/custom/cursor-data' }, home)).toBe(
      join('/custom/cursor-data', 'projects', cursorProjectSlug(root)),
    )
  })

  it('parses mcp.json configs without leaking secrets', () => {
    const raw = JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github', '--token', 'ghp_secret123'],
          env: { GITHUB_TOKEN: 'ghp_env_secret' },
        },
        linear: {
          url: 'https://user:pw@mcp.linear.app/mcp?api_key=xyz',
          headers: { Authorization: 'Bearer super_secret' },
        },
        events: {
          type: 'sse',
          url: 'https://mcp.example.com/sse',
        },
      },
    })
    const parsed = parseCursorMcpConfigFile(raw, 'project')
    expect(parsed).toEqual([
      { name: 'github', scope: 'project', transport: 'stdio', target: 'npx -y @modelcontextprotocol/server-github --token •••' },
      { name: 'linear', scope: 'project', transport: 'http', target: 'https://mcp.linear.app/mcp' },
      { name: 'events', scope: 'project', transport: 'sse', target: 'https://mcp.example.com/sse' },
    ])
    expect(JSON.stringify(parsed)).not.toMatch(/secret|pw|xyz/)
    expect(parseCursorMcpConfigFile('not json', 'user')).toEqual([])
  })

  it('parses all Cursor CLI mcp list statuses and strips ANSI escapes', () => {
    const output = [
      'github: \x1b[32mready\x1b[39m',
      'linear: \x1b[33mrequires_authentication\x1b[39m',
      'slow: \x1b[33mloading\x1b[39m',
      'muted: \x1b[2mdisabled\x1b[39m',
      'localproj: \x1b[33mnot loaded (needs approval)\x1b[39m',
      'broken: \x1b[31mError: Connection failed\x1b[39m',
    ].join('\n')
    const parsed = parseCursorMcpList(output)
    expect(parsed.get('github')).toEqual({ status: 'connected' })
    expect(parsed.get('linear')).toEqual({ status: 'needs-auth' })
    expect(parsed.get('slow')).toEqual({ status: 'pending' })
    expect(parsed.get('muted')).toEqual({ status: 'disabled' })
    expect(parsed.get('localproj')).toEqual({ status: 'disabled', error: 'Needs approval in Cursor CLI — enable to approve' })
    expect(parsed.get('broken')).toEqual({ status: 'failed', error: 'Connection failed' })
    expect(parseCursorMcpList('No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)').size).toBe(0)
    expect(stripAnsi('\x1b[31mred\x1b[39m')).toBe('red')
  })

  it('parses agent mcp list-tools output', () => {
    const output = [
      'Tools for github (2):',
      '- create_issue \x1b[2m(owner, repo, title)\x1b[22m',
      '- ping \x1b[2m()\x1b[22m',
    ].join('\n')
    expect(parseCursorMcpTools(output)).toEqual([
      { name: 'create_issue', description: 'Arguments: owner, repo, title' },
      { name: 'ping' },
    ])
    expect(parseCursorMcpTools("No tools available for 'empty'.")).toEqual([])
  })

  it('extracts only the OAuth authorization URL and ignores local callback lines', () => {
    const standard = [
      'Checking status...',
      "MCP 'linear' requires authentication.",
      'Open this URL in your browser:',
      'https://mcp.linear.app/oauth/authorize?client_id=abc&state=123',
      '',
      'Listening on http://localhost:41234/callback for the OAuth callback...',
    ].join('\n')
    expect(extractCursorMcpAuthUrl(standard)).toBe('https://mcp.linear.app/oauth/authorize?client_id=abc&state=123')

    const ssh = [
      'Keep that SSH session open, then open this URL in your local browser:',
      '',
      'https://auth.example.com/start',
      '',
      'Waiting for OAuth callback on http://localhost:9000...',
    ].join('\n')
    expect(extractCursorMcpAuthUrl(ssh)).toBe('https://auth.example.com/start')

    expect(extractCursorMcpAuthUrl('Listening on http://localhost:41234/callback for the OAuth callback...')).toBeUndefined()
    expect(extractCursorMcpAuthUrl('Open this URL in your browser:\njavascript:alert(1)')).toBeUndefined()
  })

  it('clears a single server entry from mcp-auth.json without touching others', async () => {
    const dir = await makeTempDir()
    const authPath = join(dir, 'mcp-auth.json')
    expect(await clearServerAuth(authPath, 'linear')).toBe(false)

    await writeFile(authPath, JSON.stringify({ linear: { tokens: { access_token: 'a' } }, other: { tokens: { access_token: 'b' } } }))
    expect(await clearServerAuth(authPath, 'linear')).toBe(true)
    expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({ other: { tokens: { access_token: 'b' } } })
    expect(await clearServerAuth(authPath, 'linear')).toBe(false)
  })
})

describe('CursorMcpController', () => {
  async function setupWorkspace() {
    const root = await makeTempDir()
    const repo = join(root, 'repo')
    const home = join(root, 'home')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(join(repo, '.cursor'), { recursive: true })
    await mkdir(join(home, '.cursor'), { recursive: true })
    await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp' },
        shared: { url: 'https://user.example.com/mcp' },
      },
    }))
    await writeFile(join(repo, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'server-github'] },
        shared: { command: 'node', args: ['./local-mcp.js'] },
      },
    }))
    return { repo, home }
  }

  it('merges configured servers, live statuses, plugin servers, and caches tool probes', async () => {
    const { repo, home } = await setupWorkspace()
    let now = 1000
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[1] === 'list') {
        return {
          stdout: [
            'github: ready',
            'linear: requires_authentication',
            'shared: disabled',
            'figma-plugin: ready',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        }
      }
      if (args[1] === 'list-tools' && args[3] === 'github') {
        return { stdout: 'Tools for github (1):\n- create_issue (title)', stderr: '', exitCode: 0 }
      }
      if (args[1] === 'list-tools' && args[3] === 'figma-plugin') {
        return { stdout: 'Tools for figma-plugin (1):\n- get_design ()', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const cli: CursorMcpCli = { run, startLogin: vi.fn() }
    const controller = new CursorMcpController({
      cwd: repo,
      env: {},
      home,
      cli,
      now: () => now,
      callbacks: { reloadAgent: vi.fn(async () => undefined), onAuthChanged: vi.fn() },
    })

    // Concurrent status reads coalesce into a single CLI probe.
    const [first, second] = await Promise.all([
      controller.handle({ action: 'status' }),
      controller.handle({ action: 'status' }),
    ])
    expect(first).toEqual(second)
    expect(first.error).toBeUndefined()
    expect(first.servers).toEqual(expect.arrayContaining([
      { name: 'github', status: 'connected', scope: 'project', transport: 'stdio', target: 'npx -y server-github', tools: [{ name: 'create_issue', description: 'Arguments: title' }] },
      { name: 'linear', status: 'needs-auth', scope: 'user', transport: 'http', target: 'https://mcp.linear.app/mcp', tools: [] },
      { name: 'shared', status: 'disabled', scope: 'project', transport: 'stdio', target: 'node ./local-mcp.js', tools: [] },
      { name: 'figma-plugin', status: 'connected', scope: 'plugin', tools: [{ name: 'get_design' }] },
    ]))
    expect(run.mock.calls.filter((call) => call[0][1] === 'list')).toHaveLength(1)
    expect(run.mock.calls.filter((call) => call[0][1] === 'list-tools')).toHaveLength(2)

    // Subsequent poll within TTL reuses cached tools without calling list-tools again.
    now += 5_000
    await controller.handle({ action: 'status' })
    expect(run.mock.calls.filter((call) => call[0][1] === 'list')).toHaveLength(2)
    expect(run.mock.calls.filter((call) => call[0][1] === 'list-tools')).toHaveLength(2)

    // Reconnect invalidates the tool cache for that server and reloads the SDK agent.
    await controller.handle({ action: 'reconnect', server: 'github' })
    expect(run.mock.calls.filter((call) => call[0][1] === 'list-tools' && call[0][3] === 'github')).toHaveLength(2)
  })

  it('enables, disables and reconnects via CLI and reloads the agent', async () => {
    const { repo, home } = await setupWorkspace()
    const reloadAgent = vi.fn(async () => undefined)
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[1] === 'list') return { stdout: 'github: disabled\n', stderr: '', exitCode: 0 }
      return { stdout: 'ok', stderr: '', exitCode: 0 }
    })
    const controller = new CursorMcpController({
      cwd: repo,
      env: {},
      home,
      cli: { run, startLogin: vi.fn() },
      callbacks: { reloadAgent, onAuthChanged: vi.fn() },
    })

    await controller.handle({ action: 'disable', server: 'github' })
    expect(run).toHaveBeenCalledWith(['mcp', 'disable', '--', 'github'], expect.objectContaining({ cwd: repo }))
    expect(reloadAgent).toHaveBeenCalledTimes(1)

    await controller.handle({ action: 'enable', server: 'github' })
    expect(run).toHaveBeenCalledWith(['mcp', 'enable', '--', 'github'], expect.objectContaining({ cwd: repo }))
    expect(reloadAgent).toHaveBeenCalledTimes(2)

    await controller.handle({ action: 'reconnect', server: 'github' })
    expect(reloadAgent).toHaveBeenCalledTimes(3)
  })

  it('falls back to mcp-disabled.json when the Cursor CLI is missing', async () => {
    const { repo, home } = await setupWorkspace()
    const reloadAgent = vi.fn(async () => undefined)
    const controller = new CursorMcpController({
      cwd: repo,
      env: {},
      home,
      cli: null,
      callbacks: { reloadAgent, onAuthChanged: vi.fn() },
    })

    const initial = await controller.handle({ action: 'status' })
    expect(initial.servers.map((server) => server.name).sort()).toEqual(['github', 'linear', 'shared'])
    expect(initial.error).toMatch(/Cursor CLI/)

    const disabled = await controller.handle({ action: 'disable', server: 'github' })
    expect(disabled.servers.find((server) => server.name === 'github')?.status).toBe('disabled')
    expect(reloadAgent).toHaveBeenCalledTimes(1)

    const enabled = await controller.handle({ action: 'enable', server: 'github' })
    expect(enabled.servers.find((server) => server.name === 'github')?.status).toBe('pending')
    expect(reloadAgent).toHaveBeenCalledTimes(2)

    const authErr = await controller.handle({ action: 'authenticate', server: 'linear' })
    expect(authErr.error).toMatch(/Cursor CLI/)
  })

  it('returns authUrl during authenticate, notifies on background completion, and cleans up on clear_auth/dispose', async () => {
    const { repo, home } = await setupWorkspace()
    const onAuthChanged = vi.fn()
    const reloadAgent = vi.fn(async () => undefined)
    const loginDone = deferred<{ ok: boolean; error?: string }>()
    const cancel = vi.fn()
    const loginProcess: CursorMcpLoginProcess = {
      authUrl: Promise.resolve('https://mcp.linear.app/oauth/authorize?state=abc'),
      done: loginDone.promise,
      cancel,
    }
    const cli: CursorMcpCli = {
      run: vi.fn(async () => ({ stdout: 'linear: requires_authentication\n', stderr: '', exitCode: 0 })),
      startLogin: vi.fn(async () => loginProcess),
    }
    const controller = new CursorMcpController({
      cwd: repo,
      env: {},
      home,
      cli,
      callbacks: { reloadAgent, onAuthChanged },
    })

    const result = await controller.handle({ action: 'authenticate', server: 'linear' })
    expect(result.authUrl).toBe('https://mcp.linear.app/oauth/authorize?state=abc')
    expect(onAuthChanged).not.toHaveBeenCalled()

    // Background callback completes -> notifies session so it can refresh cached credentials.
    loginDone.resolve({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onAuthChanged).toHaveBeenCalledWith('linear')

    // Write auth token and clear it via clear_auth.
    const authPath = join(cursorProjectDir(repo, {}, home), 'mcp-auth.json')
    await mkdir(join(cursorProjectDir(repo, {}, home)), { recursive: true })
    await writeFile(authPath, JSON.stringify({ linear: { tokens: { access_token: 'tok' } } }))
    await controller.handle({ action: 'clear_auth', server: 'linear' })
    expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({})
    expect(onAuthChanged).toHaveBeenCalledTimes(2)

    // Starting a new login and disposing cancels the background login process.
    const secondDone = deferred<{ ok: boolean; error?: string }>()
    const secondCancel = vi.fn()
    vi.mocked(cli.startLogin).mockResolvedValueOnce({
      authUrl: Promise.resolve('https://mcp.linear.app/oauth/authorize?state=def'),
      done: secondDone.promise,
      cancel: secondCancel,
    })
    await controller.handle({ action: 'authenticate', server: 'linear' })
    controller.dispose()
    expect(secondCancel).toHaveBeenCalledTimes(1)
  })
})

describe('createCursorMcpCli subprocess integration', () => {
  it('streams authUrl from a child process, stays alive until callback, and supports cancel', async () => {
    const dir = await makeTempDir()
    const fakeBin = join(dir, 'fake-agent.mjs')
    await writeFile(fakeBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('list')) {
  process.stdout.write('demo: ready\\n');
  process.exit(0);
}
if (args.includes('login')) {
  process.stdout.write("MCP 'demo' requires authentication.\\nOpen this URL in your browser:\\nhttps://auth.example.test/oauth?state=ok\\n\\nListening on http://localhost:9999 for the OAuth callback...\\n");
  setTimeout(() => process.exit(0), 120);
}
`)
    await chmod(fakeBin, 0o755)

    const cli = createCursorMcpCli(fakeBin)
    const listed = await cli.run(['mcp', 'list'], { cwd: dir, env: process.env, timeoutMs: 5_000 })
    expect(listed).toEqual({ stdout: 'demo: ready\n', stderr: '', exitCode: 0 })

    const login = await cli.startLogin('demo', { cwd: dir, env: process.env, timeoutMs: 5_000 })
    expect(await login.authUrl).toBe('https://auth.example.test/oauth?state=ok')
    expect(await login.done).toEqual({ ok: true })
  })
})
