import { SNAPSHOT } from '../testing/fixtures'
import {
  agentRunCommand,
  baseLabel,
  buildSessionRequest,
  effectiveBranch,
  flattenPrompt,
  previewWorktreePath,
  repoOptions,
  shellQuote,
} from './model'

const REPO = {
  isRepo: true,
  mainRoot: '/Users/leo/code/commando',
  root: '/Users/leo/code/commando',
  name: 'commando',
  branch: 'main',
  defaultBranch: 'main',
  remote: 'origin',
}

const FORM = {
  name: 'Companion App',
  directory: '/Users/leo/code/commando',
  worktreeEnabled: true,
  branch: 'companion-app',
  worktreePath: '/Users/leo/code/commando-worktrees/companion-app',
  prepareCommand: 'npm install',
  prepareEnabled: true,
}

describe('the create form model', () => {
  it('sanitises the session name into a branch until the branch is edited', () => {
    expect(effectiveBranch('Companion App / v2', null)).toBe('companion-app-v2')
    expect(effectiveBranch('Companion App', 'feat/companion')).toBe('feat/companion')
  })

  it('computes the worktree path beside the main checkout', () => {
    expect(previewWorktreePath(REPO, 'companion-app'))
      .toBe('/Users/leo/code/commando-worktrees/companion-app')
    expect(previewWorktreePath(REPO, '')).toBe('/Users/leo/code/commando-worktrees/<branch>')
    expect(previewWorktreePath(null, 'x')).toBe('')
  })

  it('names the base the branch is cut from', () => {
    expect(baseLabel(REPO)).toBe('origin/main')
    expect(baseLabel({ isRepo: true, mainRoot: '/tmp/repo' })).toBe('HEAD')
  })

  it('sends the worktree block only when the directory is a checkout', () => {
    expect(buildSessionRequest(FORM, REPO)).toEqual({
      name: 'Companion App',
      cwd: '/Users/leo/code/commando',
      worktree: { branch: 'companion-app', prepareCommand: 'npm install' },
    })
    expect(buildSessionRequest(FORM, { isRepo: false }).worktree).toBeUndefined()
    expect(buildSessionRequest({ ...FORM, worktreeEnabled: false }, REPO).worktree).toBeUndefined()
  })

  it('sends a path only when it differs from the daemon default, and drops an unwanted preparation', () => {
    const request = buildSessionRequest(
      { ...FORM, worktreePath: '/Volumes/work/companion', prepareEnabled: false },
      REPO,
    )
    expect(request.worktree).toEqual({ branch: 'companion-app', path: '/Volumes/work/companion' })
  })

  it('quotes the prompt so a shell cannot reinterpret it', () => {
    expect(shellQuote("don't $HOME `whoami`")).toBe("'don'\\''t $HOME `whoami`'")
    expect(agentRunCommand('claude', "Read Leo's spec"))
      .toBe("claude 'Read Leo'\\''s spec'")
    expect(agentRunCommand('codex', 'Fix the poll')).toBe("codex 'Fix the poll'")
  })

  it('runs the bare command without a prompt, never runs anything for a shell, and never prompts opencode', () => {
    expect(agentRunCommand('claude', '   ')).toBe('claude')
    expect(agentRunCommand('shell', 'anything')).toBeNull()
    expect(agentRunCommand('opencode', 'anything')).toBe('opencode')
  })

  it('flattens a multi-line prompt, which the daemon would otherwise reject', () => {
    expect(flattenPrompt('Read the spec\n\nthen update the checklist'))
      .toBe('Read the spec then update the checklist')
    expect(agentRunCommand('claude', 'one\ntwo')).toBe("claude 'one two'")
  })

  it('offers the repositories the panes are in, then the remembered directories', () => {
    const options = repoOptions(SNAPSHOT, ['/Users/leo/code/commando', '/Users/leo/notes'])
    expect(options.map((option) => option.name))
      .toEqual(['commando', 'island', 'lavish', 'notes-vault', 'notes'])
    expect(options[0]?.defaultBranch).toBe('main')
    expect(options.at(-1)).toEqual({ root: '/Users/leo/notes', name: 'notes', fromHistory: true })
  })
})
