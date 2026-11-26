import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseHostMessage } from '../../../shared/agent-chat.js'
import { CURSOR_BUILTIN_COMMANDS, discoverCursorCommands, parseCommandFrontmatter } from './commands.js'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'commando-cursor-commands-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('parseCommandFrontmatter', () => {
  it('parses quoted, multiline, and fallback YAML frontmatter cleanly', () => {
    expect(parseCommandFrontmatter([
      '---',
      'name: "deploy-app"',
      'description: >',
      '  Build and deploy',
      '  the service safely.',
      'argument-hint: "[env]"',
      '---',
      '# Body',
    ].join('\n'))).toEqual({
      name: 'deploy-app',
      description: 'Build and deploy the service safely.',
      argumentHint: '[env]',
    })

    expect(parseCommandFrontmatter([
      '---',
      "name: 'review'",
      'description: Use when: reviewing PRs: fast and clean',
      'argumentHint: "<pr-number>"',
      '---',
    ].join('\n'))).toEqual({
      name: 'review',
      description: 'Use when: reviewing PRs: fast and clean',
      argumentHint: '<pr-number>',
    })

    const long = parseCommandFrontmatter(`---\ndescription: ${'x'.repeat(600)}\n---\n`)
    expect(long.description?.length).toBe(500)
    expect(parseCommandFrontmatter('# No frontmatter')).toEqual({})
  })
})

describe('discoverCursorCommands', () => {
  it('returns built-in commands when directories are missing', async () => {
    const root = await makeTempDir()
    const commands = await discoverCursorCommands(join(root, 'missing-cwd'), { HOME: join(root, 'missing-home') })
    expect(commands).toEqual(CURSOR_BUILTIN_COMMANDS)
  })

  it('discovers project and user commands and skills with project overriding user and built-ins protected', async () => {
    const root = await makeTempDir()
    const cwd = join(root, 'project')
    const home = join(root, 'home')

    // User commands and skills
    await mkdir(join(home, '.cursor', 'commands', 'git'), { recursive: true })
    await mkdir(join(home, '.cursor', 'skills', 'shared-skill'), { recursive: true })
    await mkdir(join(home, '.cursor', 'skills', 'user-only'), { recursive: true })
    await mkdir(join(home, '.claude', 'skills', 'claude-skill'), { recursive: true })
    await mkdir(join(home, '.claude', 'skills', 'clear'), { recursive: true })

    await writeFile(join(home, '.cursor', 'commands', 'shared-cmd.md'), '---\ndescription: User shared command\n---\n')
    await writeFile(join(home, '.cursor', 'commands', 'git', 'squash.md'), '---\ndescription: Squash commits\nargument-hint: "[count]"\n---\n')
    await writeFile(join(home, '.cursor', 'commands', 'login.md'), '---\ndescription: Attempt to override login\n---\n')
    await writeFile(join(home, '.cursor', 'skills', 'shared-skill', 'SKILL.md'), '---\ndescription: User shared skill\n---\n')
    await writeFile(join(home, '.cursor', 'skills', 'user-only', 'SKILL.md'), '---\ndescription: Only in user home\n---\n')
    await writeFile(join(home, '.claude', 'skills', 'claude-skill', 'SKILL.md'), '---\nname: claude-helper\ndescription: From claude skills\n---\n')
    await writeFile(join(home, '.claude', 'skills', 'clear', 'SKILL.md'), '---\ndescription: Attempt to override clear\n---\n')

    // Project commands and skills
    await mkdir(join(cwd, '.cursor', 'commands', 'sub', 'nested', 'deep', 'too-deep'), { recursive: true })
    await mkdir(join(cwd, '.cursor', 'skills', 'shared-skill'), { recursive: true })
    await mkdir(join(cwd, '.claude', 'skills', 'proj-claude'), { recursive: true })

    await writeFile(join(cwd, '.cursor', 'commands', 'shared-cmd.md'), '---\ndescription: Project shared command\n---\n')
    await writeFile(join(cwd, '.cursor', 'commands', 'plain.md'), '# No frontmatter command\n')
    await writeFile(join(cwd, '.cursor', 'commands', 'has space.md'), '# Invalid filename with whitespace\n')
    await writeFile(join(cwd, '.cursor', 'commands', 'bad-fm.md'), '---\nname: "bad name"\ndescription: Should be skipped\n---\n')
    await writeFile(join(cwd, '.cursor', 'commands', 'sub', 'nested', 'deep', 'ok.md'), '---\ndescription: Depth 3 ok\n---\n')
    await writeFile(join(cwd, '.cursor', 'commands', 'sub', 'nested', 'deep', 'too-deep', 'skip.md'), '---\ndescription: Depth 4 skipped\n---\n')
    await writeFile(join(cwd, '.cursor', 'skills', 'SKILL.md'), '---\nname: root-skill\ndescription: Root skill file\n---\n')
    await writeFile(join(cwd, '.cursor', 'skills', 'shared-skill', 'SKILL.md'), '---\ndescription: Project shared skill\n---\n')
    await writeFile(join(cwd, '.claude', 'skills', 'proj-claude', 'SKILL.md'), '---\ndescription: Project claude skill\n---\n')

    const commands = await discoverCursorCommands(cwd, { HOME: home })

    // Built-ins stay first and are never overwritten.
    expect(commands.slice(0, CURSOR_BUILTIN_COMMANDS.length)).toEqual(CURSOR_BUILTIN_COMMANDS)

    const byName = new Map(commands.map((command) => [command.name, command]))
    expect(byName.get('login')).toEqual(CURSOR_BUILTIN_COMMANDS[0])
    expect(byName.get('clear')).toEqual(CURSOR_BUILTIN_COMMANDS[1])
    expect(byName.get('shared-cmd')).toEqual({ name: 'shared-cmd', description: 'Project shared command', kind: 'command' })
    expect(byName.get('shared-skill')).toEqual({ name: 'shared-skill', description: 'Project shared skill', kind: 'skill' })
    expect(byName.get('git:squash')).toEqual({ name: 'git:squash', description: 'Squash commits', argumentHint: '[count]', kind: 'command' })
    expect(byName.get('plain')).toEqual({ name: 'plain', description: '', kind: 'command' })
    expect(byName.get('sub:nested:deep:ok')).toEqual({ name: 'sub:nested:deep:ok', description: 'Depth 3 ok', kind: 'command' })
    expect(byName.has('sub:nested:deep:too-deep:skip')).toBe(false)
    expect(byName.has('has space')).toBe(false)
    expect(byName.has('bad name')).toBe(false)
    expect(byName.has('bad-fm')).toBe(false)
    expect(byName.get('root-skill')).toEqual({ name: 'root-skill', description: 'Root skill file', kind: 'skill' })
    expect(byName.get('user-only')).toEqual({ name: 'user-only', description: 'Only in user home', kind: 'skill' })
    expect(byName.get('claude-helper')).toEqual({ name: 'claude-helper', description: 'From claude skills', kind: 'skill' })
    expect(byName.get('proj-claude')).toEqual({ name: 'proj-claude', description: 'Project claude skill', kind: 'skill' })

    // Every emitted command survives host-to-daemon protocol validation.
    const parsed = parseHostMessage({ type: 'commands', paneId: '%1', commands })
    expect(parsed).toEqual({ type: 'commands', paneId: '%1', commands })
  })
})
