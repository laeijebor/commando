import { SNAPSHOT } from '../testing/fixtures'
import {
  AGENT_CHOICES,
  DEFAULT_AGENT_CHOICE,
  baseLabel,
  buildSessionRequest,
  effectiveBranch,
  previewWorktreePath,
  repoOptions,
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

  it('keeps Claude as the mobile default and offers Cursor', () => {
    expect(DEFAULT_AGENT_CHOICE).toBe('claude')
    expect(AGENT_CHOICES).toContainEqual({ value: 'cursor', label: 'Cursor' })
  })

  it('sends an interactive agent launch with an intact multiline prompt', () => {
    const prompt = "Read Leo's spec\nthen inspect $HOME `whoami`"
    expect(buildSessionRequest({ ...FORM, agent: 'cursor', prompt }, REPO).agent)
      .toEqual({ provider: 'cursor', prompt })
    expect(buildSessionRequest({ ...FORM, agent: 'shell', prompt }, REPO).agent).toBeUndefined()
    expect(buildSessionRequest({ ...FORM, agent: 'opencode', prompt }, REPO).agent)
      .toEqual({ provider: 'opencode' })
    expect(buildSessionRequest({ ...FORM, agent: 'claude', prompt: '   ' }, REPO).agent)
      .toEqual({ provider: 'claude' })
  })

  it('offers the repositories the panes are in, then the remembered directories', () => {
    const options = repoOptions(SNAPSHOT, ['/Users/leo/code/commando', '/Users/leo/notes'])
    expect(options.map((option) => option.name))
      .toEqual(['commando', 'island', 'lavish', 'notes-vault', 'notes'])
    expect(options[0]?.defaultBranch).toBe('main')
    expect(options.at(-1)).toEqual({ root: '/Users/leo/notes', name: 'notes', fromHistory: true })
  })
})
