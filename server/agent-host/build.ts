import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST_DIR = fileURLToPath(new URL('.', import.meta.url))
const PROTOCOL_FILE = fileURLToPath(new URL('../../shared/agent-chat.ts', import.meta.url))

/**
 * A fingerprint of the agent host's source. A host computes it once at start;
 * the daemon recomputes it from the checkout, so a host left running across a
 * merge can be told an update is available.
 */
export async function agentHostBuild(): Promise<string> {
  const names = (await readdir(HOST_DIR)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).sort()
  const hash = createHash('sha256')
  for (const file of [...names.map((name) => join(HOST_DIR, name)), PROTOCOL_FILE]) {
    hash.update(file.slice(file.lastIndexOf('/') + 1)).update('\0').update(await readFile(file)).update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}
