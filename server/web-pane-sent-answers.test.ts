import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebPaneSentAnswer } from '../shared/protocol.js'
import { MAX_SENT_ANSWERS_PER_PAGE, SentAnswerStore } from './web-pane-sent-answers.js'

const dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'commando-sent-answers-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function answer(queueKey: string, value: string): Omit<WebPaneSentAnswer, 'sentAt'> {
  return {
    queueKey,
    selector: `#${queueKey}`,
    shape: { question: `Pick ${queueKey}?`, kind: 'text' },
    response: { question: `Pick ${queueKey}?`, answer: value },
  }
}

describe('SentAnswerStore', () => {
  it('shares records across query-string variants of the same page', () => {
    const store = new SentAnswerStore({ dir: makeDir(), now: () => 5 })
    store.record('http://127.0.0.1:4000/plan.html?v=1', [answer('plan', 'Pro')])
    expect(store.forPage('http://127.0.0.1:4000/plan.html?v=2#x')).toEqual([
      { ...answer('plan', 'Pro'), sentAt: 5 },
    ])
    expect(store.forPage('http://127.0.0.1:4000/other.html')).toEqual([])
  })

  it('keeps only the latest answer per question, newest first', () => {
    let now = 1
    const store = new SentAnswerStore({ dir: makeDir(), now: () => now })
    store.record('http://h/p', [answer('a', 'one'), answer('b', 'two')])
    now = 2
    store.record('http://h/p', [answer('a', 'three')])
    expect(store.forPage('http://h/p').map((record) => [record.queueKey, record.response.answer, record.sentAt]))
      .toEqual([['a', 'three', 2], ['b', 'two', 1]])
  })

  it('lets the later of two answers to one question in a batch win', () => {
    const store = new SentAnswerStore({ dir: makeDir() })
    store.record('http://h/p', [answer('a', 'first'), answer('a', 'second')])
    expect(store.forPage('http://h/p').map((record) => record.response.answer)).toEqual(['second'])
  })

  it('survives a restart', () => {
    const dir = makeDir()
    new SentAnswerStore({ dir, now: () => 9 }).record('http://h/p', [answer('a', 'kept')])
    expect(new SentAnswerStore({ dir }).forPage('http://h/p?v=3')).toEqual([{ ...answer('a', 'kept'), sentAt: 9 }])
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('treats an unreadable record as empty and recovers on the next send', () => {
    const dir = makeDir()
    const store = new SentAnswerStore({ dir, now: () => 1 })
    store.record('http://h/p', [answer('a', 'x')])
    const [file] = readdirSync(dir)
    writeFileSync(join(dir, file), '{not json')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fresh = new SentAnswerStore({ dir, now: () => 2 })
    expect(fresh.forPage('http://h/p')).toEqual([])
    fresh.record('http://h/p', [answer('b', 'y')])
    expect(new SentAnswerStore({ dir }).forPage('http://h/p').map((record) => record.queueKey)).toEqual(['b'])
  })

  it('drops malformed records on load', () => {
    const dir = makeDir()
    const store = new SentAnswerStore({ dir, now: () => 1 })
    store.record('http://h/p', [answer('a', 'x')])
    const [file] = readdirSync(dir)
    writeFileSync(join(dir, file), JSON.stringify({
      version: 1,
      page: 'http://h/p',
      answers: [{ ...answer('a', 'x'), sentAt: 1 }, { queueKey: 'bad', sentAt: 1 }],
    }))
    expect(new SentAnswerStore({ dir }).forPage('http://h/p').map((record) => record.queueKey)).toEqual(['a'])
  })

  it('bounds the records kept per page', () => {
    const store = new SentAnswerStore({ dir: makeDir() })
    store.record('http://h/p', Array.from({ length: MAX_SENT_ANSWERS_PER_PAGE + 5 }, (_, index) => answer(`q${index}`, 'x')))
    expect(store.forPage('http://h/p')).toHaveLength(MAX_SENT_ANSWERS_PER_PAGE)
  })
})
