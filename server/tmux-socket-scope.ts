import { createHash } from 'node:crypto'

/**
 * A file-name suffix that keeps per-user state apart for each tmux server Commando can drive.
 * Empty for the default socket; a test daemon on its own socket (`COMMANDO_TMUX_SOCKET_NAME`
 * or `COMMANDO_TMUX_SOCKET_PATH`) gets its own files instead of rewriting the user's.
 */
export function tmuxSocketStateSuffix(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const socket = env.COMMANDO_TMUX_SOCKET_PATH
    ? `path:${env.COMMANDO_TMUX_SOCKET_PATH}`
    : env.COMMANDO_TMUX_SOCKET_NAME && env.COMMANDO_TMUX_SOCKET_NAME !== 'default'
      ? `name:${env.COMMANDO_TMUX_SOCKET_NAME}` : undefined
  return socket ? `-${createHash('sha256').update(socket).digest('hex').slice(0, 16)}` : ''
}
