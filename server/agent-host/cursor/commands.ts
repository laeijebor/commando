import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ChatCommand } from '../../../shared/agent-chat.js'

export const CURSOR_BUILTIN_COMMANDS: readonly ChatCommand[] = [
  { name: 'login', description: 'Log in to Cursor', argumentHint: '[cancel]', kind: 'command' },
  { name: 'clear', description: 'Start a fresh conversation', kind: 'command' },
]

const BUILTIN_NAMES = new Set(CURSOR_BUILTIN_COMMANDS.map((command) => command.name))
const COMMAND_NAME = /^[\w][\w:.@-]{0,127}$/
const MAX_COMMAND_DEPTH = 3
const MAX_DESCRIPTION_LENGTH = 500
const MAX_ARGUMENT_HINT_LENGTH = 200
const MAX_FRONTMATTER_CHARS = 64 * 1024

export interface CommandFrontmatter {
  name?: string
  description?: string
  argumentHint?: string
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function collapseText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed ? collapsed.slice(0, max) : undefined
}

function extractFrontmatterBlock(content: string): string | null {
  const normalized = content.slice(0, MAX_FRONTMATTER_CHARS).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const open = /^---[ \t]*\n/.exec(normalized)
  if (!open) return null
  const bodyStart = open[0].length
  const close = /\n---[ \t]*(?:\n|$)/.exec(normalized.slice(bodyStart))
  if (!close) return null
  return normalized.slice(bodyStart, bodyStart + close.index)
}

function parseFrontmatterFallback(block: string): Record<string, string> {
  const fields: Record<string, string> = {}
  let currentKey: string | null = null
  const lines = block.split('\n')
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      if (currentKey && fields[currentKey]) fields[currentKey] += ' '
      continue
    }
    if (/^[ \t]+/.test(line) && currentKey) {
      fields[currentKey] = fields[currentKey] ? `${fields[currentKey]} ${line.trim()}` : line.trim()
      continue
    }
    const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!match) {
      currentKey = null
      continue
    }
    const key = match[1]!
    const rawValue = match[2]!.trim()
    currentKey = key
    if (rawValue === '>' || rawValue === '>-' || rawValue === '|' || rawValue === '|-') {
      fields[key] = ''
    } else {
      fields[key] = stripQuotes(rawValue)
    }
  }
  return fields
}

function parseFrontmatterRecord(block: string): Record<string, unknown> {
  try {
    const parsed: unknown = parseYaml(block)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Fall back for Markdown frontmatter with unquoted colons in descriptions.
  }
  return parseFrontmatterFallback(block)
}

export function parseCommandFrontmatter(content: string): CommandFrontmatter {
  const block = extractFrontmatterBlock(content)
  if (block === null) return {}
  const fields = parseFrontmatterRecord(block)
  const rawName = typeof fields.name === 'string' ? stripQuotes(fields.name).trim() : undefined
  const description = collapseText(fields.description, MAX_DESCRIPTION_LENGTH)
  const argumentHint = collapseText(fields['argument-hint'] ?? fields.argumentHint, MAX_ARGUMENT_HINT_LENGTH)
  return {
    ...(rawName ? { name: rawName } : {}),
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
  }
}

function buildCommand(content: string, fallbackName: string, kind: ChatCommand['kind']): ChatCommand | null {
  const frontmatter = parseCommandFrontmatter(content)
  const name = frontmatter.name ?? fallbackName
  if (!COMMAND_NAME.test(name)) return null
  return {
    name,
    description: frontmatter.description ?? '',
    ...(frontmatter.argumentHint ? { argumentHint: frontmatter.argumentHint } : {}),
    kind,
  }
}

async function safeReaddir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function discoverCommandsDir(dir: string, prefix: readonly string[] = [], depth = 0): Promise<ChatCommand[]> {
  const entries = await safeReaddir(dir)
  const discovered: ChatCommand[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_COMMAND_DEPTH) {
        discovered.push(...await discoverCommandsDir(fullPath, [...prefix, entry.name], depth + 1))
      }
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (!entry.name.toLowerCase().endsWith('.md')) continue
    const content = await safeReadFile(fullPath)
    if (content === null) continue
    const stem = entry.name.slice(0, -3)
    const command = buildCommand(content, [...prefix, stem].join(':'), 'command')
    if (command) discovered.push(command)
  }
  return discovered
}

async function discoverSkillsDir(dir: string): Promise<ChatCommand[]> {
  const entries = await safeReaddir(dir)
  if (!entries.length) return []
  const discovered: ChatCommand[] = []

  const rootSkill = await safeReadFile(join(dir, 'SKILL.md'))
  if (rootSkill !== null) {
    const command = buildCommand(rootSkill, basename(dir), 'skill')
    if (command) discovered.push(command)
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const content = await safeReadFile(join(dir, entry.name, 'SKILL.md'))
    if (content === null) continue
    const command = buildCommand(content, entry.name, 'skill')
    if (command) discovered.push(command)
  }
  return discovered
}

export async function discoverCursorCommands(
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<ChatCommand[]> {
  const home = env?.HOME || homedir()
  const batches = await Promise.all([
    discoverSkillsDir(join(home, '.claude', 'skills')),
    discoverSkillsDir(join(home, '.cursor', 'skills')),
    discoverCommandsDir(join(home, '.cursor', 'commands')),
    discoverSkillsDir(join(cwd, '.claude', 'skills')),
    discoverSkillsDir(join(cwd, '.cursor', 'skills')),
    discoverCommandsDir(join(cwd, '.cursor', 'commands')),
  ])

  const merged = new Map<string, ChatCommand>()
  for (const batch of batches) {
    for (const command of batch) {
      if (BUILTIN_NAMES.has(command.name)) continue
      merged.set(command.name, command)
    }
  }
  const sorted = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
  return [...CURSOR_BUILTIN_COMMANDS, ...sorted]
}
