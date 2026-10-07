import { describe, expect, it, vi } from 'vitest'
import { PrService, PrServiceError } from './prs.js'
import { PrStackService } from './pr-stacks.js'

const repo = 'acme/widgets'
const target = '123e4567-e89b-42d3-a456-426614174000'
function pr(number: number, base: string, head: string, extra = {}) {
  return { number, state: 'open', draft: false, merged_at: null, base: { ref: base }, head: { ref: head, repo: { full_name: repo } }, stack: null, ...extra }
}
const first = pr(10, 'main', 'models')
const second = pr(20, 'models', 'api')
const third = pr(30, 'api', 'ui')
function stack(prs = [first, second]) {
  return { number: 7, base: { ref: 'main' }, open: true, pull_requests: prs }
}
function setup(prs = [first, second, third], existing?: ReturnType<typeof stack>) {
  const runner = vi.fn(async (args: string[]) => {
    const path = args.find((arg) => arg.startsWith(`repos/${repo}`))
    if (path?.includes('stacks?')) return '[]'
    if (args.includes('POST')) return JSON.stringify(stack(path?.endsWith('/add') ? [first, second, third] : prs.slice(0, 2)))
    if (path === `repos/${repo}/stacks/7`) return JSON.stringify(existing ?? stack())
    const match = path?.match(/\/pulls\/(\d+)$/)
    if (match) return JSON.stringify(prs.find((pr) => pr.number === Number(match[1])))
    throw new Error(`Unexpected command: ${args.join(' ')}`)
  })
  const invalidate = vi.fn()
  return { runner, invalidate, service: new PrStackService(runner, invalidate) }
}

describe('native PR stacks', () => {
  it('links an ordered live branch chain without editing PR bases', async () => {
    const { runner, service, invalidate } = setup()
    await expect(service.link(repo, [10, 20])).resolves.toMatchObject({ number: 7, baseRefName: 'main', pullRequests: [{ number: 10 }, { number: 20 }] })
    expect(runner).toHaveBeenLastCalledWith(['api', '--method', 'POST', `repos/${repo}/stacks`, '-F', 'pull_requests[]=10', '-F', 'pull_requests[]=20'])
    expect(runner.mock.calls.some(([args]) => args.includes('PATCH'))).toBe(false)
    expect(invalidate).toHaveBeenCalledWith(repo)
  })

  it.each([[10], [10, 10], [0, 20], ['10', 20], [10, 2.5]])('rejects malformed selections %j before reading GitHub', async (...values) => {
    const { runner, service } = setup()
    await expect(service.link(repo, values)).rejects.toMatchObject({ status: 400 })
    expect(runner).not.toHaveBeenCalled()
  })

  it('rejects a stale or reversed chain without a write', async () => {
    const { runner, service } = setup([first, pr(20, 'main', 'api')])
    await expect(service.link(repo, [10, 20])).rejects.toMatchObject({ code: 'invalid_stack_chain' })
    expect(runner.mock.calls.some(([args]) => args.includes('POST'))).toBe(false)
  })

  it('appends only the delta to an existing partially merged stack', async () => {
    const merged = pr(10, 'main', 'models', { state: 'closed', merged_at: '2026-10-01', stack: { number: 7 } })
    const retargeted = pr(20, 'main', 'api', { stack: { number: 7 } })
    const { runner, service } = setup([merged, retargeted, third], stack([merged, retargeted]))
    await service.link(repo, [10, 20, 30])
    expect(runner).toHaveBeenLastCalledWith(['api', '--method', 'POST', `repos/${repo}/stacks/7/add`, '-F', 'pull_requests[]=30'])
  })

  it('requires the complete native prefix, and does not rewrite a stack', async () => {
    const { runner, service } = setup([first, pr(20, 'models', 'api', { stack: { number: 7 } }), third])
    await expect(service.link(repo, [20, 30])).rejects.toMatchObject({ code: 'invalid_stack_chain' })
    expect(runner.mock.calls.some(([args]) => args.includes('POST'))).toBe(false)
  })

  it('makes repeated linking of the same stack idempotent', async () => {
    const { runner, service } = setup([pr(10, 'main', 'models', { stack: { number: 7 } }), pr(20, 'models', 'api', { stack: { number: 7 } })])
    await service.link(repo, [10, 20])
    expect(runner.mock.calls.some(([args]) => args.includes('POST'))).toBe(false)
  })

  it('reports preview unavailability before creating a PR', async () => {
    const runner = vi.fn().mockRejectedValue(new PrServiceError(502, 'github_failed', 'GitHub request failed: gh: Not Found (HTTP 404)'))
    await expect(new PrStackService(runner, vi.fn()).create(repo, 10, { head: 'api', title: 'API', body: '', draft: true })).rejects.toMatchObject({ code: 'stacks_unavailable', status: 404 })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('creates against the live parent and stamps only the creating pane marker', async () => {
    const { runner, service } = setup()
    const normal = runner.getMockImplementation()!
    runner.mockImplementation(async (args) => args.includes('POST') && args.includes(`repos/${repo}/pulls`) ? JSON.stringify(second) : normal(args))
    await expect(service.create(repo, 10, { head: 'api', title: 'API', body: 'Layer\n<!-- commando:v1 target=111e4567-e89b-42d3-a456-426614174000 relation=created -->', draft: true }, target)).resolves.toMatchObject({ pullRequest: { number: 20 }, stack: { number: 7 } })
    const create = runner.mock.calls.find(([args]) => args.includes(`repos/${repo}/pulls`))![0]
    expect(create).toContain('base=models')
    expect(create).toContain('draft=true')
    expect(create).toContain(`body=Layer\n\n<!-- commando:v1 target=${target} relation=created -->`)
  })

  it('retains created PR evidence when linking fails so the UI cannot repeat creation', async () => {
    const { runner, service } = setup()
    const normal = runner.getMockImplementation()!
    runner.mockImplementation(async (args) => {
      if (args.includes('POST') && args.includes(`repos/${repo}/pulls`)) return JSON.stringify(second)
      if (args.includes('POST')) throw new PrServiceError(502, 'github_failed', 'GitHub timed out')
      return normal(args)
    })
    await expect(service.create(repo, 10, { head: 'api', title: 'API', body: '', draft: false })).resolves.toMatchObject({ pullRequest: { number: 20 }, stack: null, warning: expect.stringContaining('10, 20') })
    expect(runner.mock.calls.filter(([args]) => args.includes(`repos/${repo}/pulls`))).toHaveLength(1)
  })

  it('requires the top parent before any new PR write', async () => {
    const { runner, service } = setup([pr(10, 'main', 'models', { stack: { number: 7 } }), second])
    await expect(service.create(repo, 10, { head: 'ui', title: 'UI', body: '', draft: true })).rejects.toMatchObject({ code: 'invalid_stack_chain' })
    expect(runner.mock.calls.some(([args]) => args.includes('POST'))).toBe(false)
  })

  it('serializes same-repository mutations', async () => {
    let finish!: (output: string) => void
    const runner = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const service = new PrStackService(runner, vi.fn())
    const firstRequest = service.link(repo, [10, 20])
    await expect(service.link('ACME/Widgets', [10, 20])).rejects.toMatchObject({ code: 'stack_in_progress' })
    finish('{}')
    await expect(firstRequest).rejects.toMatchObject({ code: 'github_invalid_response' })
  })

  it('reads the full stack, including merged layers and canonical links', async () => {
    const { service } = setup([], stack([pr(10, 'main', 'models', { state: 'closed', merged_at: '2026-10-01' }), second]))
    expect((await service.get(repo, 7)).pullRequests[0]).toMatchObject({ state: 'merged', url: 'https://github.com/acme/widgets/pull/10' })
  })

  it('the PR service exposes native stack APIs without extra list polling', () => {
    expect(new PrService({ runner: vi.fn() }).stacks).toBeInstanceOf(PrStackService)
  })
})
