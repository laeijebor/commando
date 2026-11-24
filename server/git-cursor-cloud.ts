import { defaultGitProcessExecutor, type GitProcessExecutor } from './git-diff.js'
import type { GitRepoInfo } from '../shared/tmux-create.js'

/** GitHub clone URLs accepted by the repo probe, including SSH clone URLs. */
export function normaliseGithubUrl(value: string): string | undefined {
  if (value !== value.trim()) return undefined
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value)
  if (!match || match[2] === '.' || match[2] === '..') return undefined
  return `https://github.com/${match[1]}/${match[2]}`
}

export class GitCursorCloud {
  constructor(private readonly execute: GitProcessExecutor = defaultGitProcessExecutor) {}

  private async git(cwd: string, args: string[]): Promise<string> {
    return (await this.execute('git', args, {
      cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' },
      maxBuffer: 1024 * 1024, shell: false, timeout: 5_000, windowsHide: true,
    })).stdout.trim()
  }

  private async remotes(cwd: string): Promise<{ remote: string; repoUrl: string }[]> {
    const names = (await this.git(cwd, ['remote'])).split('\n').filter(Boolean).sort((a, b) => a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b))
    const remotes = []
    for (const remote of names) {
      const repoUrl = normaliseGithubUrl(await this.git(cwd, ['remote', 'get-url', remote]))
      if (repoUrl) remotes.push({ remote, repoUrl })
    }
    return remotes
  }

  /** Probe cached tracking refs without fetching or prompting for credentials. */
  async probe(cwd: string, branch: string, defaultBranch?: string): Promise<GitRepoInfo['github']> {
    const remote = (await this.remotes(cwd))[0]
    if (!remote) return undefined
    let ref = branch && branch !== 'HEAD' ? branch : undefined
    if (!ref) {
      const head = await this.git(cwd, ['symbolic-ref', '--short', `refs/remotes/${remote.remote}/HEAD`]).catch(() => '')
      ref = head.startsWith(`${remote.remote}/`) ? head.slice(remote.remote.length + 1) : defaultBranch
    }
    if (!ref) return undefined
    const tracking = `refs/remotes/${remote.remote}/${ref}`
    try {
      await this.git(cwd, ['rev-parse', '--verify', tracking])
    } catch {
      return { ...remote, ref, pushed: false, ahead: 0, behind: 0 }
    }
    const [behind, ahead] = (await this.git(cwd, ['rev-list', '--left-right', '--count', `${tracking}...HEAD`])).split(/\s+/).map(Number)
    return { ...remote, ref, pushed: true, ahead: ahead ?? 0, behind: behind ?? 0 }
  }

  /** Verify the pushed tip at launch time, independently of stale tracking refs. */
  async assertPushed(cwd: string, repoUrl: string, ref: string): Promise<void> {
    const remote = (await this.remotes(cwd)).find((entry) => entry.repoUrl.toLowerCase() === repoUrl.toLowerCase())
    if (!remote) throw new Error('No GitHub remote matches the Cursor cloud repository')
    const output = await this.git(cwd, ['ls-remote', remote.remote, `refs/heads/${ref}`])
    if (!output.split('\n').some((line) => line.split(/\s+/)[1] === `refs/heads/${ref}`)) {
      throw new Error(`Push ${ref} to GitHub first; Cursor's cloud starts from the pushed branch.`)
    }
  }
}
