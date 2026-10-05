import { constants } from 'node:fs'
import { access, copyFile, cp, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Import only portable preferences/extensions, never another workspace's state. */
export async function importIdeProfile(base: string, legacy?: string): Promise<void> {
  if (!legacy) return
  const user = join(base, 'user-data', 'User')
  await mkdir(user, { recursive: true, mode: 0o700 })
  // A completed base is authoritative. Later worktrees must not overwrite it.
  try { await access(join(base, 'config.yaml')); return } catch { /* New base. */ }
  for (const file of ['settings.json', 'keybindings.json']) {
    try {
      await copyFile(join(legacy, 'user-data', 'User', file), join(user, file), constants.COPYFILE_EXCL)
    } catch (error) {
      if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  let extensions
  try { extensions = await readdir(join(legacy, 'extensions'), { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of extensions) {
    if (!entry.isDirectory()) continue
    // Registry/cache files reference the old location; let code-server rescan.
    await cp(join(legacy, 'extensions', entry.name), join(base, 'extensions', entry.name), {
      recursive: true, force: false, errorOnExist: false,
    })
  }
}
