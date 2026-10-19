import { spawn } from 'node:child_process'
import { SESSION_AGENT_EXECUTABLES } from '../shared/tmux-create.js'
import { resolveAgentExecutable } from './tmux-create.js'

export type ModelPrintSpawn = (executable: string, args: string[], options: { env: NodeJS.ProcessEnv; signal: AbortSignal }) => Promise<string>

/** Background model calls must not inherit the daemon's pane or resume context. */
export function modelPrintEnv(source: NodeJS.ProcessEnv, configDir?: string): NodeJS.ProcessEnv {
  const env = { ...source }
  delete env.TMUX
  delete env.TMUX_PANE
  delete env.COMMANDO_CHAT_RESUME
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  return env
}

export const resolveModelExecutable = (env: NodeJS.ProcessEnv, resolve = resolveAgentExecutable) => resolve(SESSION_AGENT_EXECUTABLES.claude, env)

/** Bounded stdout, no shell, and no interactive input. */
export const spawnPrint: ModelPrintSpawn = (executable, args, options) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { ...options, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    output += chunk
    if (output.length > 4_096) {
      child.kill('SIGKILL')
      reject(new Error('Model output too large'))
    }
  })
  child.once('error', reject)
  child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error('Model generation failed')))
})
