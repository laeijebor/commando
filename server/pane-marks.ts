import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PaneMark, PaneMarkTone, SessionBrief, SessionBriefUpdate } from '../shared/protocol.js'
import { isCommandoTargetId } from '../shared/pane-target.js'

type StateFile = {
  version: 1
  marks: Record<string, PaneMark>
}

export type PaneMarkInput = {
  label: string
  tone: PaneMarkTone
}

const MAX_MARKS = 256
export const MAX_PANE_MARK_LABEL = 48
const TONES = new Set<PaneMarkTone>(['amber', 'green', 'red', 'purple', 'muted'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.trim()
  if (
    !label ||
    label.length > MAX_PANE_MARK_LABEL ||
    /[\u0000-\u001f\u007f]/.test(label)
  ) return null
  return label
}

export function validatePaneMarkInput(value: unknown): PaneMarkInput {
  if (!isRecord(value)) throw new Error('Pane mark must be a JSON object')
  const label = cleanLabel(value.label)
  if (!label) throw new Error(`Pane mark label must be 1-${MAX_PANE_MARK_LABEL} visible characters`)
  if (typeof value.tone !== 'string' || !TONES.has(value.tone as PaneMarkTone)) {
    throw new Error('Pane mark tone is invalid')
  }
  return { label, tone: value.tone as PaneMarkTone }
}

export function parsePaneMark(value: unknown): PaneMark | null {
  if (!isRecord(value) || !isCommandoTargetId(value.targetId)) return null
  const label = cleanLabel(value.label)
  if (
    !label ||
    typeof value.tone !== 'string' || !TONES.has(value.tone as PaneMarkTone) ||
    !safeInteger(value.markedAt) || !safeInteger(value.activityCount) ||
    (value.lastActivityAt !== undefined && !safeInteger(value.lastActivityAt))
  ) return null
  return {
    targetId: value.targetId,
    label,
    tone: value.tone as PaneMarkTone,
    markedAt: value.markedAt,
    activityCount: value.activityCount,
    ...(value.lastActivityAt !== undefined ? { lastActivityAt: value.lastActivityAt } : {}),
  }
}

function parseState(value: unknown): StateFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.marks)) {
    throw new Error('Pane mark state file has an invalid structure')
  }
  const marks: Record<string, PaneMark> = Object.create(null)
  for (const [targetId, candidate] of Object.entries(value.marks)) {
    const mark = parsePaneMark(candidate)
    if (!mark || mark.targetId !== targetId) {
      throw new Error(`Pane mark state contains an invalid entry for ${targetId}`)
    }
    marks[targetId] = mark
  }
  return { version: 1, marks }
}

function cloneMark(mark: PaneMark): PaneMark {
  return { ...mark }
}

function sameUpdateMeaning(left: SessionBriefUpdate, right: SessionBriefUpdate): boolean {
  if (left.source !== right.source) return false
  if (left.source === 'agent') return left.id === right.id
  return left.author === right.author && left.text === right.text
}

function newMilestones(
  previous: SessionBrief | null,
  current: SessionBrief,
  markedAt: number,
): SessionBriefUpdate[] {
  return current.updates.filter((update) => (
    update.createdAt > markedAt &&
    !previous?.updates.some((candidate) => sameUpdateMeaning(candidate, update))
  ))
}

export function defaultPaneMarkStatePath(): string {
  return process.env.COMMANDO_PANE_MARKS_PATH
    ?? join(homedir(), '.commando', 'pane-marks.json')
}

export class PaneMarkStore {
  readonly statePath: string
  private readonly marks = new Map<string, PaneMark>()
  private writes: Promise<void> = Promise.resolve()

  constructor(statePath = defaultPaneMarkStatePath()) {
    this.statePath = statePath
  }

  async load(): Promise<void> {
    await this.writes
    try {
      const state = parseState(JSON.parse(await readFile(this.statePath, 'utf8')) as unknown)
      this.marks.clear()
      for (const mark of Object.values(state.marks)
        .sort((left, right) => right.markedAt - left.markedAt)
        .slice(0, MAX_MARKS)) {
        this.marks.set(mark.targetId, mark)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      if (error instanceof SyntaxError) {
        throw new Error('Pane mark state file contains invalid JSON', { cause: error })
      }
      throw error
    }
  }

  get(targetId: string): PaneMark | null {
    const mark = this.marks.get(targetId)
    return mark ? cloneMark(mark) : null
  }

  values(): PaneMark[] {
    return [...this.marks.values()]
      .sort((left, right) => right.markedAt - left.markedAt)
      .map(cloneMark)
  }

  async set(targetId: string, input: PaneMarkInput, now = Date.now()): Promise<PaneMark> {
    if (!isCommandoTargetId(targetId)) throw new Error('Invalid pane target id')
    const validated = validatePaneMarkInput(input)
    if (!safeInteger(now)) throw new Error('Invalid pane mark timestamp')
    const mark: PaneMark = {
      targetId,
      ...validated,
      markedAt: now,
      activityCount: 0,
    }
    this.marks.set(targetId, mark)
    this.prune()
    await this.persist()
    return cloneMark(mark)
  }

  async acknowledge(targetId: string): Promise<PaneMark | null> {
    const current = this.marks.get(targetId)
    if (!current) return null
    const mark: PaneMark = {
      ...current,
      activityCount: 0,
      ...(current.lastActivityAt !== undefined ? { lastActivityAt: current.lastActivityAt } : {}),
    }
    this.marks.set(targetId, mark)
    await this.persist()
    return cloneMark(mark)
  }

  async remove(targetId: string): Promise<boolean> {
    if (!this.marks.delete(targetId)) return false
    await this.persist()
    return true
  }

  async retainTargets(targetIds: Iterable<string>): Promise<string[]> {
    const retained = new Set(targetIds)
    const removed: string[] = []
    for (const targetId of this.marks.keys()) {
      if (retained.has(targetId)) continue
      this.marks.delete(targetId)
      removed.push(targetId)
    }
    if (removed.length > 0) await this.persist()
    return removed
  }

  async observeBrief(
    targetId: string,
    previous: SessionBrief | null,
    current: SessionBrief,
  ): Promise<PaneMark | null> {
    const mark = this.marks.get(targetId)
    if (!mark) return null
    const milestones = newMilestones(previous, current, mark.markedAt)
    const meaningfulStateTransition = previous !== null &&
      previous.state !== current.state &&
      current.updatedAt > mark.markedAt &&
      current.state !== 'stale' &&
      current.state !== 'unknown'
    if (milestones.length === 0 && !meaningfulStateTransition) return null
    const activityCount = Math.max(milestones.length, 1)
    const activityAt = milestones.length > 0
      ? Math.max(...milestones.map((update) => update.createdAt))
      : current.updatedAt
    const next: PaneMark = {
      ...mark,
      activityCount: mark.activityCount + activityCount,
      lastActivityAt: Math.max(mark.lastActivityAt ?? 0, activityAt),
    }
    this.marks.set(targetId, next)
    await this.persist()
    return cloneMark(next)
  }

  private prune(): void {
    if (this.marks.size <= MAX_MARKS) return
    const retained = [...this.marks.values()]
      .sort((left, right) => right.markedAt - left.markedAt)
      .slice(0, MAX_MARKS)
    this.marks.clear()
    for (const mark of retained) this.marks.set(mark.targetId, mark)
  }

  private persist(): Promise<void> {
    const operation = this.writes.then(() => this.writeState())
    this.writes = operation.catch(() => undefined)
    return operation
  }

  private async writeState(): Promise<void> {
    const directory = dirname(this.statePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      const marks = Object.fromEntries([...this.marks].map(([targetId, mark]) => [targetId, mark]))
      await handle.writeFile(`${JSON.stringify({ version: 1, marks }, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporaryPath, this.statePath)
      try {
        const directoryHandle = await open(directory, 'r')
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      } catch {
        // Directory fsync is not available on every supported filesystem.
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
