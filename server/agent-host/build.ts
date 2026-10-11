import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST_DIR = fileURLToPath(new URL('.', import.meta.url))
/** Files outside agent-host/ that the host runs: the protocol, its resume helpers and the launcher. */
const SHARED_FILES = [
  fileURLToPath(new URL('../../shared/agent-chat.ts', import.meta.url)),
  fileURLToPath(new URL('../agent-resume-command.ts', import.meta.url)),
  fileURLToPath(new URL('../../scripts/commando-agent', import.meta.url)),
]
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'

/** The installed Agent SDK version; a host keeps the SDK it loaded until it restarts. */
export async function agentSdkVersion(): Promise<string> {
  // The package's exports hide package.json, so find it next to the entry point.
  const entry = createRequire(import.meta.url).resolve(SDK_PACKAGE)
  const manifest = JSON.parse(await readFile(join(dirname(entry), 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`${SDK_PACKAGE} has no version`)
  return manifest.version
}

/**
 * A fingerprint of the agent host's source and its SDK version. A host
 * computes it once at start; the daemon recomputes it from the checkout, so a
 * host left running across a merge (or an SDK-only bump) can be told an
 * update is available.
 */
export async function agentHostBuild(): Promise<string> {
  const names = (await readdir(HOST_DIR)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).sort()
  const hash = createHash('sha256')
  for (const file of [...names.map((name) => join(HOST_DIR, name)), ...SHARED_FILES]) {
    hash.update(file.slice(file.lastIndexOf('/') + 1)).update('\0').update(await readFile(file)).update('\0')
  }
  hash.update(SDK_PACKAGE).update('\0').update(await agentSdkVersion())
  return hash.digest('hex').slice(0, 12)
}
