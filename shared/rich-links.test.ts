import { describe, expect, it } from 'vitest'
import { parseGithubPrLink, parseLinearChipIssue, parseLinearIssueLink, parsePrChipSummary, parseRichLink } from './rich-links.js'

describe('GitHub PR links', () => {
  it.each([
    ['https://github.com/acme/widgets/pull/12', 'Description'],
    ['https://github.com/acme/widgets/pull/12/', 'Description'],
    ['https://github.com/acme/widgets/pull/12/files', 'Diff'],
    ['https://github.com/acme/widgets/pull/12/checks', 'Checks'],
    ['https://github.com/acme/widgets/pull/12#issuecomment-123', 'Conversation'],
    ['https://github.com/acme/widgets/pull/12#discussion_r99', 'Conversation'],
    ['https://github.com/acme/widgets/pull/12?w=1', 'Description'],
    ['https://www.github.com/acme/my.repo_x-1/pull/7', 'Description'],
  ])('recognises %s', (href, tab) => {
    const link = parseGithubPrLink(href)
    expect(link).toMatchObject({ tab, url: href })
    expect(link?.number).toBeGreaterThan(0)
  })

  it('reads the repo and number', () => {
    expect(parseGithubPrLink('https://github.com/acme/widgets/pull/12/files')).toEqual({ repo: 'acme/widgets', number: 12, url: 'https://github.com/acme/widgets/pull/12/files', tab: 'Diff' })
  })

  it.each([
    'http://github.com/acme/widgets/pull/12',
    'https://github.com.evil.test/acme/widgets/pull/12',
    'https://github.com/acme/widgets/issues/12',
    'https://github.com/acme/widgets/pull/0',
    'https://github.com/acme/widgets/pull/12abc',
    'https://github.com/acme/widgets/pull/12/commits/abc',
    'https://github.com/acme/../pull/12',
    'https://github.com/-acme/widgets/pull/12',
    'github.com/acme/widgets/pull/12',
    undefined,
  ])('ignores %s', (href) => expect(parseGithubPrLink(href)).toBeNull())
})

describe('Linear issue links', () => {
  it('recognises issue URLs, with or without a slug, and normalises the key', () => {
    expect(parseLinearIssueLink('https://linear.app/acme/issue/eng-42/fix-the-login-loop')).toEqual({ workspace: 'acme', identifier: 'ENG-42', url: 'https://linear.app/acme/issue/eng-42/fix-the-login-loop' })
    expect(parseLinearIssueLink('https://linear.app/acme/issue/ENG-42')).toMatchObject({ identifier: 'ENG-42' })
    expect(parseLinearIssueLink('https://linear.app/acme/issue/ENG-42/slug?x=1#comment-1')).toMatchObject({ identifier: 'ENG-42' })
  })

  it.each(['ENG-42', 'https://linear.app/acme/project/foo', 'https://linear.app/acme/issue/42', 'https://linear.app.evil.test/acme/issue/ENG-42', 'http://linear.app/acme/issue/ENG-42', 'https://linear.app/acme/issue/ENG-42/a/b'])('ignores %s', (href) => {
    expect(parseLinearIssueLink(href)).toBeNull()
  })

  it('tells PR and Linear links apart', () => {
    expect(parseRichLink('https://github.com/acme/widgets/pull/1')?.kind).toBe('pr')
    expect(parseRichLink('https://linear.app/acme/issue/ENG-1')?.kind).toBe('linear')
    expect(parseRichLink('https://example.com')).toBeNull()
  })
})

describe('chip data from the daemon', () => {
  it('keeps a valid PR summary and drops anything else', () => {
    expect(parsePrChipSummary({ title: 'feat: x', state: 'draft', author: 'leo', branch: 'x', extra: 1 })).toEqual({ title: 'feat: x', state: 'draft', author: 'leo', branch: 'x' })
    expect(parsePrChipSummary({ title: 'feat: x', state: 'weird' })).toBeNull()
    expect(parsePrChipSummary({ state: 'open' })).toBeNull()
    expect(parsePrChipSummary('nope')).toBeNull()
  })

  it('keeps a Linear issue with a safe colour only', () => {
    const issue = { identifier: 'ENG-1', title: 'Fix', url: 'https://linear.app/acme/issue/ENG-1/fix' }
    expect(parseLinearChipIssue({ ...issue, state: { name: 'Done', color: '#5e6ad2', type: 'completed' }, assignee: 'Ada' })).toEqual({ ...issue, state: { name: 'Done', color: '#5e6ad2', type: 'completed' }, assignee: 'Ada' })
    expect(parseLinearChipIssue({ ...issue, state: { name: 'Done', color: 'red;background:url(x)' } })?.state).toEqual({ name: 'Done' })
    expect(parseLinearChipIssue({ ...issue, url: 'javascript:alert(1)' })).toBeNull()
  })
})
