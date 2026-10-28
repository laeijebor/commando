import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isChatEffort, isModelValue, parseChatModelOptions, type ChatEffort, type ChatModelOption, type ChatProvider } from '../shared/agent-chat.js'
import { modelCatalogKey, type ModelCatalogs } from '../shared/tmux-create.js'

export function defaultModelCatalogPath(): string {
  return process.env.COMMANDO_MODEL_CATALOG_PATH ?? join(homedir(), '.commando', 'model-catalog.json')
}

export function defaultCodexModelsCachePath(env: Record<string, string | undefined> = process.env): string {
  return join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json')
}

/** A remembered list is refreshed on disk at most this often when it hasn't changed. */
const UNCHANGED_REWRITE_MS = 60 * 60_000

/** Codex keeps its own model list fresh; read the entries it shows in its picker. */
export function codexCacheModels(value: unknown): { models: ChatModelOption[]; updatedAt: number } | null {
  if (!value || typeof value !== 'object') return null
  const { models, fetched_at: fetchedAt } = value as { models?: unknown; fetched_at?: unknown }
  if (!Array.isArray(models)) return null
  const options = models.slice(0, 64).flatMap((model): ChatModelOption[] => {
    if (!model || typeof model !== 'object') return []
    const { slug, display_name: displayName, description, visibility, supported_reasoning_levels: levels } = model as Record<string, unknown>
    if (visibility !== 'list' || !isModelValue(slug)) return []
    const efforts = Array.isArray(levels)
      ? levels.flatMap((level): ChatEffort[] => {
        const effort = level && typeof level === 'object' ? (level as { effort?: unknown }).effort : undefined
        return isChatEffort(effort) ? [effort] : []
      })
      : []
    return [{
      value: slug,
      displayName: typeof displayName === 'string' && displayName ? displayName.slice(0, 200) : slug,
      ...(typeof description === 'string' && description ? { description: description.slice(0, 500) } : {}),
      ...(efforts.length ? { efforts } : {}),
    }]
  })
  if (!options.length) return null
  const updatedAt = typeof fetchedAt === 'string' ? Date.parse(fetchedAt) : NaN
  return { models: options, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 }
}

/**
 * The model lists the New session modal offers, without starting anything.
 * Every chat reports its provider's list when it starts; the latest one per
 * provider (and Claude profile) is kept on disk, so the picker is instant.
 */
export class ModelCatalog {
  private catalogs: ModelCatalogs | null = null
  private loading: Promise<ModelCatalogs> | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(
    readonly path = defaultModelCatalogPath(),
    private readonly codexCachePath = defaultCodexModelsCachePath(),
    private readonly now: () => number = Date.now,
  ) {}

  private load(): Promise<ModelCatalogs> {
    if (this.catalogs) return Promise.resolve(this.catalogs)
    this.loading ??= readFile(this.path, 'utf8')
      .then((text) => parseCatalogs(JSON.parse(text) as unknown))
      .catch((): ModelCatalogs => ({}))
      .then((catalogs) => (this.catalogs = catalogs))
    return this.loading
  }

  /** Remembered lists, with Codex's own cache when it is newer than the last Codex chat. */
  async list(): Promise<ModelCatalogs> {
    const catalogs = { ...await this.load() }
    const codex = await readFile(this.codexCachePath, 'utf8').then((text) => codexCacheModels(JSON.parse(text) as unknown)).catch(() => null)
    if (codex && codex.updatedAt >= (catalogs.codex?.updatedAt ?? -1)) catalogs.codex = codex
    return catalogs
  }

  /** Called with each chat's session info; writes only when the list changed or the record is old. */
  async record(session: { provider: ChatProvider; configDir?: string; models?: ChatModelOption[] }): Promise<void> {
    if (!session.models?.length) return
    const catalogs = await this.load()
    const key = modelCatalogKey(session.provider, session.configDir)
    const previous = catalogs[key]
    const now = this.now()
    if (previous && JSON.stringify(previous.models) === JSON.stringify(session.models) && now - previous.updatedAt < UNCHANGED_REWRITE_MS) return
    catalogs[key] = { models: session.models, updatedAt: now }
    const snapshot = JSON.stringify(catalogs)
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.tmp`
      await writeFile(temporary, snapshot, { mode: 0o600 })
      await rename(temporary, this.path)
    }).catch((error: unknown) => console.warn('Unable to save the model catalog', error))
    await this.writes
  }
}

function parseCatalogs(value: unknown): ModelCatalogs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const catalogs: ModelCatalogs = {}
  for (const [key, entry] of Object.entries(value).slice(0, 64)) {
    if (!entry || typeof entry !== 'object') continue
    const { models, updatedAt } = entry as { models?: unknown; updatedAt?: unknown }
    const parsed = parseChatModelOptions(models)
    if (parsed?.length && typeof updatedAt === 'number' && Number.isFinite(updatedAt)) catalogs[key] = { models: parsed, updatedAt }
  }
  return catalogs
}
