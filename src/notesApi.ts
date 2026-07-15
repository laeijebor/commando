export type Note = {
  id: string
  title: string
  body: string
  folder: string
  createdAt: number
  updatedAt: number
}

export type NoteDraft = Pick<Note, 'title' | 'body' | 'folder'>

export type NoteUpdate = NoteDraft & {
  expectedUpdatedAt: number
}

export type NoteVault = {
  id: string
  name: string
  path: string
  lastOpenedAt: number
  available: boolean
}

export type NoteVaultSnapshot = {
  activeVaultId: string
  vaults: NoteVault[]
}

export type NotesSnapshot = {
  notes: Note[]
  folders: string[]
}

export type NoteBatchTarget = Pick<Note, 'id' | 'updatedAt'>

export type NoteBatchResult = NotesSnapshot & {
  failures: Array<{ id: string; error: string }>
}

export type NoteVaultBrowseResult = {
  path: string
  parent: string | null
  home: string
  directories: Array<{ name: string; path: string }>
}

const LOCAL_IMAGE_PATH = /^(?:\.\/)?images\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|gif|webp))$/i

export class NotesApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'NotesApiError'
  }
}

export type NotesApi = {
  vaults(): Promise<NoteVaultSnapshot>
  openVault(path: string): Promise<NoteVaultSnapshot>
  createVault(path: string): Promise<NoteVaultSnapshot>
  createVaultIn(parent: string, name: string): Promise<NoteVaultSnapshot>
  browseVault(path?: string): Promise<NoteVaultBrowseResult>
  selectVault(id: string): Promise<NoteVaultSnapshot>
  clearVaultHistory(vaultId: string): Promise<NoteVaultSnapshot>
  list(vaultId: string): Promise<NotesSnapshot>
  get(vaultId: string, id: string): Promise<Note>
  create(vaultId: string, draft: NoteDraft): Promise<Note>
  update(vaultId: string, id: string, draft: NoteUpdate): Promise<Note>
  delete(vaultId: string, id: string, expectedUpdatedAt: number): Promise<void>
  moveMany(vaultId: string, notes: NoteBatchTarget[], folder: string): Promise<NoteBatchResult>
  deleteMany(vaultId: string, notes: NoteBatchTarget[]): Promise<NoteBatchResult>
  createFolder(vaultId: string, folder: string): Promise<string[]>
  renameFolder(vaultId: string, folder: string, name: string): Promise<NotesSnapshot>
  deleteFolder(vaultId: string, folder: string): Promise<NotesSnapshot>
  uploadImage(vaultId: string, id: string, file: File): Promise<string>
  resolveImageUrl(url: string, vaultId: string): string
}

export function createNotesApi(token: string, fetcher: typeof fetch = fetch): NotesApi {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    if (response.status === 204) return undefined as T
    const result = await response.json().catch(() => ({})) as { error?: string }
    if (!response.ok) {
      throw new NotesApiError(result.error ?? `Notes request failed (${response.status})`, response.status)
    }
    return result as T
  }

  const notesPath = (vaultId: string, path = '') => `/api/notes${path}?vault=${encodeURIComponent(vaultId)}`
  const vaultMutation = (path: string, method: 'POST' | 'PUT', value: object) => request<NoteVaultSnapshot>(`/api/note-vaults/${path}`, {
    method,
    body: JSON.stringify(value),
  })

  return {
    vaults: () => request<NoteVaultSnapshot>('/api/note-vaults'),
    openVault: (path) => vaultMutation('open', 'POST', { path }),
    createVault: (path) => vaultMutation('create', 'POST', { path }),
    createVaultIn: (parent, name) => vaultMutation('create', 'POST', { parent, name }),
    browseVault: (path) => request<NoteVaultBrowseResult>(`/api/note-vaults/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    selectVault: (id) => vaultMutation('active', 'PUT', { id }),
    clearVaultHistory: (vaultId) => request<NoteVaultSnapshot>(`/api/note-vaults/history?active=${encodeURIComponent(vaultId)}`, { method: 'DELETE' }),
    list: (vaultId) => request<NotesSnapshot>(notesPath(vaultId)),
    get: async (vaultId, id) => (await request<{ note: Note }>(notesPath(vaultId, `/${encodeURIComponent(id)}`))).note,
    create: async (vaultId, draft) => (await request<{ note: Note }>(notesPath(vaultId), {
      method: 'POST',
      body: JSON.stringify(draft),
    })).note,
    update: async (vaultId, id, draft) => (await request<{ note: Note }>(notesPath(vaultId, `/${encodeURIComponent(id)}`), {
      method: 'PUT',
      body: JSON.stringify(draft),
    })).note,
    delete: (vaultId, id, expectedUpdatedAt) => request<void>(notesPath(vaultId, `/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: { 'If-Match': `"${expectedUpdatedAt}"` },
    }),
    moveMany: (vaultId, notes, folder) => request<NoteBatchResult>(notesPath(vaultId, '/batch'), {
      method: 'PATCH',
      body: JSON.stringify({ notes: notes.map(({ id, updatedAt }) => ({ id, expectedUpdatedAt: updatedAt })), folder }),
    }),
    deleteMany: (vaultId, notes) => request<NoteBatchResult>(notesPath(vaultId, '/batch'), {
      method: 'DELETE',
      body: JSON.stringify({ notes: notes.map(({ id, updatedAt }) => ({ id, expectedUpdatedAt: updatedAt })) }),
    }),
    createFolder: async (vaultId, folder) => (await request<{ folders: string[] }>(notesPath(vaultId, '/folders'), {
      method: 'POST',
      body: JSON.stringify({ folder }),
    })).folders,
    renameFolder: (vaultId, folder, name) => request<NotesSnapshot>(notesPath(vaultId, '/folders'), {
      method: 'PATCH',
      body: JSON.stringify({ folder, name }),
    }),
    deleteFolder: (vaultId, folder) => request<NotesSnapshot>(notesPath(vaultId, '/folders'), {
      method: 'DELETE',
      body: JSON.stringify({ folder }),
    }),
    uploadImage: async (vaultId, id, file) => (await request<{ path: string }>(notesPath(vaultId, `/${encodeURIComponent(id)}/images`), {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    })).path,
    resolveImageUrl: (url, vaultId) => {
      const match = LOCAL_IMAGE_PATH.exec(url)
      if (!match) return url
      const parameters = new URLSearchParams({ vault: vaultId })
      if (token) parameters.set('token', token)
      return `/api/notes/${encodeURIComponent(match[1])}/images/${encodeURIComponent(match[2])}?${parameters}`
    },
  }
}
