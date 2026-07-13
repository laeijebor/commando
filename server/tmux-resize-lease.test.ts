import { describe, expect, it } from 'vitest'
import {
  TmuxResizeLeaseBusyError,
  TmuxResizeLeaseManager,
  type TmuxResizeCommandRunner,
} from './tmux-resize-lease.js'

const separator = '\u001f'

function fakeRunner(options?: {
  windowId?: string
  activePaneId?: string
  zoomed?: boolean
  explicitWindowSize?: string
}) {
  const commands: string[][] = []
  let currentActivePaneId = options?.activePaneId ?? '%1'
  let currentZoomed = options?.zoomed ?? false
  let currentWidth = 80
  let currentHeight = 24
  let currentLayout = 'layout-before'
  const currentOrder = ['%1', '%2']
  const windowId = options?.windowId ?? '@1'
  const run: TmuxResizeCommandRunner = async (args) => {
    const command = [...args]
    commands.push(command)
    if (command[0] === 'display-message' && command.at(-1)?.includes('#{window_id}')) {
      return [windowId, '80', '24', 'layout-before', options?.zoomed ? '1' : '0'].join(separator)
    }
    if (command[0] === 'display-message') {
      return [
        currentZoomed ? '1' : '0',
        currentActivePaneId,
        String(currentWidth),
        String(currentHeight),
        currentLayout,
      ].join(separator)
    }
    if (command[0] === 'list-panes') {
      return currentOrder.map((paneId) => [
        paneId,
        currentActivePaneId === paneId ? '1' : '0',
      ].join(separator)).join('\n')
    }
    if (command[0] === 'show-options') return options?.explicitWindowSize ?? ''
    if (command[0] === 'select-pane') currentActivePaneId = command[2]
    if (command[0] === 'resize-pane' && command[1] === '-Z') currentZoomed = !currentZoomed
    if (command[0] === 'resize-window') {
      currentWidth = Number(command[4])
      currentHeight = Number(command[6])
    }
    if (command[0] === 'select-layout') currentLayout = command[3]
    if (command[0] === 'swap-pane') {
      const sourceIndex = currentOrder.indexOf(command[3])
      const targetIndex = currentOrder.indexOf(command[5])
      const displacedPaneId = currentOrder[sourceIndex]
      currentOrder[sourceIndex] = currentOrder[targetIndex]
      currentOrder[targetIndex] = displacedPaneId
    }
    return ''
  }
  return {
    commands,
    run,
    setWindowState: (state: { width?: number; height?: number; layout?: string }) => {
      currentWidth = state.width ?? currentWidth
      currentHeight = state.height ?? currentHeight
      currentLayout = state.layout ?? currentLayout
    },
  }
}

describe('tmux focused-pane resize leases', () => {
  it('zooms a focused pane, updates it without replacing the baseline, and restores tmux', async () => {
    const fake = fakeRunner()
    const manager = new TmuxResizeLeaseManager(fake.run)

    await expect(manager.resize('client-1', '%2', 120, 40)).resolves.toBe(true)
    await expect(manager.resize('client-1', '%2', 140, 50)).resolves.toBe(true)
    await expect(manager.resize('client-1', '%2', 140, 50)).resolves.toBe(false)
    await expect(manager.release('client-1', '%2')).resolves.toBe(true)

    expect(fake.commands.filter((command) => command[0] === 'show-options')).toHaveLength(1)
    expect(fake.commands).toContainEqual(['resize-window', '-t', '@1', '-x', '120', '-y', '40'])
    expect(fake.commands).toContainEqual(['resize-window', '-t', '@1', '-x', '140', '-y', '50'])
    expect(fake.commands).toContainEqual(['resize-window', '-t', '@1', '-x', '80', '-y', '24'])
    expect(fake.commands).toContainEqual(['select-layout', '-t', '@1', 'layout-before'])
    expect(fake.commands).toContainEqual(['set-option', '-wu', '-t', '@1', 'window-size'])
  })

  it('restores a previously zoomed pane and explicit window size policy', async () => {
    const fake = fakeRunner({ activePaneId: '%1', zoomed: true, explicitWindowSize: 'largest' })
    const manager = new TmuxResizeLeaseManager(fake.run)

    await manager.resize('client-1', '%2', 100, 30)
    await manager.release('client-1')

    expect(fake.commands).toContainEqual(['resize-pane', '-Z', '-t', '%1'])
    expect(fake.commands.slice(-3)).toEqual([
      ['select-pane', '-t', '%1'],
      ['resize-pane', '-Z', '-t', '%1'],
      ['set-option', '-w', '-t', '@1', 'window-size', 'largest'],
    ])
  })

  it('rejects a second browser lease for the same tmux window', async () => {
    const fake = fakeRunner()
    const manager = new TmuxResizeLeaseManager(fake.run)
    await manager.resize('client-1', '%1', 100, 30)

    await expect(manager.resize('client-2', '%2', 120, 40)).rejects.toBeInstanceOf(
      TmuxResizeLeaseBusyError,
    )
    await expect(manager.release('client-1')).resolves.toBe(true)
  })

  it('ignores a stale release for the previous focused pane', async () => {
    const firstWindow = fakeRunner({ windowId: '@1', activePaneId: '%1' })
    const manager = new TmuxResizeLeaseManager(firstWindow.run)
    await manager.resize('client-1', '%1', 100, 30)

    await expect(manager.release('client-1', '%2')).resolves.toBe(false)
    await expect(manager.release('client-1', '%1')).resolves.toBe(true)
  })

  it('releases the affected window regardless of which browser owns it', async () => {
    const fake = fakeRunner()
    const manager = new TmuxResizeLeaseManager(fake.run)
    await manager.resize('client-1', '%2', 120, 40)

    await expect(manager.releaseWindowForAll('@1')).resolves.toBe(true)
    await expect(manager.release('client-1')).resolves.toBe(false)
    expect(fake.commands).toContainEqual(['resize-window', '-t', '@1', '-x', '80', '-y', '24'])
  })

  it('continues restoring later window state after one tmux command fails', async () => {
    const fake = fakeRunner()
    const manager = new TmuxResizeLeaseManager(async (args) => {
      const output = await fake.run(args)
      if (args[0] === 'select-layout') throw new Error('layout changed externally')
      return output
    })
    await manager.resize('client-1', '%2', 100, 30)

    await expect(manager.release('client-1')).rejects.toThrow('layout changed externally')
    expect(fake.commands.slice(-2)).toEqual([
      ['select-pane', '-t', '%1'],
      ['set-option', '-wu', '-t', '@1', 'window-size'],
    ])
  })

  it('applies browser pane order and restores the baseline order on release', async () => {
    const fake = fakeRunner()
    const manager = new TmuxResizeLeaseManager(fake.run)

    await manager.applyLayout('client-1', '@1', {
      kind: 'split',
      direction: 'row',
      children: [
        { kind: 'pane', paneId: '%2', cols: 40, rows: 20 },
        { kind: 'pane', paneId: '%1', cols: 40, rows: 20 },
      ],
    })
    await manager.release('client-1')

    expect(fake.commands).toContainEqual(['swap-pane', '-d', '-s', '%2', '-t', '%1'])
    expect(fake.commands).toContainEqual(['resize-window', '-t', '@1', '-x', '81', '-y', '20'])
    expect(fake.commands.some(
      (command) => command[0] === 'select-layout' && command[3].includes('81x20'),
    )).toBe(true)
    expect(fake.commands.filter((command) => command[0] === 'swap-pane')).toHaveLength(2)
  })

  it('applies a one-shot layout at the current window size without leasing', async () => {
    const fake = fakeRunner()
    const manager = new TmuxResizeLeaseManager(fake.run)

    await expect(manager.setLayout('@1', {
      kind: 'split',
      direction: 'column',
      children: [
        { kind: 'pane', paneId: '%1', cols: 1, rows: 3 },
        { kind: 'pane', paneId: '%2', cols: 1, rows: 1 },
      ],
    })).resolves.toBe(true)

    expect(fake.commands.some((command) => command[0] === 'resize-window')).toBe(false)
    const layouts = fake.commands.filter((command) => command[0] === 'select-layout')
    expect(layouts).toHaveLength(1)
    expect(layouts[0][3]).toContain('80x18,0,0,1')
    expect(layouts[0][3]).toContain('80x5,0,19,2')
    await expect(manager.release('client-1')).resolves.toBe(false)
  })

  it('folds one-shot layouts into a held lease baseline', async () => {
    const fake = fakeRunner()
    const manager = new TmuxResizeLeaseManager(fake.run)
    await manager.resize('client-1', '%2', 120, 40)

    await manager.setLayout('@1', {
      kind: 'split',
      direction: 'column',
      children: [
        { kind: 'pane', paneId: '%1', cols: 1, rows: 3 },
        { kind: 'pane', paneId: '%2', cols: 1, rows: 1 },
      ],
    })
    await manager.release('client-1')

    const layouts = fake.commands.filter((command) => command[0] === 'select-layout')
    const restored = layouts.at(-1)?.[3] ?? ''
    expect(restored).not.toBe('layout-before')
    expect(restored).toContain('80x18,0,0,1')
    expect(restored).toContain('80x5,0,19,2')
  })

  it('rejects one-shot layouts missing window panes', async () => {
    const fake = fakeRunner()
    const manager = new TmuxResizeLeaseManager(fake.run)
    await expect(manager.setLayout('@1', {
      kind: 'pane',
      paneId: '%1',
      cols: 1,
      rows: 1,
    })).rejects.toThrow(/every pane/)
  })

  it('reasserts an unchanged browser layout after an external tmux change', async () => {
    const fake = fakeRunner()
    const manager = new TmuxResizeLeaseManager(fake.run)
    const apply = () => manager.applyLayout('client-1', '@1', {
      kind: 'split',
      direction: 'row',
      children: [
        { kind: 'pane', paneId: '%1', cols: 40, rows: 20 },
        { kind: 'pane', paneId: '%2', cols: 40, rows: 20 },
      ],
    })

    await apply()
    const firstApplyCount = fake.commands.filter((command) => command[0] === 'select-layout').length
    fake.setWindowState({ width: 90, layout: 'external-layout' })
    await expect(apply()).resolves.toBe(true)
    expect(fake.commands.filter((command) => command[0] === 'select-layout')).toHaveLength(
      firstApplyCount + 1,
    )
    await manager.release('client-1')
  })
})
