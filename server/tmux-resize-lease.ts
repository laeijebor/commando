import type { LayoutSpec } from '../shared/protocol.js'
import { layoutSpecPaneIds } from '../shared/window-layout.js'
import { buildScaledTmuxLayout, buildTmuxLayout } from './tmux-layout.js'

const FIELD_SEPARATOR = '\u001f'
const PANE_ID = /^%\d+$/
const WINDOW_ID = /^@\d+$/
const WINDOW_FORMAT = [
  '#{window_id}',
  '#{window_width}',
  '#{window_height}',
  '#{window_layout}',
  '#{window_zoomed_flag}',
].join(FIELD_SEPARATOR)
const ACTIVE_PANE_FORMAT = ['#{pane_id}', '#{pane_active}'].join(FIELD_SEPARATOR)

export type TmuxResizeCommandRunner = (args: readonly string[]) => Promise<string>

type WindowBaseline = {
  windowId: string
  width: number
  height: number
  layout: string
  activePaneId: string
  paneOrder: string[]
  zoomed: boolean
  explicitWindowSize: string | null
}

type ResizeLease = WindowBaseline & {
  ownerId: string
  mode:
    | { kind: 'focused'; paneId: string; cols: number; rows: number }
    | { kind: 'layout'; fingerprint: string }
}

export class TmuxResizeLeaseBusyError extends Error {
  constructor() {
    super('Another browser is already resizing this tmux window')
    this.name = 'TmuxResizeLeaseBusyError'
  }
}

function oneLine(output: string, label: string): string {
  const lines = output.trim().split(/\r?\n/).filter(Boolean)
  if (lines.length !== 1) throw new Error(`Unable to inspect tmux ${label}`)
  return lines[0]
}

function positiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid tmux ${label}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid tmux ${label}`)
  return parsed
}

type ScheduleRestore = (callback: () => void, delayMs: number) => () => void

type PendingRestore = {
  lease: ResizeLease
  cancelled: boolean
  cancel: () => void
}

const RESTORE_GRACE_MS = 2_000

const defaultSchedule: ScheduleRestore = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}

export class TmuxResizeLeaseManager {
  private readonly leasesByOwner = new Map<string, Map<string, ResizeLease>>()
  private readonly ownersByWindow = new Map<string, string>()
  private readonly pendingRestores = new Map<string, PendingRestore>()
  private queue: Promise<void> = Promise.resolve()
  private readonly schedule: ScheduleRestore
  private readonly restoreGraceMs: number

  constructor(
    private readonly run: TmuxResizeCommandRunner,
    options?: { schedule?: ScheduleRestore; restoreGraceMs?: number },
  ) {
    this.schedule = options?.schedule ?? defaultSchedule
    this.restoreGraceMs = options?.restoreGraceMs ?? RESTORE_GRACE_MS
  }

  resize(ownerId: string, paneId: string, cols: number, rows: number): Promise<boolean> {
    if (!ownerId || !PANE_ID.test(paneId)) return Promise.reject(new Error('Invalid resize owner or pane'))
    return this.enqueue(async () => {
      let lease = this.leaseForPane(ownerId, paneId)
      if (
        lease?.mode.kind === 'focused' &&
        lease.mode.paneId === paneId &&
        lease.mode.cols === cols &&
        lease.mode.rows === rows
      ) {
        return false
      }

      const acquired = !lease
      lease ??= await this.acquire(ownerId, paneId)
      try {
        await this.resizeWindow(lease.windowId, cols, rows)
        const state = await this.inspectCurrentWindow(lease.windowId)
        if (state.zoomed && state.activePaneId !== paneId && state.activePaneId) {
          await this.run(['resize-pane', '-Z', '-t', state.activePaneId])
        }
        if (state.activePaneId !== paneId) await this.run(['select-pane', '-t', paneId])
        if (!state.zoomed || state.activePaneId !== paneId) {
          await this.run(['resize-pane', '-Z', '-t', paneId])
        }
        lease.mode = { kind: 'focused', paneId, cols, rows }
        return true
      } catch (error) {
        if (acquired) await this.restore(lease).catch(() => undefined)
        throw error
      }
    })
  }

  applyLayout(
    ownerId: string,
    windowId: string,
    spec: LayoutSpec,
  ): Promise<boolean> {
    const paneIds = layoutSpecPaneIds(spec)
    if (!ownerId || !WINDOW_ID.test(windowId) || paneIds.length === 0) {
      return Promise.reject(new Error('Invalid authoritative layout owner or window'))
    }
    const built = buildTmuxLayout(spec)
    const fingerprint = JSON.stringify([windowId, spec])
    return this.enqueue(async () => {
      let lease = this.leasesByOwner.get(ownerId)?.get(windowId)
      const acquired = !lease
      lease ??= await this.acquire(ownerId, paneIds[0])
      if (lease.windowId !== windowId) {
        if (acquired) await this.restore(lease).catch(() => undefined)
        throw new Error('Authoritative layout pane does not belong to the requested window')
      }
      if (lease.mode.kind === 'layout' && lease.mode.fingerprint === fingerprint) {
        const currentWindow = await this.inspectCurrentWindow(windowId)
        if (
          !currentWindow.zoomed &&
          currentWindow.width === built.cols &&
          currentWindow.height === built.rows &&
          currentWindow.layout === built.layout
        ) return false
      }

      try {
        const current = await this.inspectPaneState(windowId)
        if (
          current.order.length !== paneIds.length ||
          current.order.some((paneId) => !paneIds.includes(paneId))
        ) {
          throw new Error('Authoritative layout must include every pane in the tmux window')
        }
        const windowState = await this.inspectCurrentWindow(windowId)
        if (windowState.zoomed && windowState.activePaneId) {
          await this.run(['resize-pane', '-Z', '-t', windowState.activePaneId])
        }
        await this.reorderPanes(windowId, paneIds, current.order)
        await this.resizeWindow(windowId, built.cols, built.rows)
        await this.run(['select-layout', '-t', windowId, built.layout])
        if (current.activePaneId && paneIds.includes(current.activePaneId)) {
          await this.run(['select-pane', '-t', current.activePaneId])
        }
        lease.mode = { kind: 'layout', fingerprint }
        return true
      } catch (error) {
        if (acquired) await this.restore(lease).catch(() => undefined)
        throw error
      }
    })
  }

  /**
   * One-shot structural layout change at the window's current size, without
   * taking a resize lease. Leaf cols/rows in the spec act as relative weights.
   */
  setLayout(windowId: string, spec: LayoutSpec): Promise<boolean> {
    const paneIds = layoutSpecPaneIds(spec)
    if (!WINDOW_ID.test(windowId) || paneIds.length === 0) {
      return Promise.reject(new Error('Invalid tmux window layout request'))
    }
    return this.enqueue(async () => {
      const current = await this.inspectPaneState(windowId)
      if (
        current.order.length !== paneIds.length ||
        current.order.some((paneId) => !paneIds.includes(paneId))
      ) {
        throw new Error('Window layout must include every pane in the tmux window')
      }
      const windowState = await this.inspectCurrentWindow(windowId)
      if (windowState.zoomed && windowState.activePaneId) {
        await this.run(['resize-pane', '-Z', '-t', windowState.activePaneId])
      }
      const built = buildScaledTmuxLayout(spec, windowState.width, windowState.height)
      await this.reorderPanes(windowId, paneIds, current.order)
      await this.run(['select-layout', '-t', windowId, built.layout])
      if (current.activePaneId && paneIds.includes(current.activePaneId)) {
        await this.run(['select-pane', '-t', current.activePaneId])
      }
      // A held (or grace-pending) lease restores its baseline later; fold the
      // new structure into that baseline so the restore does not undo an
      // explicit layout edit.
      const ownerId = this.ownersByWindow.get(windowId)
      const pending = this.pendingRestores.get(windowId)
      const lease = (ownerId ? this.leasesByOwner.get(ownerId)?.get(windowId) : undefined) ??
        (pending && !pending.cancelled ? pending.lease : undefined)
      if (lease) {
        lease.layout = buildScaledTmuxLayout(spec, lease.width, lease.height).layout
        lease.paneOrder = [...paneIds]
        lease.zoomed = false
      }
      return true
    })
  }

  release(ownerId: string, expectedPaneId?: string): Promise<boolean> {
    return this.enqueue(async () => {
      const leases = this.leasesByOwner.get(ownerId)
      if (!leases) return false
      if (expectedPaneId) {
        const lease = [...leases.values()].find(
          (candidate) =>
            candidate.mode.kind === 'focused' && candidate.mode.paneId === expectedPaneId,
        )
        if (!lease) return false
        this.deferRestore(lease)
        return true
      }
      for (const lease of [...leases.values()]) {
        this.deferRestore(lease)
      }
      return true
    })
  }

  releaseWindow(ownerId: string, windowId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const lease = this.leasesByOwner.get(ownerId)?.get(windowId)
      if (!lease) return false
      this.deferRestore(lease)
      return true
    })
  }

  releaseWindowForAll(windowId: string): Promise<boolean> {
    if (!WINDOW_ID.test(windowId)) return Promise.reject(new Error('Invalid tmux window id'))
    return this.enqueue(async () => {
      const pending = this.consumePendingRestore(windowId)
      if (pending) {
        await this.restore(pending)
        return true
      }
      const ownerId = this.ownersByWindow.get(windowId)
      const lease = ownerId ? this.leasesByOwner.get(ownerId)?.get(windowId) : undefined
      if (!lease) return false
      await this.restore(lease)
      return true
    })
  }

  releaseAll(): Promise<void> {
    return this.enqueue(async () => {
      for (const [windowId] of [...this.pendingRestores]) {
        const pending = this.consumePendingRestore(windowId)
        if (pending) await this.finalRelease(pending).catch(() => undefined)
      }
      const leases = [...this.leasesByOwner.values()].flatMap((ownerLeases) => [
        ...ownerLeases.values(),
      ])
      for (const lease of leases) {
        await this.finalRelease(lease).catch(() => undefined)
      }
    })
  }

  /**
   * Releasing on a focus switch is almost always followed by the next active
   * client acquiring the same window. Restoring the baseline in between makes
   * tmux flap through `window-size latest` (snapping shared windows to any
   * plain terminal attachment) and races the successor's acquire into
   * `resize_window_busy`. Instead, free the lease immediately but hold the
   * baseline for a grace period: a successor inherits it, and only a lapsed
   * timer actually restores tmux. Restore failures here are best-effort, as
   * in releaseAll — there is no requester left to report them to.
   */
  private deferRestore(lease: ResizeLease): void {
    const ownerLeases = this.leasesByOwner.get(lease.ownerId)
    ownerLeases?.delete(lease.windowId)
    if (ownerLeases?.size === 0) this.leasesByOwner.delete(lease.ownerId)
    if (this.ownersByWindow.get(lease.windowId) === lease.ownerId) {
      this.ownersByWindow.delete(lease.windowId)
    }

    const entry: PendingRestore = { lease, cancelled: false, cancel: () => undefined }
    entry.cancel = this.schedule(() => {
      void this.enqueue(async () => {
        if (entry.cancelled) return
        this.pendingRestores.delete(lease.windowId)
        await this.finalRelease(lease).catch(() => undefined)
      })
    }, this.restoreGraceMs)
    this.pendingRestores.set(lease.windowId, entry)
  }

  /**
   * Ends a lease with no successor. The pre-commando baseline is only worth
   * restoring when a plain terminal client is attached to the session and
   * will drive sizing again; for a commando-only session, snapping back (and
   * re-enabling `window-size latest`) would reflow every pane to a size
   * nobody is looking at. There, keep the last applied geometry and only
   * clear a zoom this lease created.
   */
  private async finalRelease(lease: ResizeLease): Promise<void> {
    let hasTerminalClient = true
    try {
      const output = await this.run([
        'list-clients',
        '-t',
        lease.windowId,
        '-F',
        '#{client_control_mode}',
      ])
      hasTerminalClient = output
        .trim()
        .split(/\r?\n/)
        .some((line) => line.trim() === '0')
    } catch {
      // Unable to inspect clients: keep the conservative restore behavior.
    }
    if (hasTerminalClient) {
      await this.restore(lease)
      return
    }
    try {
      if (lease.mode.kind === 'focused') {
        const state = await this.inspectCurrentWindow(lease.windowId)
        if (state.zoomed && state.activePaneId) {
          await this.run(['resize-pane', '-Z', '-t', state.activePaneId])
        }
      }
    } finally {
      this.forgetLease(lease)
    }
  }

  private forgetLease(lease: ResizeLease): void {
    const ownerLeases = this.leasesByOwner.get(lease.ownerId)
    ownerLeases?.delete(lease.windowId)
    if (ownerLeases?.size === 0) this.leasesByOwner.delete(lease.ownerId)
    if (this.ownersByWindow.get(lease.windowId) === lease.ownerId) {
      this.ownersByWindow.delete(lease.windowId)
    }
  }

  private consumePendingRestore(windowId: string): ResizeLease | null {
    const pending = this.pendingRestores.get(windowId)
    if (!pending || pending.cancelled) return null
    pending.cancelled = true
    pending.cancel()
    this.pendingRestores.delete(windowId)
    return pending.lease
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private leaseForPane(ownerId: string, paneId: string): ResizeLease | undefined {
    return [...(this.leasesByOwner.get(ownerId)?.values() ?? [])].find((lease) =>
      lease.paneOrder.includes(paneId),
    )
  }

  private async acquire(ownerId: string, paneId: string): Promise<ResizeLease> {
    const inspected = await this.inspectBaseline(paneId)
    const currentOwner = this.ownersByWindow.get(inspected.windowId)
    if (currentOwner && currentOwner !== ownerId) throw new TmuxResizeLeaseBusyError()
    // A pending restore means the previous owner's applied layout is still on
    // the window; the live inspection reflects that layout, not the true
    // pre-commando state. Inherit the held baseline instead of re-reading it.
    const carried = this.consumePendingRestore(inspected.windowId)
    const baseline = carried
      ? {
          windowId: carried.windowId,
          width: carried.width,
          height: carried.height,
          layout: carried.layout,
          activePaneId: carried.activePaneId,
          paneOrder: carried.paneOrder,
          zoomed: carried.zoomed,
          explicitWindowSize: carried.explicitWindowSize,
        }
      : inspected
    const lease: ResizeLease = {
      ...baseline,
      ownerId,
      mode: { kind: 'focused', paneId, cols: baseline.width, rows: baseline.height },
    }
    let ownerLeases = this.leasesByOwner.get(ownerId)
    if (!ownerLeases) {
      ownerLeases = new Map()
      this.leasesByOwner.set(ownerId, ownerLeases)
    }
    ownerLeases.set(lease.windowId, lease)
    this.ownersByWindow.set(lease.windowId, ownerId)
    return lease
  }

  private async inspectBaseline(paneId: string): Promise<WindowBaseline> {
    const fields = oneLine(
      await this.run(['display-message', '-p', '-t', paneId, WINDOW_FORMAT]),
      'window',
    ).split(FIELD_SEPARATOR)
    if (fields.length !== 5 || !WINDOW_ID.test(fields[0])) {
      throw new Error('Invalid tmux window state')
    }
    const [windowId, width, height, layout, zoomed] = fields
    if (!layout || (zoomed !== '0' && zoomed !== '1')) {
      throw new Error('Invalid tmux window state')
    }

    const [paneOutput, explicitWindowSizeOutput] = await Promise.all([
      this.run(['list-panes', '-t', windowId, '-F', ACTIVE_PANE_FORMAT]),
      this.run(['show-options', '-wqv', '-t', windowId, 'window-size']),
    ])
    const paneStates = paneOutput
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(FIELD_SEPARATOR))
      .filter(([id, active]) => PANE_ID.test(id) && (active === '0' || active === '1'))
    const activePaneIds = paneStates
      .filter(([, active]) => active === '1')
      .map(([id]) => id)
    if (activePaneIds.length !== 1) throw new Error('Unable to inspect tmux active pane')

    const explicitWindowSize = explicitWindowSizeOutput.trim()
    return {
      windowId,
      width: positiveInteger(width, 'window width'),
      height: positiveInteger(height, 'window height'),
      layout,
      activePaneId: activePaneIds[0],
      paneOrder: paneStates.map(([id]) => id),
      zoomed: zoomed === '1',
      explicitWindowSize: explicitWindowSize || null,
    }
  }

  private resizeWindow(windowId: string, cols: number, rows: number): Promise<string> {
    return this.run([
      'resize-window',
      '-t',
      windowId,
      '-x',
      String(cols),
      '-y',
      String(rows),
    ])
  }

  private async inspectPaneState(windowId: string): Promise<{
    order: string[]
    activePaneId: string | null
  }> {
    const output = await this.run(['list-panes', '-t', windowId, '-F', ACTIVE_PANE_FORMAT])
    const states = output
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(FIELD_SEPARATOR))
      .filter(([id, active]) => PANE_ID.test(id) && (active === '0' || active === '1'))
    return {
      order: states.map(([id]) => id),
      activePaneId: states.find(([, active]) => active === '1')?.[0] ?? null,
    }
  }

  private async reorderPanes(
    windowId: string,
    desiredOrder: string[],
    initialOrder?: string[],
  ): Promise<void> {
    const current = initialOrder ? [...initialOrder] : (await this.inspectPaneState(windowId)).order
    if (
      current.length !== desiredOrder.length ||
      current.some((paneId) => !desiredOrder.includes(paneId))
    ) {
      throw new Error('Tmux pane set changed while applying the browser layout')
    }
    for (let index = 0; index < desiredOrder.length; index += 1) {
      if (current[index] === desiredOrder[index]) continue
      const desiredIndex = current.indexOf(desiredOrder[index], index)
      if (desiredIndex < 0) throw new Error('Tmux pane set changed while applying the browser layout')
      await this.run([
        'swap-pane',
        '-d',
        '-s',
        desiredOrder[index],
        '-t',
        current[index],
      ])
      const displacedPaneId = current[index]
      current[index] = current[desiredIndex]
      current[desiredIndex] = displacedPaneId
    }
  }

  private async restore(lease: ResizeLease): Promise<void> {
    let firstError: unknown
    const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation()
      } catch (error) {
        firstError ??= error
      }
    }
    try {
      let state: { zoomed: boolean; activePaneId: string | null } | null = null
      try {
        state = await this.inspectCurrentWindow(lease.windowId)
      } catch (error) {
        firstError ??= error
      }
      if (state?.zoomed && state.activePaneId) {
        const activePaneId = state.activePaneId
        await attempt(() => this.run(['resize-pane', '-Z', '-t', activePaneId]))
      }
      await attempt(() => this.reorderPanes(lease.windowId, lease.paneOrder))
      await attempt(() => this.resizeWindow(lease.windowId, lease.width, lease.height))
      await attempt(() => this.run(['select-layout', '-t', lease.windowId, lease.layout]))
      await attempt(() => this.run(['select-pane', '-t', lease.activePaneId]))
      if (lease.zoomed) {
        await attempt(() => this.run(['resize-pane', '-Z', '-t', lease.activePaneId]))
      }
      if (lease.explicitWindowSize) {
        const explicitWindowSize = lease.explicitWindowSize
        await attempt(() => this.run([
          'set-option',
          '-w',
          '-t',
          lease.windowId,
          'window-size',
          explicitWindowSize,
        ]))
      } else {
        await attempt(() => this.run(['set-option', '-wu', '-t', lease.windowId, 'window-size']))
      }
    } finally {
      const ownerLeases = this.leasesByOwner.get(lease.ownerId)
      ownerLeases?.delete(lease.windowId)
      if (ownerLeases?.size === 0) this.leasesByOwner.delete(lease.ownerId)
      if (this.ownersByWindow.get(lease.windowId) === lease.ownerId) {
        this.ownersByWindow.delete(lease.windowId)
      }
    }
    if (firstError) throw firstError
  }

  private async inspectCurrentWindow(windowId: string): Promise<{
    zoomed: boolean
    activePaneId: string | null
    width: number
    height: number
    layout: string
  }> {
    const fields = oneLine(
      await this.run([
        'display-message',
        '-p',
        '-t',
        windowId,
        [
          '#{window_zoomed_flag}',
          '#{pane_id}',
          '#{window_width}',
          '#{window_height}',
          '#{window_layout}',
        ].join(FIELD_SEPARATOR),
      ]),
      'window',
    ).split(FIELD_SEPARATOR)
    if (
      fields.length !== 5 ||
      (fields[0] !== '0' && fields[0] !== '1') ||
      !fields[4]
    ) {
      throw new Error('Invalid tmux window state')
    }
    return {
      zoomed: fields[0] === '1',
      activePaneId: PANE_ID.test(fields[1]) ? fields[1] : null,
      width: positiveInteger(fields[2], 'window width'),
      height: positiveInteger(fields[3], 'window height'),
      layout: fields[4],
    }
  }
}
