import { formatCommandoPrMarker, stripCommandoPrMarkers } from '../shared/pane-target.js'
import type { PrStack, StackedPrResult } from '../shared/pr-stacks.js'
import { PrServiceError, validateRepo, validatePrNumber, type GhRunner } from './prs.js'

type RecordValue = Record<string, unknown>
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PrServiceError(502, 'github_invalid_response', 'GitHub returned invalid stack data')
  return value as RecordValue
}
function parse(output: string): RecordValue {
  try { return object(JSON.parse(output)) } catch (error) {
    if (error instanceof PrServiceError) throw error
    throw new PrServiceError(502, 'github_invalid_response', 'GitHub returned invalid stack data')
  }
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new PrServiceError(502, 'github_invalid_response', 'GitHub returned invalid stack data')
  return value
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new PrServiceError(502, 'github_invalid_response', 'GitHub returned invalid stack data')
  return Number(value)
}
function stackFrom(value: RecordValue, repo: string): PrStack {
  if (!Array.isArray(value.pull_requests) || typeof value.open !== 'boolean') throw new PrServiceError(502, 'github_invalid_response', 'GitHub returned invalid stack data')
  return {
    number: number(value.number), baseRefName: text(object(value.base).ref), open: value.open,
    pullRequests: value.pull_requests.map((entry) => {
      const pr = object(entry)
      if (!['open', 'closed'].includes(String(pr.state)) || typeof pr.draft !== 'boolean') throw new PrServiceError(502, 'github_invalid_response', 'GitHub returned invalid stack data')
      const prNumber = number(pr.number)
      return { number: prNumber, state: pr.merged_at ? 'merged' : pr.state as 'open' | 'closed', isDraft: pr.draft,
        headRefName: text(object(pr.head).ref), url: `https://github.com/${repo}/pull/${prNumber}` }
    }),
  }
}

// Native API only: never push, check out, rebase, or retarget a user's branch.
export class PrStackService {
  private readonly mutating = new Set<string>()
  constructor(private readonly runner: GhRunner, private readonly invalidate: (repo: string) => void) {}

  private async api(args: string[]): Promise<string> {
    try { return await this.runner(['api', ...args]) } catch (error) {
      if (error instanceof PrServiceError && /HTTP 404/.test(error.message) && args.some((arg) => /\/stacks(?:[/?]|$)/.test(arg))) {
        throw new PrServiceError(404, 'stacks_unavailable', 'Stacked PRs preview is unavailable for this repository or your GitHub account. Enable it on GitHub, then retry.')
      }
      throw error
    }
  }

  async get(repoInput: unknown, stackInput: unknown): Promise<PrStack> {
    const repo = validateRepo(repoInput)
    const stack = validatePrNumber(stackInput)
    return stackFrom(parse(await this.api([`repos/${repo}/stacks/${stack}`])), repo)
  }

  private async available(repo: string): Promise<void> {
    const output = await this.api([`repos/${repo}/stacks?per_page=1`])
    try { if (Array.isArray(JSON.parse(output))) return } catch { /* invalid response below */ }
    throw new PrServiceError(502, 'github_invalid_response', 'GitHub returned invalid stack data')
  }

  private async pr(repo: string, prNumber: number): Promise<RecordValue> {
    const pr = parse(await this.api([`repos/${repo}/pulls/${prNumber}`]))
    if (number(pr.number) !== prNumber) throw new PrServiceError(502, 'github_invalid_response', 'GitHub returned the wrong pull request')
    return pr
  }

  private async mutate<T>(repo: string, action: () => Promise<T>): Promise<T> {
    const key = repo.toLowerCase()
    if (this.mutating.has(key)) throw new PrServiceError(409, 'stack_in_progress', 'A stack action is already in progress for this repository')
    this.mutating.add(key)
    try { return await action() } finally { this.mutating.delete(key); this.invalidate(repo) }
  }

  async link(repoInput: unknown, numbersInput: unknown): Promise<PrStack> {
    const repo = validateRepo(repoInput)
    if (!Array.isArray(numbersInput) || numbersInput.length < 2 || numbersInput.length > 100 || !numbersInput.every((value) => typeof value === 'number')) {
      throw new PrServiceError(400, 'invalid_request', 'Choose 2–100 PR numbers in bottom-to-top order')
    }
    const numbers = numbersInput.map(validatePrNumber)
    if (new Set(numbers).size !== numbers.length) throw new PrServiceError(400, 'invalid_request', 'Each PR must appear only once')
    return this.mutate(repo, async () => {
      await this.available(repo)
      return this.linkLive(repo, numbers)
    })
  }

  private async linkLive(repo: string, numbers: number[]): Promise<PrStack> {
    // Read the live PRs, not the client's (possibly scoped/truncated) card list.
    const prs: RecordValue[] = []
    for (const prNumber of numbers) prs.push(await this.pr(repo, prNumber))
    const memberships = prs.map((pr) => pr.stack ? object(pr.stack) : null)
    const existingNumbers = new Set(memberships.filter((membership) => membership !== null).map((membership) => number(membership.number)))
    if (existingNumbers.size > 1) throw new PrServiceError(409, 'invalid_stack_chain', 'These PRs belong to different stacks')
    const existingNumber = [...existingNumbers][0]
    let endpoint = `repos/${repo}/stacks`
    let delta = numbers
    let prefixLength = 0
    if (existingNumber !== undefined) {
      const existing = await this.get(repo, existingNumber)
      const prefix = existing.pullRequests.map((pr) => pr.number)
      if (prefix.length > numbers.length || prefix.some((prNumber, index) => prNumber !== numbers[index])) {
        throw new PrServiceError(409, 'invalid_stack_chain', 'Include the entire existing stack first, in bottom-to-top order, then append new PRs')
      }
      delta = numbers.slice(prefix.length)
      if (!delta.length) return existing
      if (!existing.open) throw new PrServiceError(409, 'invalid_stack_chain', 'A completed stack cannot be extended; start a new stack')
      prefixLength = prefix.length
      endpoint += `/${existingNumber}/add`
    }
    for (let index = 0; index < prs.length; index++) {
      const pr = prs[index]
      if (index >= prefixLength && pr.state !== 'open') throw new PrServiceError(409, 'invalid_stack_chain', `PR #${numbers[index]} must be open`)
      const head = object(pr.head)
      if (text(object(head.repo).full_name).toLowerCase() !== repo.toLowerCase()) throw new PrServiceError(409, 'invalid_stack_chain', 'Stack branches must belong to the selected repository')
      // GitHub may retarget entries within a partially merged native stack.
      // Its existing prefix is authoritative; validate every newly appended edge.
      if (index > 0 && index >= prefixLength && text(object(pr.base).ref) !== text(object(prs[index - 1].head).ref)) {
        throw new PrServiceError(409, 'invalid_stack_chain', `PR #${numbers[index]} must already target ${text(object(prs[index - 1].head).ref)}. Fix its base on GitHub before linking.`)
      }
    }
    return stackFrom(parse(await this.api(['--method', 'POST', endpoint, ...delta.flatMap((prNumber) => ['-F', `pull_requests[]=${prNumber}`])])), repo)
  }

  async create(repoInput: unknown, parentInput: unknown, input: unknown, targetId?: string): Promise<StackedPrResult> {
    const repo = validateRepo(repoInput)
    const parentNumber = validatePrNumber(parentInput)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PrServiceError(400, 'invalid_request', 'Provide the new PR details')
    const request = input as RecordValue
    // Only same-repository, already-pushed branches; reject revision expressions and fork syntax.
    if (typeof request.head !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,249}$/.test(request.head)
      || request.head.includes('..') || request.head.includes('//') || request.head.endsWith('/') || request.head.endsWith('.') || request.head.split('/').some((part) => part.endsWith('.lock'))) {
      throw new PrServiceError(400, 'invalid_request', 'Enter a valid already-pushed branch in this repository')
    }
    if (typeof request.title !== 'string' || !request.title.trim() || request.title.length > 256 || typeof request.body !== 'string' || request.body.length > 60_000 || typeof request.draft !== 'boolean') {
      throw new PrServiceError(400, 'invalid_request', 'Provide a title, description, and draft choice')
    }
    const body = `${stripCommandoPrMarkers(request.body).trim()}${targetId ? `\n\n${formatCommandoPrMarker(targetId)}` : ''}`
    const title = request.title.trim()
    return this.mutate(repo, async () => {
      await this.available(repo) // Fail before creating anything when preview is disabled.
      const parent = await this.pr(repo, parentNumber)
      const head = object(parent.head)
      if (parent.state !== 'open' || text(object(head.repo).full_name).toLowerCase() !== repo.toLowerCase()) {
        throw new PrServiceError(409, 'invalid_stack_chain', 'The parent must be an open PR with a branch in this repository')
      }
      const base = text(head.ref)
      if (base === request.head) throw new PrServiceError(400, 'invalid_request', 'The new branch must differ from its parent')
      let numbers = [parentNumber]
      if (parent.stack) {
        const stack = await this.get(repo, number(object(parent.stack).number))
        if (!stack.open || stack.pullRequests.at(-1)?.number !== parentNumber) throw new PrServiceError(409, 'invalid_stack_chain', 'Choose the top PR of the existing stack')
        numbers = stack.pullRequests.map((pr) => pr.number)
      }
      if (numbers.length >= 100) throw new PrServiceError(409, 'invalid_stack_chain', 'This stack already has the maximum 100 PRs')
      const created = parse(await this.api(['--method', 'POST', `repos/${repo}/pulls`,
        '-f', `head=${request.head}`, '-f', `base=${base}`, '-f', `title=${title}`, '-f', `body=${body}`, '-F', `draft=${request.draft}`]))
      const prNumber = number(created.number)
      const pullRequest = { number: prNumber, url: `https://github.com/${repo}/pull/${prNumber}` }
      try {
        return { pullRequest, stack: await this.linkLive(repo, [...numbers, prNumber]) }
      } catch (error) {
        // Do not turn successful PR creation into a retryable create error.
        return { pullRequest, stack: null, warning: `PR #${prNumber} was created, but stack linking could not be confirmed. Refresh and use Link existing PRs (${[...numbers, prNumber].join(', ')}). ${error instanceof Error ? error.message : ''}` }
      }
    })
  }
}
