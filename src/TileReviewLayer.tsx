import { useEffect, useRef, useState, type RefObject } from 'react'
import { MAX_PENDING_NOTES, type WebPanePendingNote, type WebPanePendingSnapshot } from '../shared/protocol'
import {
  MAX_SELECTOR_RESOLVE_BYTES,
  MAX_SELECTOR_RESOLVE_ITEMS,
  type TileInspectGrade,
  type TileInspectRect,
  type TileInspectResult,
  type TileInspectSuccess,
  type TileSelectorAnchor,
  type TileSelectorResolveItem,
} from '../shared/tile-inspect'
import { loadPendingMirror, savePendingMirror } from './pendingMirror'
import type { PendingQueueApi } from './pendingQueueApi'
import { createInspectThrottle } from './tileReview'
import type { PendingSendTarget } from './webPanesApi'

const INSPECT_HINT_MS = 2_000
const REVIEW_CARD_WIDTH = 240
const REVIEW_CARD_HEIGHT = 132
const REVIEW_CARD_GAP = 8
const REVIEW_POPOVER_WIDTH = 280
const REVIEW_POPOVER_HEIGHT = 300
const ANCHOR_REFRESH_MS = 500

export type TileReviewSurface = {
  inspect: (
    x: number,
    y: number,
    grade: TileInspectGrade,
    receive: (result: TileInspectResult) => void,
  ) => void
  resolveSelectors: (
    items: readonly TileSelectorResolveItem[],
    receive: (anchors: readonly TileSelectorAnchor[]) => void,
    reject?: (error: Error) => void,
  ) => void
  subscribePending: (listener: (snapshot: WebPanePendingSnapshot) => void) => () => void
}

export type TileReviewLayerProps = {
  webPaneId: string
  reviewMode: boolean
  active: boolean
  containerRef: RefObject<HTMLElement | null>
  inputRef: RefObject<HTMLElement | null>
  pendingQueue: PendingQueueApi
  surface: TileReviewSurface
}

const EMPTY_SNAPSHOT: WebPanePendingSnapshot = {
  notes: [],
  knownUpTo: Number.POSITIVE_INFINITY,
  dropped: 0,
}

type PendingDraft = {
  answer: string
  note: string
  baseAnswer: string
  baseNote: string
  baseRevision: number
  dirty: boolean
  conflict: boolean
}

type DraftReconcile = {
  reset?: ReadonlySet<number>
  rebase?: ReadonlySet<number>
}

type PendingEditor =
  | { kind: 'choice'; options: string[]; multiple: boolean }
  | { kind: 'approve'; options: string[] }
  | { kind: 'rating'; max: number }
  | { kind: 'text' }

function responseData(note: WebPanePendingNote): Record<string, unknown> {
  const data = note.response?.data
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
}

function editorFor(note: WebPanePendingNote): PendingEditor {
  const data = responseData(note)
  if (Array.isArray(data.options) && data.options.every((option) => typeof option === 'string')) {
    return { kind: 'choice', options: data.options, multiple: data.multiple === true }
  }
  if (typeof data.verdict === 'string') {
    return { kind: 'approve', options: ['approve', 'reject', 'needs-changes'] }
  }
  if (typeof data.max === 'number' && Number.isInteger(data.max) && data.max >= 2) {
    return { kind: 'rating', max: Math.min(10, data.max) }
  }
  return { kind: 'text' }
}

function draftValues(note: WebPanePendingNote): { answer: string; note: string } {
  if (!note.response) return { answer: note.comment, note: '' }
  const data = responseData(note)
  const editor = editorFor(note)
  let answer = note.response.answer
  if (editor.kind === 'choice') {
    const choice = data.choice
    if (Array.isArray(choice)) answer = choice.map(String).join(', ')
    else if (typeof choice === 'string') answer = choice
  } else if (editor.kind === 'approve' && typeof data.verdict === 'string') {
    answer = data.verdict
  } else if (editor.kind === 'rating') {
    const rating = typeof data.rating === 'number' ? data.rating : Number.parseInt(answer, 10)
    if (Number.isFinite(rating)) answer = `${rating}/${editor.max}`
  }
  const legacyNote = typeof data.comment === 'string' ? data.comment : ''
  return { answer, note: note.response.note ?? legacyNote }
}

function draftFor(note: WebPanePendingNote): PendingDraft {
  const values = draftValues(note)
  return {
    ...values,
    baseAnswer: values.answer,
    baseNote: values.note,
    baseRevision: note.revision ?? 1,
    dirty: false,
    conflict: false,
  }
}

function itemLabel(note: WebPanePendingNote): string {
  return note.response ? note.response.question : note.selector
}

function itemType(note: WebPanePendingNote): string {
  return note.response ? 'Response' : 'Annotation'
}

function resolvableSelector(selector: string): boolean {
  return selector.length > 0 && !selector.startsWith('redline:')
}

function PendingEditorFields({
  note,
  draft,
  editor,
  busy,
  onChange,
}: {
  note: WebPanePendingNote
  draft: PendingDraft
  editor: PendingEditor
  busy: boolean
  onChange: (change: Partial<Pick<PendingDraft, 'answer' | 'note'>>) => void
}) {
  return (
    <fieldset className="tile-review-editor" disabled={busy}>
      <legend>{note.response ? 'Answer' : 'Comment'}</legend>
      {editor.kind === 'choice' && editor.multiple ? (
        <div className="tile-review-checks">
          {editor.options.map((option) => {
            const values = draft.answer.split(', ').filter(Boolean)
            return (
              <label key={option}>
                <input
                  type="checkbox"
                  checked={values.includes(option)}
                  onChange={(event) => {
                    const next = new Set(values)
                    if (event.target.checked) next.add(option)
                    else next.delete(option)
                    onChange({
                      answer: editor.options.filter((value) => next.has(value)).join(', '),
                    })
                  }}
                />
                <span>{option}</span>
              </label>
            )
          })}
        </div>
      ) : editor.kind === 'choice' ? (
        <select
          aria-label="Answer"
          value={draft.answer}
          onChange={(event) => onChange({ answer: event.target.value })}
        >
          {editor.options.map((option) => <option key={option}>{option}</option>)}
        </select>
      ) : editor.kind === 'approve' ? (
        <select
          aria-label="Verdict"
          value={draft.answer}
          onChange={(event) => onChange({ answer: event.target.value })}
        >
          {editor.options.map((option) => <option key={option}>{option}</option>)}
        </select>
      ) : editor.kind === 'rating' ? (
        <div className="tile-review-rating" role="radiogroup" aria-label="Rating">
          {Array.from({ length: editor.max }, (_, index) => index + 1).map((rating) => (
            <label key={rating}>
              <input
                type="radio"
                name={`pending-rating-${note.id}`}
                value={rating}
                checked={draft.answer === `${rating}/${editor.max}`}
                onChange={() => onChange({ answer: `${rating}/${editor.max}` })}
              />
              <span>{rating}</span>
            </label>
          ))}
        </div>
      ) : (
        <textarea
          aria-label={note.response ? 'Answer' : 'Comment'}
          value={draft.answer}
          onChange={(event) => onChange({ answer: event.target.value })}
        />
      )}
      {note.response && (
        <label className="tile-review-note-field">
          <span>Optional note</span>
          <textarea
            aria-label="Optional note"
            value={draft.note}
            onChange={(event) => onChange({ note: event.target.value })}
          />
        </label>
      )}
    </fieldset>
  )
}

function cardPosition(
  rect: TileInspectRect,
  container: DOMRect | null,
  cardWidth = REVIEW_CARD_WIDTH,
  cardHeight = REVIEW_CARD_HEIGHT,
): { x: number; y: number } {
  const width = container?.width ?? cardWidth
  const height = container?.height ?? cardHeight
  const below = rect.y + rect.height + REVIEW_CARD_GAP
  const y = below + cardHeight <= height
    ? below
    : Math.max(REVIEW_CARD_GAP, rect.y - REVIEW_CARD_GAP - cardHeight)
  return {
    x: Math.max(
      REVIEW_CARD_GAP,
      Math.min(rect.x, Math.max(REVIEW_CARD_GAP, width - cardWidth - REVIEW_CARD_GAP)),
    ),
    y: Math.max(REVIEW_CARD_GAP, Math.min(y, Math.max(REVIEW_CARD_GAP, height - REVIEW_CARD_GAP))),
  }
}

function selectorBatch(notes: readonly WebPanePendingNote[]): TileSelectorResolveItem[] {
  const items: TileSelectorResolveItem[] = []
  for (const note of notes) {
    if (!resolvableSelector(note.selector) || items.length >= MAX_SELECTOR_RESOLVE_ITEMS) continue
    const item = { noteId: note.id, selector: note.selector }
    const candidate = [...items, item]
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > MAX_SELECTOR_RESOLVE_BYTES) break
    items.push(item)
  }
  return items
}

export function TileReviewLayer({
  webPaneId,
  reviewMode,
  active,
  containerRef,
  inputRef,
  pendingQueue,
  surface,
}: TileReviewLayerProps) {
  const [highlight, setHighlight] = useState<TileInspectRect | null>(null)
  const [card, setCard] = useState<{ inspect: TileInspectSuccess; x: number; y: number } | null>(null)
  const [comment, setComment] = useState('')
  const [queued, setQueued] = useState<WebPanePendingNote[]>([])
  const [dropped, setDropped] = useState(0)
  const [hydrated, setHydrated] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [popoverId, setPopoverId] = useState<number | null>(null)
  const [queuedAnchors, setQueuedAnchors] = useState<Record<number, TileInspectRect | null>>({})
  const [drafts, setDrafts] = useState<Record<number, PendingDraft>>({})
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set())
  const busyIdsRef = useRef<ReadonlySet<number>>(new Set())
  const [sendingAll, setSendingAll] = useState(false)
  const sendingAllRef = useRef(false)
  const [queueError, setQueueError] = useState('')
  const [preview, setPreview] = useState<{ id: string; name: string } | null>(null)
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null)
  const pendingQueueRef = useRef(pendingQueue)
  pendingQueueRef.current = pendingQueue
  const surfaceRef = useRef(surface)
  surfaceRef.current = surface
  const queuedRef = useRef(queued)
  queuedRef.current = queued
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const latestSnapshotRevisionRef = useRef<number | undefined>(undefined)
  const attachmentMutationIdsRef = useRef(new Set<number>())
  const pushedRef = useRef(false)
  const hoverGeneration = useRef(0)
  const clickGeneration = useRef(0)
  const anchorGeneration = useRef(0)

  const applySnapshot = (snapshot: WebPanePendingSnapshot, reconcile: DraftReconcile = {}): boolean => {
    const latestRevision = latestSnapshotRevisionRef.current
    if (
      snapshot.revision !== undefined &&
      latestRevision !== undefined &&
      snapshot.revision < latestRevision
    ) return false
    if (snapshot.revision !== undefined) latestSnapshotRevisionRef.current = snapshot.revision

    const currentDrafts = draftsRef.current
    const nextDrafts: Record<number, PendingDraft> = {}
    for (const note of snapshot.notes) {
      const current = currentDrafts[note.id]
      if (!current || reconcile.reset?.has(note.id)) {
        nextDrafts[note.id] = draftFor(note)
        continue
      }
      const serverDraft = draftFor(note)
      if (reconcile.rebase?.has(note.id)) {
        nextDrafts[note.id] = current.dirty
          ? {
              ...current,
              baseAnswer: serverDraft.baseAnswer,
              baseNote: serverDraft.baseNote,
              baseRevision: serverDraft.baseRevision,
              dirty: current.answer !== serverDraft.baseAnswer || current.note !== serverDraft.baseNote,
              conflict: current.conflict,
            }
          : serverDraft
        continue
      }
      if (current.dirty) {
        nextDrafts[note.id] = {
          ...current,
          conflict: current.conflict || (
            note.revision !== undefined && note.revision !== current.baseRevision
          ),
        }
      } else {
        nextDrafts[note.id] = serverDraft
      }
    }
    draftsRef.current = nextDrafts
    queuedRef.current = snapshot.notes
    setDrafts(nextDrafts)
    setQueued(snapshot.notes)
    setDropped(snapshot.dropped)
    if (snapshot.notes.length === 0) setDrawerOpen(false)
    const noteIds = new Set(snapshot.notes.map((note) => note.id))
    setQueuedAnchors((current) => Object.fromEntries(
      Object.entries(current).filter(([noteId]) => noteIds.has(Number(noteId))),
    ))
    setPopoverId((current) => current !== null && noteIds.has(current) ? current : null)
    const attachmentIds = new Set(snapshot.notes.flatMap((note) => (
      note.attachments ?? []
    ).map((attachment) => attachment.id)))
    setPreview((current) => current && attachmentIds.has(current.id) ? current : null)
    setSelectedId((current) => (
      current !== null && snapshot.notes.some((note) => note.id === current)
        ? current
        : snapshot.notes[0]?.id ?? null
    ))
    return true
  }
  const applySnapshotRef = useRef(applySnapshot)
  applySnapshotRef.current = applySnapshot

  useEffect(() => {
    let cancelled = false
    pushedRef.current = false
    latestSnapshotRevisionRef.current = undefined
    setHydrated(false)
    const hydrate = async () => {
      let snapshot: WebPanePendingSnapshot
      try {
        snapshot = await pendingQueueRef.current.list()
        const unknown = loadPendingMirror(webPaneId)
          .filter((note) => note.id > snapshot.knownUpTo)
        for (const note of unknown) {
          const { id: _id, ...draft } = note
          snapshot = await pendingQueueRef.current.add(draft)
        }
      } catch {
        snapshot = EMPTY_SNAPSHOT
      }
      if (cancelled || pushedRef.current) return
      applySnapshotRef.current(snapshot)
      setHydrated(true)
    }
    void hydrate()
    return () => {
      cancelled = true
    }
  }, [webPaneId])

  useEffect(() => surface.subscribePending((snapshot) => {
    pushedRef.current = true
    const attachmentMutations = attachmentMutationIdsRef.current
    applySnapshotRef.current(
      snapshot,
      attachmentMutations.size > 0 ? { rebase: new Set(attachmentMutations) } : undefined,
    )
    setHydrated(true)
  }), [surface])

  useEffect(() => {
    if (!hydrated) return
    savePendingMirror(webPaneId, queued)
  }, [hydrated, queued, webPaneId])

  const refreshAnchors = () => {
    const items = selectorBatch(queuedRef.current)
    if (items.length === 0) {
      anchorGeneration.current += 1
      setQueuedAnchors({})
      return
    }
    const generation = ++anchorGeneration.current
    surfaceRef.current.resolveSelectors(items, (anchors) => {
      if (generation !== anchorGeneration.current) return
      const resolved: Record<number, TileInspectRect | null> = Object.fromEntries(
        items.map((item) => [item.noteId, null]),
      )
      for (const anchor of anchors) {
        if (Object.hasOwn(resolved, anchor.noteId)) resolved[anchor.noteId] = anchor.rect
      }
      setQueuedAnchors(resolved)
      setPopoverId((current) => current !== null && resolved[current] === null ? null : current)
    })
  }

  useEffect(() => {
    if (!reviewMode || !active || queued.length === 0) return
    refreshAnchors()
    const timer = window.setInterval(refreshAnchors, ANCHOR_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [active, queued, reviewMode, surface])

  const hoverThrottle = useRef<ReturnType<typeof createInspectThrottle> | null>(null)
  useEffect(() => {
    if (!reviewMode) {
      setHighlight(null)
      setCard(null)
      setHint(null)
      setPopoverId(null)
      return
    }
    const throttle = createInspectThrottle((x, y) => {
      const generation = ++hoverGeneration.current
      surfaceRef.current.inspect(x, y, 'hover', (result) => {
        if (generation !== hoverGeneration.current) return
        setHighlight(result.ok ? result.rect : null)
      })
    })
    hoverThrottle.current = throttle
    return () => {
      hoverGeneration.current += 1
      throttle.dispose()
      hoverThrottle.current = null
    }
  }, [reviewMode, surface])

  useEffect(() => {
    const input = inputRef.current
    if (!reviewMode || !active || !input) return
    const pointFor = (event: PointerEvent) => {
      const rect = input.getBoundingClientRect()
      return {
        x: Math.max(0, Math.round(event.clientX - rect.left)),
        y: Math.max(0, Math.round(event.clientY - rect.top)),
      }
    }
    const inspectClick = (event: PointerEvent) => {
      if (event.button !== 0) return
      const point = pointFor(event)
      const generation = ++clickGeneration.current
      surfaceRef.current.inspect(point.x, point.y, 'click', (result) => {
        if (generation !== clickGeneration.current) return
        if (!result.ok) {
          setCard(null)
          setHint(point)
          return
        }
        setHint(null)
        setComment('')
        setCard({
          inspect: result,
          ...cardPosition(result.rect, containerRef.current?.getBoundingClientRect() ?? null),
        })
      })
    }
    const inspectHover = (event: PointerEvent) => {
      const point = pointFor(event)
      hoverThrottle.current?.schedule(point.x, point.y)
    }
    input.addEventListener('pointerdown', inspectClick)
    input.addEventListener('pointermove', inspectHover)
    return () => {
      input.removeEventListener('pointerdown', inspectClick)
      input.removeEventListener('pointermove', inspectHover)
    }
  }, [active, containerRef, inputRef, reviewMode, surface])

  useEffect(() => {
    if (!hint) return
    const timer = window.setTimeout(() => setHint(null), INSPECT_HINT_MS)
    return () => window.clearTimeout(timer)
  }, [hint])

  useEffect(() => {
    if (!preview) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [preview])

  useEffect(() => {
    if (popoverId === null) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPopoverId(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [popoverId])

  const mutateQueue = async (mutate: () => Promise<WebPanePendingSnapshot>, failure: string) => {
    try {
      applySnapshot(await mutate())
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : failure)
    }
  }

  const changeDraft = (noteId: number, change: Partial<Pick<PendingDraft, 'answer' | 'note'>>) => {
    const serverNote = queuedRef.current.find((note) => note.id === noteId)
    if (!serverNote) return
    const current = draftsRef.current[noteId] ?? draftFor(serverNote)
    const nextDraft = { ...current, ...change }
    nextDraft.dirty = nextDraft.answer !== nextDraft.baseAnswer || nextDraft.note !== nextDraft.baseNote
    if (!nextDraft.dirty) nextDraft.conflict = false
    const nextDrafts = { ...draftsRef.current, [noteId]: nextDraft }
    draftsRef.current = nextDrafts
    setDrafts(nextDrafts)
    setQueueError('')
  }

  const resetDraft = (noteId: number) => {
    const serverNote = queuedRef.current.find((note) => note.id === noteId)
    if (!serverNote) return
    const nextDrafts = { ...draftsRef.current, [noteId]: draftFor(serverNote) }
    draftsRef.current = nextDrafts
    setDrafts(nextDrafts)
    setQueueError('')
  }

  const markBusy = (noteId: number, busy: boolean) => {
    const next = new Set(busyIdsRef.current)
    if (busy) next.add(noteId)
    else next.delete(noteId)
    busyIdsRef.current = next
    setBusyIds(next)
  }

  const saveDraft = async (noteId: number): Promise<boolean> => {
    const draft = draftsRef.current[noteId]
    const serverNote = queuedRef.current.find((note) => note.id === noteId)
    if (!draft || !serverNote || !draft.dirty) return Boolean(serverNote)
    if (draft.conflict) {
      setQueueError('This draft changed on the server. Reload it before saving or sending.')
      return false
    }
    try {
      const snapshot = await pendingQueueRef.current.update(
        noteId,
        draft.baseRevision,
        serverNote.response
          ? { answer: draft.answer, note: draft.note }
          : { answer: draft.answer },
      )
      const accepted = applySnapshot(snapshot, { reset: new Set([noteId]) })
      if (!accepted) {
        setQueueError('A newer queue snapshot arrived while saving. Reload the draft before sending.')
        return false
      }
      setQueueError('')
      return true
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not save changes')
      return false
    }
  }

  const saveOne = async (noteId: number) => {
    if (sendingAllRef.current) return
    markBusy(noteId, true)
    try {
      await saveDraft(noteId)
    } finally {
      markBusy(noteId, false)
    }
  }

  const sendOne = async (noteId: number) => {
    if (sendingAllRef.current) return
    markBusy(noteId, true)
    try {
      if (!(await saveDraft(noteId))) return
      const latest = queuedRef.current.find((note) => note.id === noteId)
      if (!latest) {
        setQueueError('This item changed before it could be sent. Reload the queue and try again.')
        return
      }
      applySnapshot(await pendingQueueRef.current.send([{
        id: latest.id,
        revision: latest.revision ?? 1,
      }]))
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not send this item')
    } finally {
      markBusy(noteId, false)
    }
  }

  const sendAll = async () => {
    if (sendingAllRef.current || busyIdsRef.current.size > 0) return
    const visible = queuedRef.current.map((note) => ({ id: note.id, revision: note.revision ?? 1 }))
    const ids = visible.map((note) => note.id)
    if (ids.length === 0) return
    const expectedRevisions = new Map(visible.map((note) => [note.id, note.revision]))
    sendingAllRef.current = true
    setSendingAll(true)
    setQueueError('')
    try {
      for (const noteId of ids) {
        const draft = draftsRef.current[noteId]
        if (draft?.conflict) {
          setQueueError('Resolve or reload conflicted drafts before sending the queue.')
          return
        }
        if (draft?.dirty) {
          if (!(await saveDraft(noteId))) return
          const saved = queuedRef.current.find((note) => note.id === noteId)
          if (!saved) {
            setQueueError('The queue changed while saving. Nothing was sent.')
            return
          }
          expectedRevisions.set(noteId, saved.revision ?? 1)
        }
      }
      const targets: PendingSendTarget[] = []
      for (const noteId of ids) {
        const note = queuedRef.current.find((candidate) => candidate.id === noteId)
        const draft = draftsRef.current[noteId]
        if (
          !note ||
          draft?.conflict ||
          (note.revision ?? 1) !== expectedRevisions.get(noteId)
        ) {
          setQueueError('The queue changed while saving. Nothing was sent.')
          return
        }
        targets.push({ id: note.id, revision: note.revision ?? 1 })
      }
      applySnapshot(await pendingQueueRef.current.send(targets))
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not send the queue')
    } finally {
      sendingAllRef.current = false
      setSendingAll(false)
    }
  }

  const removeOne = async (noteId: number) => {
    if (sendingAllRef.current) return
    markBusy(noteId, true)
    try {
      applySnapshot(await pendingQueueRef.current.remove(noteId))
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not remove the item')
    } finally {
      markBusy(noteId, false)
    }
  }

  const uploadAttachment = async (noteId: number, file: File) => {
    if (sendingAllRef.current) return
    const acceptedTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    if (!acceptedTypes.has(file.type)) {
      setQueueError('Choose a PNG, JPEG, GIF, or WebP image.')
      return
    }
    const note = queuedRef.current.find((candidate) => candidate.id === noteId)
    if (!note) return
    if (draftsRef.current[noteId]?.conflict) {
      setQueueError('Reload the conflicted draft before changing its attachments.')
      return
    }
    markBusy(noteId, true)
    attachmentMutationIdsRef.current.add(noteId)
    try {
      applySnapshot(
        await pendingQueueRef.current.upload(noteId, note.revision ?? 1, file),
        { rebase: new Set([noteId]) },
      )
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not upload the attachment')
    } finally {
      attachmentMutationIdsRef.current.delete(noteId)
      markBusy(noteId, false)
    }
  }

  const removeAttachment = async (noteId: number, attachmentId: string) => {
    if (sendingAllRef.current) return
    const note = queuedRef.current.find((candidate) => candidate.id === noteId)
    if (!note) return
    if (draftsRef.current[noteId]?.conflict) {
      setQueueError('Reload the conflicted draft before changing its attachments.')
      return
    }
    markBusy(noteId, true)
    attachmentMutationIdsRef.current.add(noteId)
    try {
      applySnapshot(
        await pendingQueueRef.current.removeAttachment(noteId, note.revision ?? 1, attachmentId),
        { rebase: new Set([noteId]) },
      )
      if (preview?.id === attachmentId) setPreview(null)
      setQueueError('')
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Could not remove the attachment')
    } finally {
      attachmentMutationIdsRef.current.delete(noteId)
      markBusy(noteId, false)
    }
  }

  const selected = selectedId === null ? undefined : queued.find((note) => note.id === selectedId)
  const selectedDraft = selected ? drafts[selected.id] ?? draftFor(selected) : undefined
  const selectedEditor = selected ? editorFor(selected) : undefined
  const selectedBusy = selected ? sendingAll || busyIds.has(selected.id) : false
  const popoverNote = popoverId === null ? undefined : queued.find((note) => note.id === popoverId)
  const popoverDraft = popoverNote ? drafts[popoverNote.id] ?? draftFor(popoverNote) : undefined
  const popoverEditor = popoverNote ? editorFor(popoverNote) : undefined
  const popoverBusy = popoverNote ? sendingAll || busyIds.has(popoverNote.id) : false
  const popoverRect = popoverNote
    ? queuedAnchors[popoverNote.id] === undefined ? popoverNote.rect : queuedAnchors[popoverNote.id]
    : undefined
  const popoverPosition = popoverRect
    ? cardPosition(
        popoverRect,
        containerRef.current?.getBoundingClientRect() ?? null,
        REVIEW_POPOVER_WIDTH,
        REVIEW_POPOVER_HEIGHT,
      )
    : undefined

  return (
    <>
      {active && queued.map((note) => {
        if (!resolvableSelector(note.selector)) return null
        const rect = queuedAnchors[note.id] === undefined ? note.rect : queuedAnchors[note.id]
        if (!rect || rect.width <= 0 || rect.height <= 0) return null
        const label = `Edit queued ${itemType(note).toLowerCase()}: ${itemLabel(note)}`
        return (
          <button
            key={note.id}
            type="button"
            className={`tile-review-pending-highlight is-${note.response ? 'response' : 'annotation'}${popoverId === note.id ? ' is-selected' : ''}`}
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
            aria-label={label}
            title={label}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              setDrawerOpen(false)
              setSelectedId(note.id)
              setPopoverId(note.id)
              setQueueError('')
            }}
          />
        )
      })}
      {active && highlight && (
        <div
          className="tile-review-highlight"
          style={{
            left: highlight.x,
            top: highlight.y,
            width: highlight.width,
            height: highlight.height,
          }}
        />
      )}
      {active && hint && (
        <div className="tile-review-hint" style={{ left: hint.x, top: hint.y }} role="status">
          couldn't resolve an element here
        </div>
      )}
      {active && card && (
        <div className="tile-review-card" style={{ left: card.x, top: card.y }}>
          <span className="tile-review-card-target" title={card.inspect.selector}>
            {card.inspect.tag}
          </span>
          <textarea
            autoFocus
            value={comment}
            placeholder="What's wrong with this?"
            aria-label={`Note about ${card.inspect.selector}`}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="web-pane-confirm-actions">
            <button
              type="button"
              className="web-pane-action"
              disabled={comment.trim().length === 0}
              onClick={() => {
                const { selector, tag, text, rect } = card.inspect
                void mutateQueue(
                  () => pendingQueueRef.current.add({
                    selector,
                    tag,
                    ...(text !== undefined ? { text } : {}),
                    rect,
                    comment: comment.trim(),
                  }),
                  'Could not queue the note',
                )
                setCard(null)
                setComment('')
              }}
            >
              Queue note
            </button>
            <button
              type="button"
              className="web-pane-action is-ghost"
              onClick={() => {
                setCard(null)
                setComment('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {active && popoverNote && popoverDraft && popoverEditor && popoverPosition && (
        <section
          className="tile-review-pending-popover"
          role="dialog"
          aria-label={`Edit queued ${itemType(popoverNote).toLowerCase()}`}
          style={{ left: popoverPosition.x, top: popoverPosition.y }}
        >
          <header>
            <div>
              <span className={`tile-review-type is-${popoverNote.response ? 'response' : 'annotation'}`}>
                {itemType(popoverNote)}
              </span>
              <strong>{itemLabel(popoverNote)}</strong>
            </div>
            <button type="button" aria-label="Close queued item editor" onClick={() => setPopoverId(null)}>×</button>
          </header>
          {popoverDraft.conflict && (
            <div className="tile-review-conflict" role="alert">
              <span>This item changed after you started editing.</span>
              <button type="button" onClick={() => resetDraft(popoverNote.id)}>Reload draft</button>
            </div>
          )}
          <PendingEditorFields
            note={popoverNote}
            draft={popoverDraft}
            editor={popoverEditor}
            busy={popoverBusy}
            onChange={(change) => changeDraft(popoverNote.id, change)}
          />
          {(popoverNote.attachments?.length ?? 0) > 0 && (
            <span className="tile-review-popover-attachments">
              {popoverNote.attachments?.length} image{popoverNote.attachments?.length === 1 ? '' : 's'} in full queue
            </span>
          )}
          {queueError && <div className="tile-review-popover-error" role="alert">{queueError}</div>}
          <footer>
            <button
              type="button"
              className="web-pane-action is-ghost"
              onClick={() => {
                setPopoverId(null)
                setDrawerOpen(true)
              }}
            >
              Open full queue
            </button>
            <span />
            <button
              type="button"
              className="web-pane-action is-ghost"
              disabled={!popoverDraft.dirty || popoverDraft.conflict || popoverBusy || !popoverDraft.answer}
              onClick={() => void saveOne(popoverNote.id)}
            >
              {popoverBusy ? 'Working…' : 'Save'}
            </button>
            <button
              type="button"
              className="web-pane-action"
              disabled={popoverDraft.conflict || popoverBusy || !popoverDraft.answer}
              onClick={() => void sendOne(popoverNote.id)}
            >
              {popoverBusy ? 'Working…' : 'Send this'}
            </button>
          </footer>
        </section>
      )}
      {(queued.length > 0 || dropped > 0) && (
        <>
          {!drawerOpen ? (
            <div className="tile-review-strip" data-testid="pending-queue-strip">
              {dropped > 0 && (
                <span className="tile-review-dropped" role="alert">
                  {`${dropped} older answer${dropped === 1 ? '' : 's'} dropped — the queue is full at ${MAX_PENDING_NOTES}. Send to make room.`}
                  <button
                    type="button"
                    className="tile-review-pill-remove"
                    aria-label="Dismiss the dropped-answer warning"
                    onClick={() => {
                      void mutateQueue(
                        () => pendingQueueRef.current.dismissDropped(),
                        'Could not dismiss the warning',
                      )
                    }}
                  >
                    ×
                  </button>
                </span>
              )}
              {queued.length > 0 && (
                <button
                  type="button"
                  className="tile-review-queue-toggle"
                  aria-expanded="false"
                  onClick={() => {
                    setPopoverId(null)
                    setDrawerOpen(true)
                  }}
                >
                  Review queue · {queued.length}
                </button>
              )}
              <div className="tile-review-strip-items" aria-hidden="true">
                {queued.slice(0, 3).map((note) => (
                  <span key={note.id} className={`tile-review-chip is-${note.response ? 'response' : 'annotation'}`}>
                    {note.response ? note.response.answer : note.comment}
                  </span>
                ))}
                {queued.length > 3 && <span className="tile-review-chip">+{queued.length - 3}</span>}
              </div>
              {queued.length > 0 && (
                <button
                  type="button"
                  className="tile-review-send-all"
                  disabled={sendingAll || busyIds.size > 0}
                  onClick={() => void sendAll()}
                >
                  {sendingAll ? 'Saving…' : 'Send all'}
                </button>
              )}
              {queueError && <span className="tile-review-error" role="alert">{queueError}</span>}
            </div>
          ) : (
            <section
              className="tile-review-drawer"
              role="dialog"
              aria-label="Pending review queue"
              data-testid="pending-queue-drawer"
            >
              <header className="tile-review-drawer-head">
                <div>
                  <span className="tile-review-eyebrow">Pending answers</span>
                  <strong>Review queue · {queued.length}</strong>
                </div>
                <div className="tile-review-drawer-actions">
                  <button
                    type="button"
                    className="tile-review-send-all"
                    disabled={sendingAll || busyIds.size > 0 || queued.length === 0}
                    onClick={() => void sendAll()}
                  >
                    {sendingAll ? 'Saving and sending…' : 'Send all'}
                  </button>
                  <button
                    type="button"
                    className="tile-review-collapse"
                    aria-label="Collapse review queue"
                    onClick={() => setDrawerOpen(false)}
                  >
                    ↓
                  </button>
                </div>
              </header>
              {dropped > 0 && (
                <div className="tile-review-drawer-warning" role="alert">
                  <span>{`${dropped} older answer${dropped === 1 ? '' : 's'} dropped because the queue reached ${MAX_PENDING_NOTES}.`}</span>
                  <button
                    type="button"
                    onClick={() => void mutateQueue(
                      () => pendingQueueRef.current.dismissDropped(),
                      'Could not dismiss the warning',
                    )}
                  >
                    Dismiss
                  </button>
                </div>
              )}
              <div className="tile-review-drawer-body">
                <nav className="tile-review-drawer-list" aria-label="Queued review items">
                  {queued.map((note) => {
                    const draft = drafts[note.id] ?? draftFor(note)
                    return (
                      <button
                        key={note.id}
                        type="button"
                        className={`tile-review-list-item${note.id === selectedId ? ' is-selected' : ''}`}
                        aria-current={note.id === selectedId ? 'true' : undefined}
                        onClick={() => setSelectedId(note.id)}
                      >
                        <span className="tile-review-list-meta">
                          <span className={`tile-review-type is-${note.response ? 'response' : 'annotation'}`}>
                            {itemType(note)}
                          </span>
                          {(note.attachments?.length ?? 0) > 0 && (
                            <span>{note.attachments?.length} image{note.attachments?.length === 1 ? '' : 's'}</span>
                          )}
                          {draft.dirty && <span className="tile-review-dirty">Edited</span>}
                        </span>
                        <strong>{itemLabel(note)}</strong>
                        <span className="tile-review-list-preview">{draft.answer}</span>
                      </button>
                    )
                  })}
                </nav>
                <div className="tile-review-drawer-detail">
                  {selected && selectedDraft && selectedEditor ? (
                    <>
                      <div className="tile-review-detail-heading">
                        <span className={`tile-review-type is-${selected.response ? 'response' : 'annotation'}`}>
                          {itemType(selected)}
                        </span>
                        <h3>{selected.response?.question ?? selected.selector}</h3>
                        {!selected.response && <code>{selected.tag}</code>}
                      </div>
                      {selectedDraft.conflict && (
                        <div className="tile-review-conflict" role="alert">
                          <span>This item changed after you started editing. Reload the server version before continuing.</span>
                          <button type="button" onClick={() => resetDraft(selected.id)}>Reload draft</button>
                        </div>
                      )}
                      <PendingEditorFields
                        note={selected}
                        draft={selectedDraft}
                        editor={selectedEditor}
                        busy={selectedBusy}
                        onChange={(change) => changeDraft(selected.id, change)}
                      />
                      <div className="tile-review-attachments">
                        <div className="tile-review-section-head">
                          <strong>Attachments</strong>
                          <label className={`tile-review-add-image${selectedBusy || selectedDraft.conflict ? ' is-disabled' : ''}`}>
                            <span>Add image</span>
                            <input
                              type="file"
                              accept="image/png,image/jpeg,image/gif,image/webp"
                              disabled={selectedBusy || selectedDraft.conflict}
                              aria-label="Add image attachment"
                              onChange={(event) => {
                                const file = event.target.files?.[0]
                                event.currentTarget.value = ''
                                if (file) void uploadAttachment(selected.id, file)
                              }}
                            />
                          </label>
                        </div>
                        {(selected.attachments?.length ?? 0) > 0 ? (
                          <div className="tile-review-attachment-grid">
                            {selected.attachments?.map((attachment) => (
                              <div key={attachment.id} className="tile-review-attachment">
                                <button
                                  type="button"
                                  className="tile-review-attachment-preview"
                                  onClick={() => setPreview({ id: attachment.id, name: attachment.name })}
                                  aria-label={`Preview ${attachment.name}`}
                                >
                                  <img src={pendingQueue.attachmentUrl(attachment.id)} alt="" />
                                  <span>{attachment.name}</span>
                                </button>
                                <button
                                  type="button"
                                  className="tile-review-attachment-remove"
                                  disabled={selectedBusy || selectedDraft.conflict}
                                  aria-label={`Remove ${attachment.name}`}
                                  onClick={() => void removeAttachment(selected.id, attachment.id)}
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : <span className="tile-review-empty-attachments">No images attached</span>}
                      </div>
                      <footer className="tile-review-detail-actions">
                        <button
                          type="button"
                          className="tile-review-remove-item"
                          disabled={selectedBusy}
                          onClick={() => void removeOne(selected.id)}
                        >
                          Remove from queue
                        </button>
                        <span className="tile-review-detail-spacer" />
                        <button
                          type="button"
                          className="web-pane-action is-ghost"
                          disabled={!selectedDraft.dirty || selectedDraft.conflict || selectedBusy || !selectedDraft.answer}
                          onClick={() => void saveOne(selected.id)}
                        >
                          {selectedBusy ? 'Working…' : 'Save changes'}
                        </button>
                        <button
                          type="button"
                          className="web-pane-action"
                          disabled={selectedDraft.conflict || selectedBusy || !selectedDraft.answer}
                          onClick={() => void sendOne(selected.id)}
                        >
                          {selectedBusy ? 'Working…' : 'Send this'}
                        </button>
                      </footer>
                    </>
                  ) : (
                    <div className="tile-review-empty">Select an item to review.</div>
                  )}
                </div>
              </div>
              {queueError && <div className="tile-review-drawer-error" role="alert">{queueError}</div>}
            </section>
          )}
        </>
      )}
      {preview && (
        <div className="tile-review-preview-backdrop" onMouseDown={() => setPreview(null)}>
          <div
            className="tile-review-preview"
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${preview.name}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <strong>{preview.name}</strong>
              <button type="button" aria-label="Close attachment preview" autoFocus onClick={() => setPreview(null)}>×</button>
            </header>
            <img src={pendingQueue.attachmentUrl(preview.id)} alt={preview.name} />
          </div>
        </div>
      )}
    </>
  )
}
