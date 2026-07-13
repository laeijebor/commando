import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'

const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30
const SESSION_UPDATE_SECONDS = 60 * 60 * 24

export type AuthBootstrap = {
  enabled: boolean
  needsOwner: boolean
  ownerEmail: string | null
}

export type AuthService = {
  bootstrap(): AuthBootstrap
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>
  hasSession(request: IncomingMessage): Promise<boolean>
  close(): void
}

type AuthServiceOptions = {
  ownerEmail: string
  databasePath: string
  secret: string
  baseURL: string
  trustedOrigins: string[]
}

function normalizeOwnerEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('COMMANDO_OWNER_EMAIL must be a valid email address')
  }
  return email
}

export function configuredOwnerEmail(
  value = process.env.COMMANDO_OWNER_EMAIL,
): string | null {
  return value === undefined || value.trim() === '' ? null : normalizeOwnerEmail(value)
}

export function configuredAuthDatabasePath(
  value = process.env.COMMANDO_AUTH_DB_PATH,
  home = process.env.HOME,
): string {
  if (value !== undefined) {
    if (value.trim() === '') throw new Error('COMMANDO_AUTH_DB_PATH must not be empty')
    return resolve(value)
  }
  if (!home) throw new Error('HOME is required when COMMANDO_AUTH_DB_PATH is not set')
  return resolve(home, '.commando', 'auth.sqlite')
}

async function loadOrCreateSecret(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing.length < 32) throw new Error(`${path} must contain at least 32 characters`)
    return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const generated = randomBytes(32).toString('base64url')
  try {
    const file = await open(path, 'wx', 0o600)
    try {
      await file.writeFile(`${generated}\n`, 'utf8')
    } finally {
      await file.close()
    }
    return generated
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing.length < 32) throw new Error(`${path} must contain at least 32 characters`)
    return existing
  }
}

export async function configuredAuthSecret(
  value = process.env.BETTER_AUTH_SECRET,
  path = process.env.COMMANDO_AUTH_SECRET_PATH,
  home = process.env.HOME,
): Promise<string> {
  if (value !== undefined) {
    if (value.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters')
    return value
  }
  if (!path && !home) {
    throw new Error('HOME is required when BETTER_AUTH_SECRET and COMMANDO_AUTH_SECRET_PATH are not set')
  }
  const secretPath = path ? resolve(path) : resolve(home!, '.commando', 'auth.secret')
  return loadOrCreateSecret(secretPath)
}

export async function createAuthService(options: AuthServiceOptions): Promise<AuthService> {
  const ownerEmail = normalizeOwnerEmail(options.ownerEmail)
  await mkdir(dirname(options.databasePath), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(options.databasePath)
  await chmod(options.databasePath, 0o600)

  const authOptions = {
    appName: 'Commando',
    baseURL: options.baseURL,
    database,
    secret: options.secret,
    trustedOrigins: options.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: false,
    },
    session: {
      expiresIn: SESSION_DURATION_SECONDS,
      updateAge: SESSION_UPDATE_SECONDS,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 60 * 60, max: 3 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string }) => (
            user.email.trim().toLowerCase() === ownerEmail ? undefined : false
          ),
        },
      },
    },
  } satisfies BetterAuthOptions

  try {
    await (await getMigrations(authOptions)).runMigrations()
    const auth = betterAuth(authOptions)
    const handler = toNodeHandler(auth)
    const ownerExists = database.prepare('SELECT 1 FROM user WHERE lower(email) = ? LIMIT 1')

    return {
      bootstrap: () => ({
        enabled: true,
        needsOwner: ownerExists.get(ownerEmail) === undefined,
        ownerEmail,
      }),
      handle: handler,
      async hasSession(request) {
        const session = await auth.api.getSession({
          headers: fromNodeHeaders(request.headers),
        })
        return session !== null
      },
      close: () => database.close(),
    }
  } catch (error) {
    database.close()
    throw error
  }
}

export function disabledAuthBootstrap(): AuthBootstrap {
  return { enabled: false, needsOwner: false, ownerEmail: null }
}
