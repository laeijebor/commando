import {
  TMUX_CREATE_ROUTES,
  type CreateTmuxPaneRequest,
  type CreateTmuxSessionRequest,
  type CreateTmuxWindowRequest,
  type TmuxCreatedTarget,
  type TmuxCreatedWorktree,
  type TmuxCreateResponse,
} from '../shared/tmux-create'

export type TmuxCreateApi = {
  createSession: (input: CreateTmuxSessionRequest) => Promise<TmuxCreateResponse>
  createWindow: (input: CreateTmuxWindowRequest) => Promise<TmuxCreatedTarget>
  createPane: (input: CreateTmuxPaneRequest) => Promise<TmuxCreatedTarget>
}

function isCreatedTarget(value: unknown): value is TmuxCreatedTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as Partial<TmuxCreatedTarget>
  return (
    (target.kind === 'session' || target.kind === 'window' || target.kind === 'pane') &&
    typeof target.sessionId === 'string' &&
    typeof target.sessionName === 'string' &&
    typeof target.windowId === 'string' &&
    Number.isSafeInteger(target.windowIndex) &&
    typeof target.windowName === 'string' &&
    typeof target.paneId === 'string' &&
    Number.isSafeInteger(target.paneIndex) &&
    typeof target.panePath === 'string'
  )
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown
    if (body && typeof body === 'object' && 'message' in body) {
      const message = (body as { message: unknown }).message
      if (typeof message === 'string' && message) return message
    }
    if (body && typeof body === 'object' && 'error' in body) {
      const error = (body as { error: unknown }).error
      if (typeof error === 'string' && error) return error
      if (error && typeof error === 'object' && 'message' in error) {
        const message = (error as { message: unknown }).message
        if (typeof message === 'string' && message) return message
      }
    }
  } catch {
    // Fall back to the bounded HTTP status below.
  }
  return `tmux create request returned ${response.status}`
}

function isCreatedWorktree(value: unknown): value is TmuxCreatedWorktree {
  if (!value || typeof value !== 'object') return false
  const worktree = value as Partial<TmuxCreatedWorktree>
  return typeof worktree.path === 'string' && typeof worktree.branch === 'string' && typeof worktree.base === 'string'
}

export function createTmuxHttpApi(token: string, fetcher: typeof fetch = fetch): TmuxCreateApi {
  const post = async (route: string, input: object): Promise<TmuxCreateResponse> => {
    const response = await fetcher(route, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(await responseError(response))
    const body = (await response.json()) as Partial<TmuxCreateResponse>
    if (!isCreatedTarget(body.created)) {
      throw new Error('tmux create response did not match the protocol')
    }
    return { created: body.created, ...(isCreatedWorktree(body.worktree) ? { worktree: body.worktree } : {}) }
  }

  return {
    createSession: (input) => post(TMUX_CREATE_ROUTES.session, input),
    createWindow: async (input) => (await post(TMUX_CREATE_ROUTES.window, input)).created,
    createPane: async (input) => (await post(TMUX_CREATE_ROUTES.pane, input)).created,
  }
}
