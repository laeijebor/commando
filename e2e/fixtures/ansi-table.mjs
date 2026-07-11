const ESC = '\u001b'
const CSI = `${ESC}[`

const move = (row, column) => `${CSI}${row};${column}H`
const paint = (foreground, background, text) =>
  `${CSI}38;2;${foreground.join(';')}m${CSI}48;2;${background.join(';')}m${text}${CSI}0m`

const width = 80
const leftWidth = 46
const rightWidth = width - leftWidth - 3
const border = `+${'-'.repeat(leftWidth)}+${'-'.repeat(rightWidth)}+`
const row = (left, right) =>
  `|${left.padEnd(leftWidth)}|${right.padEnd(rightWidth)}|`
const rows = [
  border,
  row(' Lever', ' Expected impact'),
  border,
  row(' Match WezTerm font and Rose Pine Moon', ' Accurate terminal profile'),
  row(' Restore alternate screen and margins', ' Stable TUI geometry'),
  row(' Compare the authoritative tmux grid', ' Repairs emulator drift'),
  border,
]

process.stdout.write(
  [
    `${CSI}?1049h${CSI}?25l${CSI}?7h${CSI}2J${CSI}H`,
    move(2, 2),
    paint([224, 222, 244], [35, 33, 54], 'COMMANDO TERMINAL FIDELITY'),
    ...rows.map((line, index) =>
      `${move(index + 5, 1)}${paint(
        index === 1 ? [196, 167, 231] : [224, 222, 244],
        index >= 3 && index <= 5 ? [30, 30, 30] : [10, 10, 10],
        line,
      )}`,
    ),
    move(14, 2),
    paint([151, 104, 44], [10, 10, 10], 'Thought: table columns remain aligned'),
    move(16, 2),
    paint([127, 216, 143], [10, 10, 10], 'Truecolor OK'),
    '  ',
    paint([128, 128, 128], [20, 20, 20], 'muted gray'),
    '  Wide: 界  Combining: e\u0301',
    move(20, 2),
    'FIXTURE_READY',
    move(22, 10),
    `${CSI}?25h`,
  ].join(''),
)

const keepAlive = setInterval(() => undefined, 60_000)
const shutdown = () => {
  clearInterval(keepAlive)
  process.stdout.write(`${CSI}?25h${CSI}?1049l`)
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
process.stdin.resume()
