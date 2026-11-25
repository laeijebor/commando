import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardView } from '../shared/board'
import { subscribeBoardChanges, subscribeBoardRefresh, type BoardsApiClient } from './boardsApi'

/** Board payloads live only in the mounted tile, never in the global pane snapshot. */
export function useBoard(targetId: string, host: string, visible: boolean, api: BoardsApiClient) {
  const [board, setBoard] = useState<BoardView | null>(null)
  const [error, setError] = useState('')
  const [mutationError, setMutationError] = useState('')
  const [pending, setPending] = useState(false)
  const state = useRef({ board, visible, stale: true, wantedRev: 0, mutation: false, active: false, request: null as AbortController | null })
  state.current.visible = visible
  const fetchBoard = useCallback(async () => {
    const s = state.current
    if (!s.active || !s.visible || s.request || s.mutation || !s.stale) return
    const controller = new AbortController()
    s.request = controller
    s.stale = false
    try {
      const next = await api.get(targetId, controller.signal)
      if (controller.signal.aborted || !s.active) return
      if (!s.board || next.rev >= s.board.rev) { s.board = next; setBoard(next) }
      s.stale = s.wantedRev > next.rev
      setError('')
    } catch (cause) {
      if (!controller.signal.aborted && s.active) {
        s.stale = true
        setError(cause instanceof Error ? cause.message : 'Unable to load Board')
      }
    } finally {
      if (s.request === controller) s.request = null
    }
  }, [api, targetId])

  useEffect(() => {
    const s = state.current
    s.active = true
    s.stale = true
    const changed = subscribeBoardChanges((change) => {
      if (change.host !== host || change.targetId !== targetId || change.rev <= Math.max(s.board?.rev ?? -1, s.wantedRev)) return
      s.wantedRev = change.rev
      s.stale = true
      // A read may predate this change; abort it so it cannot replace the newer revision.
      if (s.request) s.request.abort()
      s.request = null
      void fetchBoard()
    })
    const refresh = subscribeBoardRefresh((changedHost) => {
      if (changedHost !== host) return
      s.stale = true
      s.request?.abort(); s.request = null
      void fetchBoard()
    })
    const onVisibility = () => { if (document.visibilityState === 'visible') { s.stale = true; void fetchBoard() } }
    document.addEventListener('visibilitychange', onVisibility)
    void fetchBoard()
    return () => {
      s.active = false; s.request?.abort(); s.request = null
      changed(); refresh(); document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [fetchBoard, host, targetId])
  useEffect(() => {
    if (visible) void fetchBoard()
    else { const s = state.current; if (s.request) { s.request.abort(); s.request = null; s.stale = true } }
  }, [visible, fetchBoard])

  const mutate = async (optimistic: (current: BoardView) => BoardView, request: () => Promise<unknown>): Promise<boolean> => {
    const s = state.current
    if (!s.board || s.mutation) return false
    const before = s.board
    s.mutation = true; setPending(true); setMutationError('')
    s.request?.abort(); s.request = null
    s.board = optimistic(before); setBoard(s.board)
    try {
      await request()
      return true
    } catch (cause) {
      if (s.active) {
        s.board = before; setBoard(before)
        setMutationError(cause instanceof Error ? cause.message : 'Unable to update Board')
      }
      return false
    } finally {
      s.mutation = false
      if (s.active) { setPending(false); s.stale = true; void fetchBoard() }
    }
  }
  return { board, error: mutationError || error, pending, mutate, retry: () => { setMutationError(''); state.current.stale = true; void fetchBoard() } }
}
