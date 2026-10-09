import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/** First executable named `command` on PATH, or undefined. */
export async function which(command: string, path = process.env.PATH ?? ''): Promise<string | undefined> {
  for (const directory of path.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, command)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return undefined
}
