export type Note = {
  id: string
  title: string
  body: string
  createdAt: number
  updatedAt: number
}

export type NoteDraft = Pick<Note, 'title' | 'body'>

export type NotesApi = {
  list(): Promise<Note[]>
  create(draft: NoteDraft): Promise<Note>
  update(id: string, draft: NoteDraft): Promise<Note>
  delete(id: string): Promise<void>
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
    if (!response.ok) throw new Error(result.error ?? `Notes request failed (${response.status})`)
    return result as T
  }

  return {
    list: async () => (await request<{ notes: Note[] }>()).notes,
    create: async (draft) => (await request<{ note: Note }>('', {
      method: 'POST',
      body: JSON.stringify(draft),
    })).note,
    update: async (id, draft) => (await request<{ note: Note }>(`/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(draft),
    })).note,
    delete: (id) => request<void>(`/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  }
}
