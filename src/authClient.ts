import { createAuthClient } from 'better-auth/client'

export type AuthBootstrap = {
  enabled: boolean
  needsOwner: boolean
  ownerEmail: string | null
}

export type AuthUser = {
  id: string
  name: string
  email: string
}

const client = createAuthClient()

function errorMessage(error: { message?: string } | null, fallback: string): string {
  return error?.message || fallback
}

export async function getAuthBootstrap(): Promise<AuthBootstrap> {
  const response = await fetch('/api/auth/bootstrap', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Authentication bootstrap failed (${response.status})`)
  return await response.json() as AuthBootstrap
}

export async function getAuthUser(): Promise<AuthUser | null> {
  const result = await client.getSession()
  if (result.error) throw new Error(errorMessage(result.error, 'Unable to read the current session'))
  return result.data?.user ?? null
}

export async function signInWithEmail(email: string, password: string): Promise<AuthUser> {
  const result = await client.signIn.email({ email, password, rememberMe: true })
  if (result.error) throw new Error(errorMessage(result.error, 'Sign in failed'))
  const user = await getAuthUser()
  if (!user) throw new Error('Sign in completed without a session')
  return user
}

export async function createOwner(
  name: string,
  email: string,
  password: string,
): Promise<AuthUser> {
  const result = await client.signUp.email({ name, email, password })
  if (result.error) throw new Error(errorMessage(result.error, 'Owner setup failed'))
  const user = await getAuthUser()
  if (!user) throw new Error('Owner setup completed without a session')
  return user
}

export async function signOut(): Promise<void> {
  const result = await client.signOut()
  if (result.error) throw new Error(errorMessage(result.error, 'Sign out failed'))
}
