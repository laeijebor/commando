import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitBlame, GitBlameCommit, GitDiffApiClient, GitFileContents, GitFileSide } from './gitApi'

export type FileBlame = {
  old?: GitBlame
  new?: GitBlame
  loading: boolean
  error: string
}

const MAX_CACHED_BLAMES = 40

/** Cheap content fingerprint: worktree blame changes with every edit while its rev stays 'worktree'. */
function contentSignature(contents: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < contents.length; index += 1) {
    hash ^= contents.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${contents.length}:${(hash >>> 0).toString(36)}`
}

function blameKey(paneId: string, side: GitFileSide): string {
  return JSON.stringify([paneId, side.path, side.rev, side.rev === 'worktree' ? contentSignature(side.contents) : ''])
}

/**
 * Blame for both sides of a file comparison, fetched while `enabled` and cached per file and
 * revision for the life of the view, so switching files or toggling blame doesn't refetch.
 */
export function useGitBlame(
  api: GitDiffApiClient,
  paneId: string,
  contents: GitFileContents | null,
  enabled: boolean,
): FileBlame {
  const [cache, setCache] = useState<ReadonlyMap<string, GitBlame>>(() => new Map())
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  const inFlight = useRef(new Set<string>())
  const apiRef = useRef(api)
  apiRef.current = api

  const requests = useMemo(() => {
    if (!enabled || !contents) return []
    return (['old', 'new'] as const).flatMap((which) => {
      const side = contents[which]
      return side ? [{ which, key: blameKey(paneId, side), path: side.path, rev: side.rev }] : []
    })
  }, [contents, enabled, paneId])

  // Turning blame back on retries sides that failed before.
  useEffect(() => {
    if (!enabled) setErrors((current) => (current.size ? new Map() : current))
  }, [enabled])

  useEffect(() => {
    for (const request of requests) {
      if (cache.has(request.key) || errors.has(request.key) || inFlight.current.has(request.key)) continue
      inFlight.current.add(request.key)
      apiRef.current
        .blame(paneId, request.path, request.rev)
        .then((blame) => {
          setCache((current) => {
            const next = new Map(current)
            next.set(request.key, blame)
            while (next.size > MAX_CACHED_BLAMES) next.delete(next.keys().next().value as string)
            return next
          })
        })
        .catch((cause: unknown) => {
          setErrors((current) => new Map(current).set(request.key, cause instanceof Error ? cause.message : 'Unable to load blame'))
        })
        .finally(() => { inFlight.current.delete(request.key) })
    }
  }, [cache, errors, paneId, requests])

  const result: FileBlame = { loading: false, error: '' }
  for (const request of requests) {
    const blame = cache.get(request.key)
    if (blame) result[request.which] = blame
    else if (errors.has(request.key)) result.error ||= errors.get(request.key)!
    else result.loading = true
  }
  return result
}

export function blameCommitAt(blame: GitBlame | undefined, lineNumber: number): GitBlameCommit | undefined {
  const sha = blame?.lines[lineNumber - 1]
  return sha ? blame.commits[sha] : undefined
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

export function relativeTime(unixSeconds: number, nowMs = Date.now()): string {
  const elapsed = Math.round(nowMs / 1000 - unixSeconds)
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= seconds) return format.format(-Math.round(elapsed / seconds), unit)
  }
  return 'just now'
}
