import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const AGENT_HOOK_TOKEN_PATH_ENV = 'COMMANDO_AGENT_HOOK_TOKEN_PATH'

export type AgentHookTokenStoreOptions = {
  home?: string
  path?: string
}

export function configuredAgentHookTokenPath(
  path = process.env[AGENT_HOOK_TOKEN_PATH_ENV],
  home = process.env.HOME,
): string {
  if (path !== undefined) {
    if (path.trim() === '') {
      throw new Error(`${AGENT_HOOK_TOKEN_PATH_ENV} must not be empty`)
    }
    return resolve(path)
  }
  if (!home) {
    throw new Error(`HOME is required when ${AGENT_HOOK_TOKEN_PATH_ENV} is not set`)
  }
  return resolve(home, '.commando', 'agent-hook-token')
}

function validateToken(token: string, path: string): string {
  if (token.length < 32) {
    throw new Error(`${path} must contain at least 32 characters`)
  }
  return token
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${path} must be a directory, not a symbolic link`)
  }
}

async function readPrivateToken(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`${path} must be a regular file`)
    const token = validateToken((await handle.readFile('utf8')).trim(), path)
    await handle.chmod(0o600)
    return token
  } finally {
    await handle.close()
  }
}

export class AgentHookTokenStore {
  readonly path: string

  constructor(options: AgentHookTokenStoreOptions = {}) {
    if (options.path === undefined && options.home !== undefined) {
      if (!options.home) throw new Error('HOME is required to store the agent hook token')
      this.path = resolve(options.home, '.commando', 'agent-hook-token')
    } else {
      this.path = configuredAgentHookTokenPath(options.path, options.home)
    }
  }

  async loadOrCreate(): Promise<string> {
    await ensurePrivateDirectory(dirname(this.path))
    try {
      return await readPrivateToken(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const generated = randomBytes(32).toString('base64url')
    try {
      const handle = await open(
        this.path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.writeFile(`${generated}\n`, 'utf8')
        await handle.chmod(0o600)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return generated
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return readPrivateToken(this.path)
    }
  }
}

export async function loadOrCreateAgentHookToken(
  options: AgentHookTokenStoreOptions = {},
): Promise<string> {
  return new AgentHookTokenStore(options).loadOrCreate()
}
