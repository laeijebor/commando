export type LinearAccount = { id: string; label: string; workspaceName: string; viewerName: string; createdAt: number }
export type LinearUser = { id: string; name: string; avatarUrl: string | null }
export type LinearState = { id: string; name: string; type: string; color: string; position: number; teamId: string; teamName: string }
export type LinearProject = { id: string; name: string; description: string; color: string; icon: string | null; progress: number; state: string; targetDate: string | null }
export type LinearIssue = { id: string; identifier: string; title: string; priority: number; priorityLabel: string; estimate: number | null; dueDate: string | null; updatedAt: string; url: string; assignee: LinearUser | null; state: LinearState; teamId: string; teamName: string; labels: Array<{ id: string; name: string; color: string }> }
export type LinearComment = { id: string; body: string; createdAt: string; updatedAt: string; parentId: string | null; author: LinearUser | null; children: LinearComment[] }
export type LinearBoard = { project: LinearProject; states: LinearState[]; issues: LinearIssue[]; truncated: boolean }
export type LinearIssueDetail = LinearIssue & { description: string; createdAt: string; creator: LinearUser | null; project: { id: string; name: string } | null; cycle: { id: string; name: string } | null; availableStates: LinearState[]; comments: LinearComment[]; commentsTruncated: boolean }

export function createLinearApi(token: string, fetcher: typeof fetch = fetch) {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(`/api/linear${path}`, {
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
    if (!response.ok) throw new Error(result.error ?? `Linear request failed (${response.status})`)
    return result as T
  }
  return {
    accounts: async () => (await request<{ accounts: LinearAccount[] }>('/accounts')).accounts,
    connect: async (label: string, apiKey: string) => (await request<{ account: LinearAccount }>('/accounts', { method: 'POST', body: JSON.stringify({ label, apiKey }) })).account,
    remove: (accountId: string) => request<void>(`/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' }),
    projects: (accountId: string) => request<{ projects: LinearProject[]; truncated: boolean }>(`/accounts/${encodeURIComponent(accountId)}/projects`),
    board: async (accountId: string, projectId: string) => (await request<{ board: LinearBoard }>(`/accounts/${encodeURIComponent(accountId)}/projects/${encodeURIComponent(projectId)}/board`)).board,
    issue: async (accountId: string, issueId: string) => (await request<{ issue: LinearIssueDetail }>(`/accounts/${encodeURIComponent(accountId)}/issues/${encodeURIComponent(issueId)}`)).issue,
    updateState: async (accountId: string, issueId: string, stateId: string) => (await request<{ issue: LinearIssue }>(`/accounts/${encodeURIComponent(accountId)}/issues/${encodeURIComponent(issueId)}/state`, { method: 'PATCH', body: JSON.stringify({ stateId }) })).issue,
    comment: async (accountId: string, issueId: string, body: string, parentId?: string) => (await request<{ comment: LinearComment }>(`/accounts/${encodeURIComponent(accountId)}/issues/${encodeURIComponent(issueId)}/comments`, { method: 'POST', body: JSON.stringify({ body, parentId }) })).comment,
  }
}
