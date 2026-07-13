export type Note = {
  id: string
  title: string
  body: string
  createdAt: number
  updatedAt: number
}

export type NoteDraft = Pick<Note, 'title' | 'body'>

export type NoteUpdate = NoteDraft & {
  expectedUpdatedAt: number
}

const LOCAL_IMAGE_PATH = /^(?:\.\/)?images\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|gif|webp))$/i

export class NotesApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'NotesApiError'
  }
}

export type NotesApi = {
  list(): Promise<Note[]>
  get(id: string): Promise<Note>
  create(draft: NoteDraft): Promise<Note>
  update(id: string, draft: NoteUpdate): Promise<Note>
  delete(id: string, expectedUpdatedAt: number): Promise<void>
  uploadImage(id: string, file: File): Promise<string>
  resolveImageUrl(url: string): string
}

export function createNotesApi(token: string, fetcher: typeof fetch = fetch): NotesApi {
  const request = async <T>(path = '', init?: RequestInit): Promise<T> => {
    const response = await fetcher(`/api/notes${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
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

  return {
    list: async () => (await request<{ notes: Note[] }>()).notes,
    get: async (id) => (await request<{ note: Note }>(`/${encodeURIComponent(id)}`)).note,
    create: async (draft) => (await request<{ note: Note }>('', {
      method: 'POST',
      body: JSON.stringify(draft),
    })).note,
    update: async (id, draft) => (await request<{ note: Note }>(`/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(draft),
    })).note,
    delete: (id, expectedUpdatedAt) => request<void>(`/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'If-Match': `"${expectedUpdatedAt}"` },
    }),
    uploadImage: async (id, file) => (await request<{ path: string }>(`/${encodeURIComponent(id)}/images`, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    })).path,
    resolveImageUrl: (url) => {
      const match = LOCAL_IMAGE_PATH.exec(url)
      if (!match) return url
      return `/api/notes/${encodeURIComponent(match[1])}/images/${encodeURIComponent(match[2])}?token=${encodeURIComponent(token)}`
    },
  }
}
