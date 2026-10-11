// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ChatCommand } from '../../shared/agent-chat'
import { detectTrigger, filterCommands, filterPullRequests, mentionText, moveCommandToStart, pullRequestText, replaceRange, useTriggerState } from './composerTriggers'

describe('detectTrigger', () => {
  it('opens / at the start and mid-message after any whitespace', () => {
    expect(detectTrigger('/re', 3)).toEqual({ kind: 'slash', query: 're', rangeStart: 0, rangeEnd: 3, atStart: true })
    expect(detectTrigger('  /', 3)).toMatchObject({ kind: 'slash', query: '', atStart: true })
    expect(detectTrigger('please ask for /re', 18)).toEqual({ kind: 'slash', query: 're', rangeStart: 15, rangeEnd: 18, atStart: false })
    expect(detectTrigger('line one\n/comp', 14)).toMatchObject({ kind: 'slash', query: 'comp', atStart: false })
    expect(detectTrigger('/codex:rev', 10)).toMatchObject({ query: 'codex:rev' })
  })

  it('ignores slashes inside words and paths', () => {
    expect(detectTrigger('and/or', 6)).toBeNull()
    expect(detectTrigger('see /usr/bin', 12)).toBeNull()
    expect(detectTrigger('/re now', 7)).toBeNull()
  })

  it('reads the token up to the caret, not the end of the text', () => {
    expect(detectTrigger('/compact later', 4)).toMatchObject({ kind: 'slash', query: 'com', rangeEnd: 4 })
  })

  it('opens @ mentions and # pull requests anywhere', () => {
    expect(detectTrigger('look at @server/agent-host/ses', 30)).toEqual({ kind: 'mention', query: 'server/agent-host/ses', rangeStart: 8, rangeEnd: 30, atStart: false })
    expect(detectTrigger('@', 1)).toMatchObject({ kind: 'mention', query: '' })
    expect(detectTrigger('@"my notes', 10)).toBeNull()
    expect(detectTrigger('see #12', 7)).toMatchObject({ kind: 'pr', query: '12' })
    expect(detectTrigger('#', 1)).toMatchObject({ kind: 'pr', query: '' })
    expect(detectTrigger('# heading', 9)).toBeNull()
    expect(detectTrigger('a#b', 3)).toBeNull()
  })
})

describe('replacing and moving tokens', () => {
  it('swallows a following space the replacement already ends with', () => {
    expect(replaceRange('ask /re now', 4, 7, '/recap ')).toEqual({ text: 'ask /recap now', cursor: 11 })
    expect(replaceRange('/re', 0, 3, '/recap ')).toEqual({ text: '/recap ', cursor: 7 })
  })

  it('moves a start-only command to the front with the rest as its arguments', () => {
    const text = 'keep the API notes /comp'
    const trigger = detectTrigger(text, text.length)!
    expect(moveCommandToStart(text, trigger, 'compact')).toEqual({ text: '/compact keep the API notes', cursor: 27 })
  })

  it('keeps the message’s lines and spacing when it moves a command', () => {
    const move = (text: string, cursor: number) => moveCommandToStart(text, detectTrigger(text, cursor)!, 'compact').text
    const list = 'Keep:\n\n- the API notes\n  - and   their  examples /comp'
    expect(move(list, list.length)).toBe('/compact Keep:\n\n- the API notes\n  - and   their  examples')
    const middle = 'Keep:\n/comp\n\n```ts\nconst a  = 1\n```'
    expect(move(middle, 'Keep:\n/comp'.length)).toBe('/compact Keep:\n\n```ts\nconst a  = 1\n```')
    const inline = 'keep /comp  the notes\nand more'
    expect(move(inline, 'keep /comp'.length)).toBe('/compact keep the notes\nand more')
  })

  it('quotes mentions with spaces and links pull requests', () => {
    expect(mentionText({ path: 'src/chat/', kind: 'directory' })).toBe('@src/chat/ ')
    expect(mentionText({ path: 'my notes.txt', kind: 'file' })).toBe('@"my notes.txt" ')
    expect(pullRequestText({ number: 32, title: 'feat: chat [1b·1]\ncontrols', url: 'https://github.com/o/r/pull/32' }))
      .toBe('[#32 feat: chat 1b·1 controls](https://github.com/o/r/pull/32) ')
  })
})

describe('filtering', () => {
  const commands: ChatCommand[] = [
    { name: 'review', description: 'Review a PR', kind: 'command' },
    { name: 'recap', description: 'One-line recap', kind: 'command' },
    { name: 'rename', description: 'Rename the conversation', kind: 'command' },
    { name: 'codex:review', description: 'Codex review', kind: 'skill' },
    { name: 'code-review', description: 'Review the diff', aliases: ['cr'], kind: 'skill' },
    { name: 'compact', description: 'Summarise to free context', kind: 'command' },
  ]

  it('ranks name prefixes, plugin names, aliases, then descriptions', () => {
    expect(filterCommands(commands, 're').map((command) => command.name)).toEqual(['recap', 'rename', 'review', 'codex:review'])
    expect(filterCommands(commands, 'cr').map((command) => command.name)).toEqual(['code-review'])
    expect(filterCommands(commands, 'context').map((command) => command.name)).toEqual(['compact'])
    expect(filterCommands(commands, 'view').map((command) => command.name)).toEqual(['review', 'code-review', 'codex:review'])
    expect(filterCommands(commands, '')).toHaveLength(6)
  })

  it('matches pull requests by number or title', () => {
    const prs = [{ number: 31, title: 'Start and survive', url: 'u31' }, { number: 32, title: 'Composer controls', url: 'u32' }, { number: 3, title: 'Old', url: 'u3' }]
    expect(filterPullRequests(prs, '3').map((pr) => pr.number)).toEqual([32, 31, 3])
    expect(filterPullRequests(prs, 'comp').map((pr) => pr.number)).toEqual([32])
  })
})

describe('useTriggerState', () => {
  it('keeps a dismissed trigger closed until the caret leaves its token', () => {
    const { result } = renderHook(() => useTriggerState())
    const first = detectTrigger('ask /re', 7)
    act(() => result.current.update(first))
    expect(result.current.trigger).toEqual(first)
    act(() => result.current.dismiss(first))
    expect(result.current.trigger).toBeNull()
    // Typing more in the same token keeps it closed.
    act(() => result.current.update(detectTrigger('ask /rec', 8)))
    expect(result.current.trigger).toBeNull()
    // Leaving the token re-arms it, and a new token opens.
    act(() => result.current.update(detectTrigger('ask /rec ', 9)))
    act(() => result.current.update(detectTrigger('ask /rec /', 10)))
    expect(result.current.trigger).toMatchObject({ kind: 'slash', rangeStart: 9 })
  })
})
