import { spawn } from 'node:child_process'

const MAX_COMMAND_BYTES = 8 * 1024
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u

export function validateRunCommand(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_COMMAND_BYTES ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error('Command must be 1-8192 bytes without surrounding whitespace or control characters')
  }
  return value
}

export function runCommand(command: string, cwd: string): Promise<void> {
  const validatedCommand = validateRunCommand(command)
  const shell = process.env.SHELL || '/bin/zsh'

  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-lc', validatedCommand], {
      cwd,
      detached: true,
      shell: false,
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
