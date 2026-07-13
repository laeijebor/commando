export const TMUX_CREATE_ROUTES = {
  session: '/api/tmux/sessions',
  window: '/api/tmux/windows',
  pane: '/api/tmux/panes',
} as const

export type TmuxSplitDirection = 'horizontal' | 'vertical'
export type TmuxSplitPlacement = 'before' | 'after'

export type CreateTmuxSessionRequest = {
  name: string
  windowName?: string
  cwd?: string
}

export type CreateTmuxWindowRequest = {
  sessionId: string
  name?: string
  cwd?: string
}

export type CreateTmuxPaneRequest = {
  targetId: string
  direction: TmuxSplitDirection
  placement?: TmuxSplitPlacement
  cwd?: string
}

export type TmuxCreatedTarget = {
  kind: 'session' | 'window' | 'pane'
  sessionId: string
  sessionName: string
  windowId: string
  windowIndex: number
  windowName: string
  paneId: string
  paneIndex: number
  panePath: string
}

export type TmuxCreateResponse = {
  created: TmuxCreatedTarget
}
