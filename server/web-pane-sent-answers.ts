import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { WebPaneSentAnswer } from '../shared/protocol.js'
import {
  isWebPaneSentAnswer,
  redlinePageKey,
  redlineQuestionIdentity,
} from '../shared/redline-response.js'

/** Safety bound per page; each question keeps only its latest answer anyway. */
export const MAX_SENT_ANSWERS_PER_PAGE = 1_000

export function defaultSentAnswersDir(): string {
  return resolve(homedir(), '.commando', 'sent-answers')
}

type StoreOptions = {
  dir?: string
  now?: () => number
}

type PageFile = { version: 1; page: string; answers: WebPaneSentAnswer[] }

/**
 * The latest answer the owner sent for each redline page question, one JSON
 * file per page (origin + path) under ~/.commando/sent-answers. It is what lets
 * a sent answer keep showing as answered after reloads, daemon restarts, and
 * reopening the page in a new tile — until the agent changes the question.
 * Records never expire: a re-sent answer replaces its predecessor.
 */
export class SentAnswerStore {
  private readonly dir: string
  private readonly now: () => number
  private readonly pages = new Map<string, WebPaneSentAnswer[]>()

  constructor(options: StoreOptions = {}) {
    this.dir = options.dir ?? defaultSentAnswersDir()
    this.now = options.now ?? Date.now
  }

  /** Sent answers for the page `pageUrl` belongs to, newest first. */
  forPage(pageUrl: string): WebPaneSentAnswer[] {
    return [...this.load(redlinePageKey(pageUrl))]
  }

  record(pageUrl: string, answers: ReadonlyArray<Omit<WebPaneSentAnswer, 'sentAt'>>): void {
    if (answers.length === 0) return
    const page = redlinePageKey(pageUrl)
    const sentAt = this.now()
    // Later answers in the batch win, then everything already on record.
    const seen = new Set<string>()
    const next = [...answers.map((answer) => ({ ...answer, sentAt })).reverse(), ...this.load(page)]
      .filter((answer) => {
        const identity = redlineQuestionIdentity(answer)
        if (seen.has(identity)) return false
        seen.add(identity)
        return true
      })
      .slice(0, MAX_SENT_ANSWERS_PER_PAGE)
    this.pages.set(page, next)
    mkdirSync(this.dir, { recursive: true })
    const path = this.pathFor(page)
    const tmp = `${path}.${process.pid}.tmp`
    const file: PageFile = { version: 1, page, answers: next }
    writeFileSync(tmp, JSON.stringify(file))
    renameSync(tmp, path)
  }

  private load(page: string): WebPaneSentAnswer[] {
    const cached = this.pages.get(page)
    if (cached) return cached
    let answers: WebPaneSentAnswer[] = []
    try {
      const file = JSON.parse(readFileSync(this.pathFor(page), 'utf8')) as Partial<PageFile>
      if (file.version === 1 && file.page === page && Array.isArray(file.answers)) {
        answers = file.answers.filter(isWebPaneSentAnswer)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[sent-answers] ignoring unreadable record for', page, error)
      }
    }
    this.pages.set(page, answers)
    return answers
  }

  private pathFor(page: string): string {
    return join(this.dir, `${createHash('sha256').update(page).digest('hex').slice(0, 32)}.json`)
  }
}
