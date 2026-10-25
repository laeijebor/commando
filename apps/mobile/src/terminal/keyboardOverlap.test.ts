import { keyboardOverlap, MIN_CHAT_BODY, nextKeyboardFrame, type BodyFrame, type KeyboardFrame, type KeyboardFrameEvent } from './keyboardOverlap'

// An iPhone 15 Pro: an 852pt window, with the chat body between the pane tabs and the bottom edge.
const WINDOW = 852
const BODY: BodyFrame = { top: 150, bottom: 852 }
// The body above the iPad cockpit's tab bar: 40pt short of the bottom edge.
const BODY_ABOVE_TAB_BAR: BodyFrame = { top: 150, bottom: 812 }

const SYSTEM: KeyboardFrame = { screenY: 516, height: 336 }
const EMOJI: KeyboardFrame = { screenY: 476, height: 376 }
// SwiftKey with its toolbar and the globe/mic row, as on screen.
const SWIFTKEY: KeyboardFrame = { screenY: 447, height: 405 }
// Its provisional frame: some 225pt taller than the keyboard that appears.
const SWIFTKEY_PROVISIONAL: KeyboardFrame = { screenY: 222, height: 630 }
const OFF_SCREEN: KeyboardFrame = { screenY: 852, height: 336 }

type Step = [KeyboardFrameEvent, KeyboardFrame?]

/** The overlap after each event. */
function run(steps: Step[], body: BodyFrame = BODY): number[] {
  return steps.map(([event, end]) => keyboardOverlap(nextKeyboardFrame(event, end), body, WINDOW))
}

describe('the keyboard overlap', () => {
  it('covers the body from the keyboard top while the system keyboard is up, and nothing once it hides', () => {
    expect(run([
      ['keyboardWillChangeFrame', SYSTEM],
      ['keyboardWillShow', SYSTEM],
      ['keyboardDidChangeFrame', SYSTEM],
      ['keyboardDidShow', SYSTEM],
      ['keyboardWillChangeFrame', OFF_SCREEN],
      ['keyboardWillHide', OFF_SCREEN],
      ['keyboardDidHide', OFF_SCREEN],
    ])).toEqual([336, 336, 336, 336, 0, 0, 0])
  })

  it('takes away the gap between the body and the bottom edge', () => {
    expect(run([['keyboardWillShow', SYSTEM]], BODY_ABOVE_TAB_BAR)).toEqual([296])
  })

  it('settles on the real frame when a third-party keyboard corrects a too-tall provisional one', () => {
    const overlaps = run([
      ['keyboardWillShow', SWIFTKEY_PROVISIONAL],
      ['keyboardWillChangeFrame', SWIFTKEY],
      ['keyboardDidChangeFrame', SWIFTKEY],
      ['keyboardDidShow', SWIFTKEY],
    ])
    expect(overlaps.at(-1)).toBe(405)
  })

  it('settles on a correction that arrives only as a did-change', () => {
    const overlaps = run([
      ['keyboardWillShow', SWIFTKEY_PROVISIONAL],
      ['keyboardDidChangeFrame', SWIFTKEY],
    ])
    expect(overlaps).toEqual([BODY.bottom - BODY.top - MIN_CHAT_BODY, 405])
  })

  it('never leaves the body shorter than the composer, even on a bad frame', () => {
    expect(keyboardOverlap(SWIFTKEY_PROVISIONAL, BODY, WINDOW)).toBe(BODY.bottom - BODY.top - MIN_CHAT_BODY)
    expect(keyboardOverlap({ screenY: 0, height: WINDOW }, BODY, WINDOW)).toBe(BODY.bottom - BODY.top - MIN_CHAT_BODY)
  })

  it('never pads more than the keyboard covers of the body, whatever its height says', () => {
    // A frame whose height runs past the bottom edge still covers only what lies below its top.
    expect(keyboardOverlap({ screenY: 516, height: 600 }, BODY, WINDOW)).toBe(336)
  })

  it('pads at once when the pane opens with the keyboard already up', () => {
    // No will-show arrives: the pane starts from the latest frame of the events before it opened.
    const before: Step[] = [['keyboardWillShow', SWIFTKEY_PROVISIONAL], ['keyboardDidShow', SWIFTKEY_PROVISIONAL], ['keyboardDidChangeFrame', SWIFTKEY]]
    const latest = before.reduce<KeyboardFrame | null>((_frame, [event, end]) => nextKeyboardFrame(event, end), null)
    expect(keyboardOverlap(latest, BODY, WINDOW)).toBe(405)
  })

  it('waits for the body to be measured', () => {
    expect(keyboardOverlap(SYSTEM, null, WINDOW)).toBe(0)
  })

  it('ignores a floating or undocked iPad keyboard, which covers nothing below it', () => {
    const IPAD = 1194
    const body: BodyFrame = { top: 120, bottom: 1194 }
    expect(keyboardOverlap({ screenY: 700, height: 260 }, body, IPAD)).toBe(0)
    expect(keyboardOverlap({ screenY: 800, height: 394 }, body, IPAD)).toBe(394)
  })

  it('follows a height change while shown, such as switching to the emoji keyboard and back', () => {
    expect(run([
      ['keyboardWillShow', SYSTEM],
      ['keyboardWillChangeFrame', EMOJI],
      ['keyboardWillShow', EMOJI],
      ['keyboardDidChangeFrame', EMOJI],
      ['keyboardWillChangeFrame', SYSTEM],
      ['keyboardWillShow', SYSTEM],
    ])).toEqual([336, 376, 376, 376, 336, 336])
  })

  it('treats a missing or empty frame as no keyboard', () => {
    expect(nextKeyboardFrame('keyboardWillShow', undefined)).toBeNull()
    expect(keyboardOverlap({ screenY: 852, height: 0 }, BODY, WINDOW)).toBe(0)
  })
})
