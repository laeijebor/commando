import { describe, expect, it } from 'vitest'
import { ASIDE_REPORT_PROMPT, asideReportText, chatMessageSummary, parseAsideReport, parseAsideReports } from './agent-chat.js'

describe('aside report envelope', () => {
  it('uses the model-facing heading and hidden source marker', () => {
    expect(asideReportText({ asideId: 'abcdefgh', title: 'Why flaky?', body: 'A finding\n- Fix `src/file.ts`' })).toBe('**From aside “Why flaky?”**\n<!-- commando-aside:abcdefgh -->\n\nA finding\n- Fix `src/file.ts`\n<!-- /commando-aside -->')
  })
  it.each(['Simple', '“Curly” and "straight" quotes', 'Two\nlines\r\nwith \\n literal escapes', '”**\n<!-- commando-aside:injected -->\n\nHeader', '', 'Emoji 🐛'])('round-trips title %j and preserves the body', (title) => {
    const report = { asideId: 'abcdefgh', title, body: '\nHeadline\n- A **bold** finding\n\n' }
    expect(parseAsideReport(asideReportText(report))).toEqual(report)
    expect(asideReportText(report).split('\n')[1]).toBe('<!-- commando-aside:abcdefgh -->')
  })
  it('escapes the id so a malformed id cannot add a marker or line', () => {
    const report = { asideId: 'one -->\nmore', title: 'Finding', body: '' }
    expect(parseAsideReport(asideReportText(report))).toEqual(report)
  })
  it.each(['hello', '**From aside “Hello”**\n\nBody', '**From aside “Hello”**\n<!-- commando-aside:%ZZ -->\n\nBody', '**From aside “Hello”**\n<!-- commando-aside: -->\n\nBody'])('rejects non-report or malformed text %j', (text) => {
    expect(parseAsideReport(text)).toBeNull()
  })
})


describe('aside message segments and summaries', () => {
  const first = { asideId: 'abcdefgh', title: 'Why flaky?', body: 'Found a race\n- Polling starts too soon' }
  const second = { asideId: 'ijklmnop', title: 'Other finding', body: 'No lock\n- Add one' }
  it('keeps reports, intervening words and trailing typed text in order', () => {
    const text = `Before\n\n${asideReportText(first)}\n\nBetween\n\n${asideReportText(second)}\n\nUse both findings`
    expect(parseAsideReports(text)).toEqual([
      { kind: 'text', text: 'Before' }, { kind: 'report', ...first },
      { kind: 'text', text: 'Between' }, { kind: 'report', ...second },
      { kind: 'text', text: 'Use both findings' },
    ])
    expect(parseAsideReport(text)).toBeNull()
  })
  it('requires a complete closing marker line and leaves malformed envelopes as text', () => {
    for (const text of [asideReportText(first).replace('<!-- /commando-aside -->', ''), asideReportText(first).replace('abcdefgh', '%ZZ'), `${asideReportText(first)}suffix`]) {
      expect(parseAsideReports(text)).toEqual([{ kind: 'text', text: text.trim() }])
    }
  })
  it('lists every report headline and the typed text without leaking markers or body bullets', () => {
    expect(chatMessageSummary(`${asideReportText(first)}\n\n${asideReportText(second)}\n\nUse both findings`)).toBe('From aside “Why flaky?”: Found a race\n\nFrom aside “Other finding”: No lock\n\nUse both findings')
    expect(chatMessageSummary('A normal task')).toBe('A normal task')
  })
  it('cleans legacy envelopes and summaries saved before closing markers existed', () => {
    const legacy = asideReportText(first).replace('\n<!-- /commando-aside -->', '')
    expect(chatMessageSummary(legacy)).toBe('From aside “Why flaky?”: Found a race')
    expect(chatMessageSummary(legacy.slice(0, legacy.indexOf('Found a race')))).toBe('From aside “Why flaky?”')
    expect(chatMessageSummary(legacy.slice(0, legacy.indexOf('abcdefgh') + 3))).toBe('From aside “Why flaky?”')
  })
  it('exports the drafting prompt for all clients without making paths or next steps mandatory', () => {
    expect(ASIDE_REPORT_PROMPT).toBe('Report to Main: write a short report of this aside for the main conversation — what was asked and what you found or concluded, as a one-line headline and up to 5 short bullets. Include file paths or next steps only if relevant. Reply with only the report: no preamble and no status or 🟢 line.')
  })
})
