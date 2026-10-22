import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanePrRecords } from './pane-pr-records.js'

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
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, targets: { [target]: [{ repo: 'acme/widgets', number: 7, at: 5 }] } })
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
})
