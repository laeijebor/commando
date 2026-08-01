import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

const OPEN_TIMEOUT_MS = 3_000
const OPEN_BUFFER_BYTES = 64 * 1024
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u

export type FolderOpenExecutor = (
  file: string,
  args: readonly string[],
  options: {
    encoding: BufferEncoding
    maxBuffer: number
    shell: false
    timeout: number
    windowsHide: boolean
  },
) => Promise<void>

const defaultExecutor: FolderOpenExecutor = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(error.killed ? 'Opening the folder timed out' : stderr.trim() || 'Unable to open the folder'))
        return
      }
      resolve()
    })
  })

export async function openFolderInFinder(
  path: string,
  execute: FolderOpenExecutor = defaultExecutor,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') throw new Error('Opening folders in Finder is only available on macOS')
  if (!isAbsolute(path) || Buffer.byteLength(path, 'utf8') > 4_096 || CONTROL_CHARACTER.test(path)) {
    throw new Error('Pane path must be an absolute folder path without control characters')
  }
  await execute('/usr/bin/open', [path], {
    encoding: 'utf8',
    maxBuffer: OPEN_BUFFER_BYTES,
    shell: false,
    timeout: OPEN_TIMEOUT_MS,
    windowsHide: true,
  })
}
