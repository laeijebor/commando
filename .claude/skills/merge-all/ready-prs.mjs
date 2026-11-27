#!/usr/bin/env node
// Lists the open PRs this Commando chat created and whether each is ready to merge.
//
//   node .claude/skills/merge-all/ready-prs.mjs [--target UUID]
//
// A PR belongs to this chat when its description carries this pane's Commando
// marker (`<!-- commando:v1 target=<uuid> ... -->`). Ready means all of:
//   - open, not a draft, mergeable with a clean merge state
//   - every status check passed (a PR without checks passes)
//   - an approving review, and no outstanding change request
//   - no open bot findings: Codex's latest review has none unresolved and
//     isn't still running, and no unresolved, current thread from another bot
// It also lists the PR's own commits that aren't on local `next` yet (by patch
// or, for a conflict-resolved cherry-pick, by subject), so they can be integrated
// before `next` moves into `main`.
// Prints JSON: { target, repo, main, prs: [{ number, title, url, branch, head, ready, reasons, missingFromNext }] }.

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()
const gh = (...args) => run('gh', args)

function paneTarget() {
  const flag = process.argv.indexOf('--target')
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1]
  const marker = run('node', [join(homedir(), '.commando', 'hooks', 'commando-pr-marker.mjs')])
  const target = /target=([0-9a-f-]{36})/i.exec(marker)?.[1]
  if (!target) throw new Error(`No Commando pane marker for this chat (got: ${marker || 'nothing'})`)
  return target
}

/** The main checkout: the first worktree git lists. */
function mainCheckout() {
  return /^worktree (.+)$/m.exec(run('git', ['worktree', 'list', '--porcelain']))?.[1]
}

/** Subjects of the PR's own commits that `next` has neither as a patch nor by subject. */
function missingFromNext(main, branch, head) {
  const git = (...args) => run('git', ['-C', main, ...args])
  git('fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`, 'main')
  if (git('rev-parse', `origin/${branch}`) !== head) throw new Error(`origin/${branch} is not at the PR head ${head}`)
  const base = git('merge-base', 'origin/main', head)
  const own = new Set(git('rev-list', '--no-merges', `${base}..${head}`).split('\n'))
  const pending = git('cherry', 'next', head, base).split('\n').filter((line) => line.startsWith('+ ')).map((line) => line.slice(2)).filter((sha) => own.has(sha))
  if (!pending.length) return []
  const onNext = new Set(git('log', '--no-merges', '--format=%s', `${base}..next`).split('\n'))
  return pending.map((sha) => git('log', '-1', '--format=%s', sha)).filter((subject) => !onNext.has(subject))
}

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const CLEAN_STATES = new Set(['CLEAN', 'HAS_HOOKS'])

function checkProblems(rollup) {
  const problems = []
  for (const check of rollup ?? []) {
    const name = check.name ?? check.context ?? 'check'
    // CheckRun: status + conclusion; StatusContext: state.
    const result = check.__typename === 'StatusContext' ? check.state : check.status === 'COMPLETED' ? check.conclusion : 'PENDING'
    if (!PASSED.has(result)) problems.push(`check ${name}: ${String(result).toLowerCase()}`)
  }
  return problems
}

function approvalProblems(pr) {
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return ['changes requested']
  // The latest review from each reviewer decides; comments don't replace a verdict.
  const verdicts = new Map()
  for (const review of pr.reviews ?? []) {
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED') verdicts.set(review.author?.login, review.state)
  }
  const latest = [...verdicts.values()]
  // reviewDecision is null without a required-review rule, so check the verdicts themselves.
  if (latest.includes('CHANGES_REQUESTED')) return ['changes requested']
  return latest.includes('APPROVED') ? [] : ['no approving review']
}

/** Codex keeps its review state as JSON in a summary comment. */
function codexState(comments) {
  let state
  for (const comment of comments ?? []) {
    const match = /codex-review-state:v1 (\{.*?\}) -->/s.exec(comment.body ?? '')
    if (!match) continue
    try { state = JSON.parse(match[1]).code_review } catch { /* a malformed state is ignored */ }
  }
  return state
}

function botProblems(pr, threads) {
  const problems = []
  const codex = codexState(pr.comments)
  if (codex?.status && codex.status !== 'completed') problems.push(`Codex review ${codex.status}`)
  else if (codex?.has_unresolved_findings) problems.push(`Codex has unresolved findings (review of ${String(codex.commit_sha).slice(0, 8)})`)
  if (codex?.commit_sha && codex.commit_sha !== pr.headRefOid && codex.has_unresolved_findings !== false) {
    problems.push('Codex has not reviewed the head commit; comment "@codex review"')
  }
  // With a review state, Codex's own threads are settled by it (a fixed finding's thread often
  // stays open); without one, its unresolved threads count like any other bot's.
  const open = threads.filter((thread) => !thread.isResolved && !thread.isOutdated)
    .map((thread) => thread.comments.nodes[0]?.author)
    .filter((author) => author?.__typename === 'Bot' && !(codex && /codex/i.test(author.login)))
  if (open.length) problems.push(`${open.length} unresolved bot thread(s) from ${[...new Set(open.map((author) => author.login))].join(', ')}`)
  return problems
}

function reviewThreads(owner, name, number) {
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){nodes{author{__typename login}}}}}}}}`
  const result = JSON.parse(gh('api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`))
  return result.data.repository.pullRequest.reviewThreads.nodes
}

const target = paneTarget()
const main = mainCheckout()
const repo = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')
const [owner, name] = repo.split('/')
const open = JSON.parse(gh('pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,body'))
const mine = open.filter((pr) => (pr.body ?? '').includes(`target=${target}`)).map((pr) => pr.number)

const prs = mine.map((number) => {
  const pr = JSON.parse(gh('pr', 'view', String(number), '--json', 'number,title,url,isDraft,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,reviews,comments'))
  const reasons = []
  if (pr.isDraft) reasons.push('draft')
  if (pr.mergeable !== 'MERGEABLE') reasons.push(`mergeable: ${String(pr.mergeable).toLowerCase()}`)
  else if (!CLEAN_STATES.has(pr.mergeStateStatus)) reasons.push(`merge state: ${String(pr.mergeStateStatus).toLowerCase()}`)
  reasons.push(...checkProblems(pr.statusCheckRollup), ...approvalProblems(pr), ...botProblems(pr, reviewThreads(owner, name, number)))
  return { number, title: pr.title, url: pr.url, branch: pr.headRefName, head: pr.headRefOid, ready: reasons.length === 0, reasons, missingFromNext: missingFromNext(main, pr.headRefName, pr.headRefOid) }
})

console.log(JSON.stringify({ target, repo, main, prs }, null, 2))
