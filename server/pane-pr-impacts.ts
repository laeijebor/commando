import { isAbsolute, resolve } from 'node:path'
import { isPanePrImpact, isPanePrRef, type PanePrRef } from './pane-pr-records.js'
import type { PrImpactHookReport } from './pr-impact-hook.js'

/** An impact from the hook, plus the hook's own cwd to fall back on. */
export type PrImpactReport = PrImpactHookReport & { fallbackCwd?: string }

const MAX_REPORTS = 10
const BRANCH = /^(?![-/.])(?!.*\.\.)[A-Za-z0-9._/+-]{1,200}$/
const REMOTE = /^(?!-)[A-Za-z0-9._-]{1,100}$/
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/

function cleanPath(value: unknown): string | undefined {
  return typeof value === 'string' && isAbsolute(value) && value.length <= 4096 && !value.includes('\0') ? resolve(value) : undefined
}

/** Keeps the well-formed reports of a hook body, dropping anything else. */
export function parsePrImpactReports(value: unknown, fallbackCwd: unknown): PrImpactReport[] {
  if (!Array.isArray(value)) return []
  const fallback = cleanPath(fallbackCwd)
  return value.slice(0, MAX_REPORTS).flatMap((item): PrImpactReport[] => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const raw = item as Record<string, unknown>
    if (!isPanePrImpact(raw.relation)) return []
    const report: PrImpactReport = { relation: raw.relation }
    const cwd = cleanPath(raw.cwd)
    if (cwd) report.cwd = cwd
    // Only a relative cd can have been applied twice; without a cwd the command's place is unknown.
    if (cwd && fallback && fallback !== cwd) report.fallbackCwd = fallback
    if (raw.repo !== undefined || raw.number !== undefined) {
      const ref = { repo: raw.repo ?? 'unknown/unknown', number: raw.number ?? 1 }
      if (!isPanePrRef(ref)) return []
      if (raw.repo !== undefined) report.repo = ref.repo
      if (raw.number !== undefined) report.number = ref.number
    }
    if (raw.branch !== undefined) {
      if (typeof raw.branch !== 'string' || !BRANCH.test(raw.branch)) return []
      report.branch = raw.branch
    }
    if (raw.headOwner !== undefined) {
      if (typeof raw.headOwner !== 'string' || !OWNER.test(raw.headOwner)) return []
      report.headOwner = raw.headOwner
    }
    if (raw.remote !== undefined) {
      if (typeof raw.remote !== 'string' || !REMOTE.test(raw.remote)) return []
      report.remote = raw.remote
    }
    return [report]
  })
}

export type PrImpactResolver = {
  git: (args: string[], cwd: string) => Promise<string>
  repoFromRemote: (url: string) => string | null
  /** The PR whose head is this branch of the repo (or of `headOwner`'s fork), preferring an open one. */
  pullRequestForBranch: (repo: string, branch: string, headOwner?: string) => Promise<number | null>
}

/**
 * Finds the PR a push or `gh pr` command touched, the way git and gh would:
 * a push goes to the branch's push remote, a `gh pr` command without a repo to
 * gh's base remote, and a missing PR selector means the current branch.
 * Returns null when it can't tell.
 */
export async function resolvePrImpact(report: PrImpactReport, resolver: PrImpactResolver): Promise<PanePrRef | null> {
  if (report.repo && report.number) return { repo: report.repo, number: report.number }
  if (report.repo && report.branch) return forBranch(report.repo, report.branch, report, resolver)
  const cwd = await workingDirectory(report, resolver)
  if (!cwd) return null
  const git = async (args: string[]) => (await resolver.git(args, cwd).catch(() => '')).trim()
  let repo = report.repo
  let branch = report.branch
  if (report.relation === 'pushed') {
    let remote = report.remote
    if (!remote || !branch) {
      // Where a bare `git push` sends the current branch, e.g. "origin/feat".
      const push = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'])
      const slash = push.indexOf('/')
      if (slash > 0 && (!remote || remote === push.slice(0, slash))) {
        remote ??= push.slice(0, slash)
        branch ??= push.slice(slash + 1)
      }
      branch ??= await currentBranch(git)
      remote ??= 'origin'
    }
    // A push goes to the remote's pushurl, which git falls back from to its url.
    repo ??= resolver.repoFromRemote(await git(['remote', 'get-url', '--push', remote])) ?? undefined
  } else {
    repo ??= await ghBaseRepo(git, resolver)
    if (!report.number) branch ??= await currentBranch(git)
  }
  if (!repo) return null
  if (report.number) return { repo, number: report.number }
  return branch && BRANCH.test(branch) ? forBranch(repo, branch, report, resolver) : null
}

async function forBranch(repo: string, branch: string, report: PrImpactReport, resolver: PrImpactResolver): Promise<PanePrRef | null> {
  const number = await resolver.pullRequestForBranch(repo, branch, report.headOwner)
  return number ? { repo, number } : null
}

/** The command's own directory, or the hook's when a relative `cd` led somewhere git can't find. */
async function workingDirectory(report: PrImpactReport, resolver: PrImpactResolver): Promise<string | undefined> {
  for (const cwd of [report.cwd, report.fallbackCwd]) {
    if (cwd && await resolver.git(['rev-parse', '--git-dir'], cwd).then(() => true, () => false)) return cwd
  }
  return undefined
}

async function currentBranch(git: (args: string[]) => Promise<string>): Promise<string | undefined> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  return branch && branch !== 'HEAD' ? branch : undefined
}

/** gh's default repo: the remote `gh repo set-default` chose, else upstream, github, then origin. */
async function ghBaseRepo(git: (args: string[]) => Promise<string>, resolver: PrImpactResolver): Promise<string | undefined> {
  const chosen = /^remote\.(.+)\.gh-resolved base$/m.exec(await git(['config', '--get-regexp', '^remote\\..*\\.gh-resolved$']))?.[1]
  const remotes = (await git(['remote'])).split('\n').map((remote) => remote.trim()).filter(Boolean)
  const ordered = [chosen, 'upstream', 'github', 'origin', ...remotes].filter((remote): remote is string => Boolean(remote) && remotes.includes(remote!))
  for (const remote of new Set(ordered)) {
    const repo = resolver.repoFromRemote(await git(['remote', 'get-url', remote]))
    if (repo) return repo
  }
  return undefined
}
