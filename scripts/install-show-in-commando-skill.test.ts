import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repository = fileURLToPath(new URL('../', import.meta.url))
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'commando-skill-install-'))
  directories.push(directory)
  // Both the source checkout and HOME are disposable; no hooks are installed.
  const checkout = join(directory, 'source checkout')
  const home = join(directory, 'test home')
  await mkdir(join(checkout, 'scripts'), { recursive: true })
  await mkdir(home)
  await cp(join(repository, 'scripts/install-show-in-commando-skill'), join(checkout, 'scripts/install-show-in-commando-skill'))
  await cp(join(repository, 'skills'), join(checkout, 'skills'), { recursive: true })
  const roots = ['.claude/skills', '.claudep/skills', '.claudey/skills', '.cursor/skills', '.config/opencode/skills']
    .map((root) => join(home, root))
  return { directory, checkout, home, roots }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function run(f: Fixture, names: string[] = [], options: { inherited?: NodeJS.ProcessEnv; customClaude?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...(options.inherited ?? process.env), HOME: f.home }
  // HOME alone is insufficient: the caller may have an active named profile.
  // Never forward inherited profile paths or shell startup scripts to the child.
  for (const name of ['CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME',
    'COMMANDO_AGENT_HOOK_TOKEN_PATH', 'BASH_ENV', 'ENV']) delete env[name]
  if (options.customClaude) env.CLAUDE_CONFIG_DIR = options.customClaude
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile('bash', [join(f.checkout, 'scripts/install-show-in-commando-skill'), ...names],
      { env, timeout: 10_000 }, (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr })
      })
  })
}

async function files(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = join(prefix, entry.name)
    return entry.isDirectory() ? files(join(directory, entry.name), relative) : [relative]
  }))
  return nested.flat().sort()
}

async function expectDistributed(source: string, destination: string) {
  for (const path of await files(source)) {
    expect(await readFile(join(destination, path)), path).toEqual(await readFile(join(source, path)))
  }
}

describe('Commando skill distribution (isolated HOME and profiles)', () => {
  it('distributes every complete skill, including Redline playbooks and hidden resources, to Cursor and existing roots', async () => {
    const f = await fixture()
    await writeFile(join(f.checkout, 'skills/redline/.resource'), 'hidden supporting resource')
    const result = await run(f)
    expect(result.code, result.stderr).toBe(0)
    for (const root of f.roots) await expectDistributed(join(f.checkout, 'skills'), root)
    expect(await readFile(join(f.home, '.cursor/skills/redline/playbooks/plan.md'), 'utf8'))
      .toBe(await readFile(join(f.checkout, 'skills/redline/playbooks/plan.md'), 'utf8'))
  })

  it('installs only selected names, refreshes their canonical files, and preserves unrelated content on repeat runs', async () => {
    const f = await fixture()
    for (const root of f.roots) {
      await mkdir(join(root, 'personal-skill'), { recursive: true })
      await writeFile(join(root, 'personal-skill/SKILL.md'), 'user skill')
      await mkdir(join(root, 'session-updates'))
      await writeFile(join(root, 'session-updates/SKILL.md'), 'old canonical copy')
      await writeFile(join(root, 'session-updates/local-note.md'), 'user note')
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await run(f, ['session-updates', 'commando-prs'])
      expect(result.code, result.stderr).toBe(0)
      for (const root of f.roots) {
        expect((await readdir(root)).sort()).toEqual(['commando-prs', 'personal-skill', 'session-updates'])
        await expectDistributed(join(f.checkout, 'skills/session-updates'), join(root, 'session-updates'))
        await expectDistributed(join(f.checkout, 'skills/commando-prs'), join(root, 'commando-prs'))
        expect(await readFile(join(root, 'personal-skill/SKILL.md'), 'utf8')).toBe('user skill')
        expect(await readFile(join(root, 'session-updates/local-note.md'), 'utf8')).toBe('user note')
      }
    }
  })

  it.each(['../redline', '.', '', 'Redline', 'missing-skill', 'redline/../session-updates'])
    ('rejects bad selected name %j before writing any destinations, even after a valid name', async (name) => {
      const f = await fixture()
      const result = await run(f, ['session-updates', name])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`Unknown Commando skill: ${name}`)
      expect(await readdir(f.home)).toEqual([])
    })

  it('skips a destination symlinked to the same canonical directory without aborting other installs', async () => {
    const f = await fixture()
    const cursorRoot = join(f.home, '.cursor/skills')
    await mkdir(cursorRoot, { recursive: true })
    const source = join(f.checkout, 'skills/redline')
    const destination = join(cursorRoot, 'redline')
    await symlink(source, destination)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await run(f)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain(`linked    ${destination}`)
      expect((await lstat(destination)).isSymbolicLink()).toBe(true)
      await expectDistributed(source, destination)
      await expectDistributed(join(f.checkout, 'skills'), join(f.home, '.config/opencode/skills'))
    }
  })

  it('supports an explicitly selected custom Claude config outside test HOME but within the disposable sandbox', async () => {
    const f = await fixture()
    const customClaude = join(f.directory, 'custom Claude profile')
    const result = await run(f, ['redline'], { customClaude })
    expect(result.code, result.stderr).toBe(0)
    await expectDistributed(join(f.checkout, 'skills/redline'), join(customClaude, 'skills/redline'))
    for (const root of f.roots) expect(await readdir(root)).toEqual(['redline'])
  })

  it('neutralizes an inherited Claude profile outside test HOME so an isolated run cannot alter it', async () => {
    const f = await fixture()
    // Simulate an active profile inside our disposable sandbox, never the real one.
    const inheritedProfile = join(f.directory, 'inherited active profile')
    await mkdir(join(inheritedProfile, 'skills/session-updates'), { recursive: true })
    await writeFile(join(inheritedProfile, 'skills/session-updates/SKILL.md'), 'do not touch')
    const result = await run(f, ['session-updates'], {
      inherited: { ...process.env, CLAUDE_CONFIG_DIR: inheritedProfile },
    })
    expect(result.code, result.stderr).toBe(0)
    expect(await files(inheritedProfile)).toEqual(['skills/session-updates/SKILL.md'])
    expect(await readFile(join(inheritedProfile, 'skills/session-updates/SKILL.md'), 'utf8')).toBe('do not touch')
    await expectDistributed(join(f.checkout, 'skills/session-updates'), join(f.home, '.cursor/skills/session-updates'))
  })
})
