import type { PaneTerminalState } from '../shared/protocol.js'

const ESC = '\u001b'
const CSI = `${ESC}[`

function mode(enabled: boolean, code: string): string {
  return `${CSI}?${code}${enabled ? 'h' : 'l'}`
}

function cursorStyle(state: PaneTerminalState): string {
  if (state.cursorShape === 'underline') return `${CSI}${state.cursorBlinking ? 3 : 4} q`
  if (state.cursorShape === 'bar') return `${CSI}${state.cursorBlinking ? 5 : 6} q`
  if (state.cursorShape === 'block') return `${CSI}${state.cursorBlinking ? 1 : 2} q`
  return `${CSI}0 q`
}

function tabStops(state: PaneTerminalState): string {
  return `${CSI}3g${state.paneTabs
    .map((column) => `${CSI}${column + 1}G${ESC}H`)
    .join('')}${CSI}H`
}

export function buildPaneSeed(
  capture: Buffer,
  state: PaneTerminalState,
  normalCapture?: Buffer,
): Buffer {
  const cursorRow = state.originFlag
    ? Math.max(1, state.cursorY - state.scrollRegionUpper + 1)
    : state.cursorY + 1
  const cursorColumn = state.cursorX + 1
  const normalBootstrap = [
    mode(true, '2026'),
    mode(false, '25'),
    `${CSI}0m`,
    mode(false, '6'),
    `${CSI}4l`,
    mode(false, '1'),
    `${ESC}>`,
    mode(false, '1000'),
    mode(false, '1002'),
    mode(false, '1003'),
    mode(false, '1006'),
    `${CSI}r${CSI}H${CSI}2J`,
    tabStops(state),
  ].join('')
  const alternateBootstrap = state.alternateOn
    ? [
        normalCapture ?? Buffer.alloc(0),
        Buffer.from(
          `${CSI}0m${CSI}${state.alternateSavedY + 1};${state.alternateSavedX + 1}H${mode(true, '1049')}${CSI}r${CSI}H${CSI}2J`,
        ),
      ]
    : []
  const restore = [
    `${CSI}0m`,
    `${CSI}${state.scrollRegionUpper + 1};${state.scrollRegionLower + 1}r`,
    mode(state.wrapFlag, '7'),
    `${CSI}4${state.insertFlag ? 'h' : 'l'}`,
    mode(state.keypadCursorFlag, '1'),
    state.keypadFlag ? `${ESC}=` : `${ESC}>`,
    state.mouseAnyFlag ? mode(true, '1003') : '',
    state.mouseSgrFlag ? mode(true, '1006') : '',
    cursorStyle(state),
    mode(state.originFlag, '6'),
    `${CSI}${cursorRow};${cursorColumn}H`,
    mode(state.cursorVisible, '25'),
    mode(false, '2026'),
  ].join('')

  return Buffer.concat([
    Buffer.from(normalBootstrap),
    ...alternateBootstrap,
    capture,
    Buffer.from(restore),
  ])
}
