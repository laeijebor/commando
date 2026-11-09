import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanePrRecords, recordRelation } from './pane-pr-records.js'

const target = '123e4567-e89b-42d3-a456-426614174000'
const other = '550e8400-e29b-41d4-a716-446655440000'
const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'commando-pane-prs-'))
  directories.push(directory)
  return join(directory, 'nested', 'pane-prs.json')
}

describe('pane PR records', () => {
  it('records each PR once per pane, newest first, ignoring case and invalid refs', async () => {
    const records = new PanePrRecords()
    expect(await records.add(target, [{ repo: 'acme/widgets', number: 1 }])).toBe(true)
    expect(await records.add(target, [
      { repo: 'ACME/widgets', number: 1 },
      { repo: 'acme/widgets', number: 2 },
      { repo: 'acme/widgets', number: 2 },
      { repo: 'not a repo', number: 3 },
      { repo: 'acme/widgets', number: 0 },
      { repo: 'acme/widgets', number: 2 ** 31 },
    ])).toBe(true)
    expect(await records.add(target, [{ repo: 'acme/widgets', number: 2 }])).toBe(false)
    expect(await records.add('not-a-target', [{ repo: 'acme/widgets', number: 4 }])).toBe(false)
    expect((await records.list(target)).map(({ repo, number }) => `${repo}#${number}`)).toEqual(['acme/widgets#2', 'acme/widgets#1'])
    expect(await records.list(other)).toEqual([])
  })

  it('keeps only the 20 newest PRs of a pane', async () => {
    const records = new PanePrRecords()
    await records.add(target, Array.from({ length: 25 }, (_, index) => ({ repo: 'acme/widgets', number: index + 1 })))
    await records.add(target, [{ repo: 'acme/widgets', number: 99 }])
    const listed = await records.list(target)
    expect(listed).toHaveLength(20)
    expect(listed[0]).toMatchObject({ repo: 'acme/widgets', number: 99 })
  })

  it('keeps the 20 newest by creation time when the same long page is recorded again', async () => {
    const records = new PanePrRecords()
    const page = Array.from({ length: 30 }, (_, index) => ({ repo: 'acme/widgets', number: 30 - index, createdAt: (30 - index) * 1_000 }))
    expect(await records.add(target, page)).toBe(true)
    expect(await records.add(target, page)).toBe(false)
    expect((await records.list(target)).map((ref) => ref.number)).toEqual(Array.from({ length: 20 }, (_, index) => 30 - index))
  })

  it('does not rewrite its file when a long page brings nothing new', async () => {
    const path = await temporaryPath()
    const records = new PanePrRecords(path)
    const page = Array.from({ length: 30 }, (_, index) => ({ repo: 'acme/widgets', number: 30 - index, createdAt: (30 - index) * 1_000 }))
    await records.add(target, page)
    await records.flushed()
    await writeFile(path, 'sentinel')
    await records.add(target, page)
    await records.flushed()
    expect(await readFile(path, 'utf8')).toBe('sentinel')
  })

  it('reorders a PR once its creation time is known', async () => {
    let now = 50_000
    const records = new PanePrRecords(undefined, () => now)
    await records.add(target, [{ repo: 'acme/widgets', number: 5, createdAt: 40_000 }])
    now = 60_000
    // Reported by a hook: creation time unknown, so it counts as new.
    expect(await records.add(target, [{ repo: 'acme/widgets', number: 2 }])).toBe(true)
    expect((await records.list(target)).map((ref) => ref.number)).toEqual([2, 5])
    // A lookup shows it is an old PR.
    expect(await records.add(target, [{ repo: 'acme/widgets', number: 2, createdAt: 1_000 }])).toBe(false)
    expect((await records.list(target)).map((ref) => ref.number)).toEqual([5, 2])
  })

  it('removes records and forgets a pane with none left', async () => {
    const records = new PanePrRecords()
    await records.add(target, [{ repo: 'acme/widgets', number: 1 }, { repo: 'acme/widgets', number: 2 }])
    await records.remove(target, [{ repo: 'Acme/Widgets', number: 1 }])
    expect(await records.list(target)).toMatchObject([{ repo: 'acme/widgets', number: 2 }])
    await records.remove(target, [{ repo: 'acme/widgets', number: 2 }])
    expect(await records.list(target)).toEqual([])
  })

  it('survives a restart through its file', async () => {
    const path = await temporaryPath()
    const first = new PanePrRecords(path, () => 5)
    await first.add(target, [{ repo: 'acme/widgets', number: 7 }])
    await first.flushed()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 2, targets: { [target]: [{ repo: 'acme/widgets', number: 7, at: 5 }] } })
    expect(await new PanePrRecords(path).list(target)).toEqual([{ repo: 'acme/widgets', number: 7, at: 5 }])
  })

  it('starts empty from an unreadable file and drops invalid entries', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = await temporaryPath()
    await writeFile(join(broken, '..', '..', 'broken.json'), '{nope')
    expect(await new PanePrRecords(join(broken, '..', '..', 'broken.json')).list(target)).toEqual([])
    const mixed = join(broken, '..', '..', 'mixed.json')
    await writeFile(mixed, JSON.stringify({ version: 1, targets: {
      [target]: [{ repo: 'acme/widgets', number: 1, at: 1 }, { repo: 'bad', number: 2, at: 1 }],
      'not-a-target': [{ repo: 'acme/widgets', number: 3, at: 1 }],
    } }))
    expect(await new PanePrRecords(mixed).list(target)).toEqual([{ repo: 'acme/widgets', number: 1, at: 1 }])
  })

  it('records impacted PRs, keeping the strongest impact and the latest time', async () => {
    let now = 1_000
    const records = new PanePrRecords(undefined, () => now)
    expect(await records.touch(target, [{ repo: 'acme/widgets', number: 3 }], 'commented')).toBe(true)
    now = 2_000
    expect(await records.touch(target, [{ repo: 'acme/widgets', number: 3 }], 'pushed')).toBe(true)
    now = 3_000
    // Same PR, weaker impact: only the time moves, which needs no new read.
    expect(await records.touch(target, [{ repo: 'ACME/widgets', number: 3 }], 'reviewed')).toBe(false)
    expect(await records.list(target)).toEqual([{ repo: 'acme/widgets', number: 3, at: 1_000, impact: 'pushed', impactedAt: 3_000, created: false }])
    expect(recordRelation((await records.list(target))[0])).toBe('pushed')
    expect(await records.touch(target, [{ repo: 'bad', number: 3 }], 'pushed')).toBe(false)
    expect(await records.touch('not-a-target', [{ repo: 'acme/widgets', number: 3 }], 'pushed')).toBe(false)
  })

  it('upgrades an impacted PR the pane turns out to have created, and keeps the impact', async () => {
    let now = 1_000
    const records = new PanePrRecords(undefined, () => now)
    await records.touch(target, [{ repo: 'acme/widgets', number: 3 }], 'pushed')
    now = 5_000
    expect(await records.add(target, [{ repo: 'acme/widgets', number: 3, createdAt: 900 }])).toBe(true)
    const [record] = await records.list(target)
    expect(record).toEqual({ repo: 'acme/widgets', number: 3, at: 5_000, createdAt: 900, impact: 'pushed', impactedAt: 1_000 })
    expect(recordRelation(record)).toBe('created')
    // A created PR that is pushed to stays created.
    await records.touch(target, [{ repo: 'acme/widgets', number: 3 }], 'pushed')
    expect(recordRelation((await records.list(target))[0])).toBe('created')
  })

  it('disowns a created PR: keeps it as impacted if the pane touched it, else forgets it', async () => {
    const records = new PanePrRecords(undefined, () => 1_000)
    await records.add(target, [{ repo: 'acme/widgets', number: 1 }, { repo: 'acme/widgets', number: 2 }])
    await records.touch(target, [{ repo: 'acme/widgets', number: 2 }, { repo: 'acme/widgets', number: 9 }], 'commented')
    await records.disown(target, [{ repo: 'acme/widgets', number: 1 }, { repo: 'acme/widgets', number: 2 }, { repo: 'acme/widgets', number: 9 }])
    const listed = await records.list(target)
    expect(listed.map((record) => `${record.number}:${recordRelation(record)}`).sort()).toEqual(['2:commented', '9:commented'])
  })

  it('learns creation times and renamed repos without changing relations', async () => {
    const records = new PanePrRecords(undefined, () => 1_000)
    await records.touch(target, [{ repo: 'acme/old', number: 4 }], 'reviewed')
    const [record] = await records.list(target)
    await records.remove(target, [record])
    await records.learn(target, [{ ...record, repo: 'acme/new', createdAt: 500 }])
    expect(await records.list(target)).toEqual([{ ...record, repo: 'acme/new', createdAt: 500 }])
  })

  it('keeps 20 created and 20 impacted PRs per pane', async () => {
    let now = 0
    const records = new PanePrRecords(undefined, () => ++now)
    await records.add(target, Array.from({ length: 25 }, (_, index) => ({ repo: 'acme/widgets', number: index + 1 })))
    for (let number = 100; number < 125; number += 1) await records.touch(target, [{ repo: 'acme/widgets', number }], 'pushed')
    const listed = await records.list(target)
    expect(listed.filter((record) => record.created === false)).toHaveLength(20)
    expect(listed.filter((record) => record.created !== false)).toHaveLength(20)
    expect(listed.some((record) => record.number === 124)).toBe(true)
    expect(listed.some((record) => record.number === 104)).toBe(false)
  })

  it('reads a version 1 file as created PRs and keeps impacted ones across a restart', async () => {
    const path = await temporaryPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, targets: { [target]: [{ repo: 'acme/widgets', number: 1, at: 5, createdAt: 4 }] } }))
    const first = new PanePrRecords(path, () => 10)
    expect((await first.list(target)).map(recordRelation)).toEqual(['created'])
    await first.touch(target, [{ repo: 'acme/widgets', number: 2 }], 'commented')
    await first.flushed()
    const second = await new PanePrRecords(path).list(target)
    expect(second.map((record) => `${record.number}:${recordRelation(record)}`)).toEqual(['2:commented', '1:created'])
  })

  it('drops records whose relation fields do not make sense', async () => {
    const path = await temporaryPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 2, targets: { [target]: [
      { repo: 'acme/widgets', number: 1, at: 1, created: false },
      { repo: 'acme/widgets', number: 2, at: 1, impact: 'stared', impactedAt: 1 },
      { repo: 'acme/widgets', number: 3, at: 1, created: true },
      { repo: 'acme/widgets', number: 4, at: 1, created: false, impact: 'pushed', impactedAt: 'soon' },
      { repo: 'acme/widgets', number: 5, at: 1, created: false, impact: 'pushed', impactedAt: 2 },
    ] } }))
    expect((await new PanePrRecords(path).list(target)).map((record) => record.number)).toEqual([5])
  })
})
