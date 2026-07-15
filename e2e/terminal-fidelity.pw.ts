import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'

const baseUrl = process.env.COMMANDO_E2E_URL ?? 'http://127.0.0.1:4311'
const token = process.env.COMMANDO_E2E_TOKEN ?? 'fidelity-token'
const paneId = process.env.COMMANDO_E2E_PANE ?? '%0'
const socketName = process.env.COMMANDO_E2E_TMUX_SOCKET ?? 'commando-fidelity'

function tmuxPaneSize(): string {
  return execFileSync('tmux', [
    '-L',
    socketName,
    'display-message',
    '-p',
    '-t',
    paneId,
    '#{pane_width}x#{pane_height}',
  ], { encoding: 'utf8' }).trim()
}

test('renders an attributed alternate-screen table at exact source geometry', async ({
  context,
  page,
}) => {
  const browserErrors: string[] = []
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(baseUrl).origin,
  })
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.goto(`${baseUrl}/?qa=1#token=${encodeURIComponent(token)}`)
  const pane = page.locator(`[data-pane-id="${paneId}"]`)
  const sourceGrid = pane.locator('.terminal-source-grid')
  await expect(sourceGrid).toHaveAttribute('data-terminal-seeded', /\d+/, {
    timeout: 10_000,
  })

  const snapshot = await page.evaluate((id) => {
    const terminal = window.__commandoQaTerminals?.get(id)
    if (!terminal) throw new Error(`Missing QA terminal for ${id}`)
    const buffer = terminal.buffer.active
    return {
      cols: terminal.cols,
      rows: terminal.rows,
      type: buffer.type,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      macOptionClickForcesSelection: terminal.options.macOptionClickForcesSelection,
      altClickMovesCursor: terminal.options.altClickMovesCursor,
      lines: Array.from({ length: terminal.rows }, (_, row) =>
        buffer.getLine(row)?.translateToString(true) ?? '',
      ),
      thought: (() => {
        const cell = buffer.getLine(13)?.getCell(1)
        return cell
          ? {
              chars: cell.getChars(),
              foreground: cell.getFgColor(),
              background: cell.getBgColor(),
              foregroundRgb: cell.isFgRGB(),
              backgroundRgb: cell.isBgRGB(),
            }
          : null
      })(),
      wide: (() => {
        const line = buffer.getLine(15)
        for (let column = 0; column < terminal.cols; column += 1) {
          const cell = line?.getCell(column)
          if (cell?.getChars() === '界') return { column, width: cell.getWidth() }
        }
        return null
      })(),
    }
  }, paneId)

  expect(snapshot).toMatchObject({
    cols: 80,
    rows: 24,
    type: 'alternate',
    cursorX: 9,
    cursorY: 21,
    macOptionClickForcesSelection: true,
    altClickMovesCursor: false,
  })
  expect(snapshot.lines[4]).toBe(
    '+----------------------------------------------+-------------------------------+',
  )
  expect(snapshot.lines[5]).toBe(
    '| Lever                                        | Expected impact               |',
  )
  expect(snapshot.lines[7]).toBe(
    '| Match WezTerm font and Rose Pine Moon        | Accurate terminal profile     |',
  )
  expect(snapshot.thought).toEqual({
    chars: 'T',
    foreground: 0x97682c,
    background: 0x0a0a0a,
    foregroundRgb: true,
    backgroundRgb: true,
  })
  expect(snapshot.wide).toMatchObject({ width: 2 })

  await expect(pane.locator('.xterm-screen')).toHaveScreenshot('ansi-table-80x24.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await page.evaluate((id) => {
    const terminal = window.__commandoQaTerminals?.get(id)
    if (!terminal) throw new Error(`Missing QA terminal for ${id}`)
    terminal.select(1, 1, 26)
  }, paneId)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    'COMMANDO TERMINAL FIDELITY',
  )

  await sourceGrid.focus()
  await expect.poll(tmuxPaneSize).not.toBe('80x24')
  const focusedSize = tmuxPaneSize()
  await expect.poll(() =>
    page.evaluate((id) => {
      const terminal = window.__commandoQaTerminals?.get(id)
      return terminal ? `${terminal.cols}x${terminal.rows}` : ''
    }, paneId),
  ).toBe(focusedSize)

  try {
    execFileSync('tmux', [
      '-L',
      socketName,
      'resize-window',
      '-t',
      'fidelity:0',
      '-x',
      '90',
      '-y',
      '30',
    ])
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const terminal = window.__commandoQaTerminals?.get(id)
          return terminal ? `${terminal.cols}x${terminal.rows}` : ''
        }, paneId),
      )
      .toBe('90x30')
  } finally {
    execFileSync('tmux', [
      '-L',
      socketName,
      'resize-window',
      '-t',
      'fidelity:0',
      '-x',
      '80',
      '-y',
      '24',
    ])
  }
  expect(browserErrors).toEqual([])

  await page.setViewportSize({ width: 1200, height: 800 })
  await expect.poll(tmuxPaneSize).not.toBe('80x24')
  await page.close()
  await expect.poll(tmuxPaneSize).toBe('80x24')
})
