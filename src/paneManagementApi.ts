import type { PaneMarkTone } from '../shared/protocol'

export type ResourceAction = 'open' | 'reveal' | 'editor' | 'tile'
export type ResourceActionResult = { ok: true; performed: ResourceAction; webPaneId?: string }
/** `engine: 'chromium'` opens a tile for redline review. */
export type ResourceActionOptions = { engine?: 'chromium' }
export type ResourceActionHandler = (path: string, action: ResourceAction, line?: number, options?: ResourceActionOptions) => Promise<ResourceActionResult>

export interface PaneManagementApiClient {
  resourceAction(paneId: string, path: string, action: ResourceAction, line?: number, options?: ResourceActionOptions): Promise<ResourceActionResult>
  renamePane(paneId: string, title: string): Promise<void>
  deletePane(paneId: string): Promise<void>
  openPanePath(paneId: string): Promise<void>
  revealPaneScreenshot(paneId: string, folderId: string, file?: string): Promise<void>
  runInPanePath(paneId: string, command: string): Promise<void>
  /** Starts the pane's Terminal-tab shell if it has none, and returns the shell's pane id. */
  ensurePaneShell(paneId: string): Promise<string>
  setPaneMark(paneId: string, targetId: string, label: string, tone: PaneMarkTone): Promise<void>
  acknowledgePaneMark(paneId: string, targetId: string): Promise<void>
  clearPaneMark(paneId: string, targetId: string): Promise<void>
  /** The pane's visible screen, with colour escapes. */
  capturePane(paneId: string): Promise<string>
  paneViews(): Promise<PaneViews>
}

export type ViewTimes = { viewedAt: Record<string, number>; viewing: string[] }
/** When each pane, and each tile in `tiles`, was last viewed (ms), and which are on a screen now. */
export type PaneViews = ViewTimes & { tiles: ViewTimes }

type ApiErrorBody = { error?: unknown }

function apiError(status: number, body: unknown): Error {
  const message =
    typeof body === 'object' && body !== null && typeof (body as ApiErrorBody).error === 'string'
      ? (body as { error: string }).error
      : `Pane management request failed (${status})`
  return new Error(message)
}

export function createPaneManagementApi(
  token: string,
  fetcher: typeof fetch = fetch,
): PaneManagementApiClient {
  const request = async (path: string, init: RequestInit): Promise<unknown> => {
    const response = await fetcher(`/api/pane-management${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
    const body = await response.json().catch(() => null) as unknown
    if (!response.ok) throw apiError(response.status, body)
    return body
  }
  const send = async (path: string, init: RequestInit): Promise<void> => { await request(path, init) }

  return {
    resourceAction: async (paneId, path, action, line, options) => {
      const body = await request(`/panes/${encodeURIComponent(paneId)}/resource`, {
        method: 'POST', body: JSON.stringify({ path, action, ...(line !== undefined ? { line } : {}), ...(options?.engine ? { engine: options.engine } : {}) }),
      }) as Partial<ResourceActionResult> | null
      if (body?.ok !== true || !['open', 'reveal', 'editor', 'tile'].includes(body.performed ?? '') ||
        (body.performed === 'tile' && typeof body.webPaneId !== 'string')) throw new Error('The daemon did not report a resource action')
      return body as ResourceActionResult
    },
    renamePane: (paneId, title) => send(`/panes/${encodeURIComponent(paneId)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
    deletePane: (paneId) => send(`/panes/${encodeURIComponent(paneId)}/delete`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmPaneId: paneId }),
    }),
    openPanePath: (paneId) => send(`/panes/${encodeURIComponent(paneId)}/open`, {
      method: 'POST',
    }),
    revealPaneScreenshot: (paneId, folderId, file) => send(`/panes/${encodeURIComponent(paneId)}/reveal`, {
      method: 'POST',
      body: JSON.stringify({ folderId, ...(file ? { file } : {}) }),
    }),
    runInPanePath: (paneId, command) => send(`/panes/${encodeURIComponent(paneId)}/run`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),
    ensurePaneShell: async (paneId) => {
      const body = await request(`/panes/${encodeURIComponent(paneId)}/shell`, { method: 'POST' }) as { shellPaneId?: unknown } | null
      if (typeof body?.shellPaneId !== 'string') throw new Error('The daemon did not report a shell pane')
      return body.shellPaneId
    },
    setPaneMark: (paneId, targetId, label, tone) => send(`/panes/${encodeURIComponent(paneId)}/mark`, {
      method: 'POST',
      body: JSON.stringify({ targetId, label, tone }),
    }),
    acknowledgePaneMark: (paneId, targetId) => send(`/panes/${encodeURIComponent(paneId)}/mark/acknowledge`, {
      method: 'POST',
      body: JSON.stringify({ targetId }),
    }),
    clearPaneMark: (paneId, targetId) => send(`/panes/${encodeURIComponent(paneId)}/mark`, {
      method: 'DELETE',
      body: JSON.stringify({ targetId }),
    }),
    capturePane: async (paneId) => {
      const body = await request(`/panes/${encodeURIComponent(paneId)}/capture`, { method: 'GET' }) as { text?: unknown } | null
      if (typeof body?.text !== 'string') throw new Error('The daemon did not return the pane screen')
      return body.text
    },
    paneViews: async () => {
      const body = await request('/views', { method: 'GET' }) as Partial<PaneViews> | null
      const times = (value: Partial<ViewTimes> | null | undefined): ViewTimes => ({
        viewedAt: value?.viewedAt && typeof value.viewedAt === 'object' ? value.viewedAt : {},
        viewing: Array.isArray(value?.viewing) ? value.viewing : [],
      })
      return { ...times(body), tiles: times(body?.tiles) }
    },
  }
}
