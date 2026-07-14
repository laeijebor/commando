import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql'
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_PAGES = 10
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

type JsonRecord = Record<string, unknown>

type StoredAccount = {
  id: string
  label: string
  apiKey: string
  workspaceName: string
  viewerName: string
  createdAt: number
}

type AccountFile = {
  version: 1
  accounts: Record<string, StoredAccount>
}

export type LinearAccount = Omit<StoredAccount, 'apiKey'>

export type LinearProject = {
  id: string
  name: string
  description: string
  color: string
  icon: string | null
  progress: number
  state: string
  targetDate: string | null
  url: string
}

export type LinearWorkflowState = {
  id: string
  name: string
  type: string
  color: string
  position: number
  teamId: string
  teamName: string
}

export type LinearIssueSummary = {
  id: string
  identifier: string
  title: string
  priority: number
  priorityLabel: string
  estimate: number | null
  dueDate: string | null
  updatedAt: string
  url: string
  assignee: LinearUser | null
  state: LinearWorkflowState
  teamId: string
  teamName: string
  labels: LinearLabel[]
}

export type LinearBoard = {
  project: LinearProject
  states: LinearWorkflowState[]
  issues: LinearIssueSummary[]
  truncated: boolean
}

export type LinearUser = {
  id: string
  name: string
  avatarUrl: string | null
}

export type LinearLabel = {
  id: string
  name: string
  color: string
}

export type LinearComment = {
  id: string
  body: string
  createdAt: string
  updatedAt: string
  parentId: string | null
  author: LinearUser | null
  children: LinearComment[]
}

export type LinearIssueDetail = LinearIssueSummary & {
  description: string
  createdAt: string
  creator: LinearUser | null
  project: { id: string; name: string } | null
  cycle: { id: string; name: string } | null
  availableStates: LinearWorkflowState[]
  comments: LinearComment[]
  commentsTruncated: boolean
}

export class LinearServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LinearServiceError'
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw invalidUpstream()
  return value
}

function optionalString(record: JsonRecord, key: string): string | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw invalidUpstream()
  return value
}

function requiredNumber(record: JsonRecord, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidUpstream()
  return value
}

function objectField(record: JsonRecord, key: string): JsonRecord {
  const value = record[key]
  if (!isRecord(value)) throw invalidUpstream()
  return value
}

function optionalObject(record: JsonRecord, key: string): JsonRecord | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw invalidUpstream()
  return value
}

function nodes(record: JsonRecord, key: string): JsonRecord[] {
  const connection = objectField(record, key)
  const value = connection.nodes
  if (!Array.isArray(value) || !value.every(isRecord)) throw invalidUpstream()
  return value
}

function pageInfo(record: JsonRecord, key: string): { hasNextPage: boolean; endCursor: string | null } {
  const connection = objectField(record, key)
  const info = objectField(connection, 'pageInfo')
  if (typeof info.hasNextPage !== 'boolean') throw invalidUpstream()
  const endCursor = optionalString(info, 'endCursor')
  if (info.hasNextPage && endCursor === null) throw invalidUpstream()
  return { hasNextPage: info.hasNextPage, endCursor }
}

function invalidUpstream(): LinearServiceError {
  return new LinearServiceError(502, 'linear_invalid_response', 'Linear returned an invalid response')
}

function validateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new LinearServiceError(400, 'invalid_request', `${label} is invalid`)
  }
  return value
}

function validateLabel(value: unknown): string {
  if (typeof value !== 'string') {
    throw new LinearServiceError(400, 'invalid_request', 'Account label is required')
  }
  const label = value.trim()
  if (label.length < 1 || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new LinearServiceError(400, 'invalid_request', 'Account label must be 1 to 80 characters')
  }
  return label
}

function validateApiKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 512 ||
    /\s|[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new LinearServiceError(400, 'invalid_request', 'Linear API key is invalid')
  }
  return value
}

function validateBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw new LinearServiceError(400, 'invalid_request', 'Comment body is required')
  }
  const body = value.trim()
  if (body.length < 1 || body.length > 20_000) {
    throw new LinearServiceError(400, 'invalid_request', 'Comment must be 1 to 20,000 characters')
  }
  return body
}

function parseStoredAccount(value: unknown, key: string): StoredAccount {
  if (!isRecord(value)) throw new Error('Linear account file has an invalid structure')
  const { id, label, apiKey, workspaceName, viewerName, createdAt } = value
  if (
    id !== key ||
    typeof id !== 'string' ||
    !ID_PATTERN.test(id) ||
    typeof label !== 'string' ||
    label.length < 1 ||
    label.length > 80 ||
    typeof apiKey !== 'string' ||
    apiKey.length < 16 ||
    apiKey.length > 512 ||
    typeof workspaceName !== 'string' ||
    workspaceName.length > 200 ||
    typeof viewerName !== 'string' ||
    viewerName.length > 200 ||
    typeof createdAt !== 'number' ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  ) {
    throw new Error('Linear account file contains an invalid account')
  }
  return { id, label, apiKey, workspaceName, viewerName, createdAt }
}

function parseAccountFile(value: unknown): AccountFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.accounts)) {
    throw new Error('Linear account file has an invalid structure')
  }
  const accounts: Record<string, StoredAccount> = Object.create(null)
  for (const [id, account] of Object.entries(value.accounts)) {
    accounts[id] = parseStoredAccount(account, id)
  }
  return { version: 1, accounts }
}

export function defaultLinearAccountsPath(): string {
  return process.env.COMMANDO_LINEAR_ACCOUNTS_PATH ?? join(homedir(), '.commando', 'linear-accounts.json')
}

export class LinearAccountStore {
  readonly path: string
  private writes: Promise<void> = Promise.resolve()

  constructor(path = defaultLinearAccountsPath()) {
    this.path = path
  }

  async list(): Promise<LinearAccount[]> {
    await this.writes
    const state = await this.read()
    return Object.values(state.accounts)
      .map(({ apiKey: _apiKey, ...account }) => account)
      .sort((left, right) => left.label.localeCompare(right.label))
  }

  async credential(accountId: string): Promise<StoredAccount> {
    validateId(accountId, 'Account id')
    await this.writes
    const account = (await this.read()).accounts[accountId]
    if (!account) throw new LinearServiceError(404, 'account_not_found', 'Linear account not found')
    return { ...account }
  }

  add(input: Omit<StoredAccount, 'id' | 'createdAt'>): Promise<LinearAccount> {
    const account: StoredAccount = {
      ...input,
      id: randomUUID(),
      createdAt: Date.now(),
    }
    const operation = this.writes.then(async () => {
      const state = await this.read()
      state.accounts[account.id] = account
      await this.write(state)
    })
    this.writes = operation.then(() => undefined, () => undefined)
    return operation.then(() => {
      const { apiKey: _apiKey, ...summary } = account
      return summary
    })
  }

  remove(accountId: string): Promise<void> {
    validateId(accountId, 'Account id')
    const operation = this.writes.then(async () => {
      const state = await this.read()
      if (!state.accounts[accountId]) {
        throw new LinearServiceError(404, 'account_not_found', 'Linear account not found')
      }
      delete state.accounts[accountId]
      await this.write(state)
    })
    this.writes = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async read(): Promise<AccountFile> {
    try {
      const metadata = await lstat(this.path)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('Linear account path must be a regular file')
      }
      const content = await readFile(this.path, 'utf8')
      return parseAccountFile(JSON.parse(content) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, accounts: Object.create(null) }
      }
      if (error instanceof SyntaxError) {
        throw new Error('Linear account file contains invalid JSON', { cause: error })
      }
      throw error
    }
  }

  private async write(state: AccountFile): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporaryPath, this.path)
      await chmod(this.path, 0o600)
      try {
        const directoryHandle = await open(directory, 'r')
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      } catch {
        // Directory fsync is not supported by every filesystem.
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

export type LinearFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export class LinearGraphqlClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: LinearFetch = fetch,
  ) {}

  async request(query: string, variables: JsonRecord = {}): Promise<JsonRecord> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    let response: Response
    try {
      response = await this.fetchImpl(LINEAR_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      })
    } catch {
      if (controller.signal.aborted) {
        throw new LinearServiceError(504, 'linear_timeout', 'Linear did not respond in time')
      }
      throw new LinearServiceError(502, 'linear_unavailable', 'Unable to reach Linear')
    } finally {
      clearTimeout(timeout)
    }

    if (response.status === 401 || response.status === 403) {
      throw new LinearServiceError(401, 'linear_unauthorized', 'Linear rejected this API key')
    }
    if (response.status === 429) {
      throw new LinearServiceError(429, 'linear_rate_limited', 'Linear rate limit reached; try again shortly')
    }
    if (!response.ok) {
      throw new LinearServiceError(502, 'linear_error', 'Linear request failed')
    }

    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > MAX_RESPONSE_BYTES) throw invalidUpstream()
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw invalidUpstream()
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      throw invalidUpstream()
    }
    if (!isRecord(payload)) throw invalidUpstream()
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const error = payload.errors.find(isRecord)
      const extensions = error && isRecord(error.extensions) ? error.extensions : null
      const type = extensions && typeof extensions.type === 'string' ? extensions.type : ''
      if (type === 'AuthenticationError' || type === 'Forbidden') {
        throw new LinearServiceError(401, 'linear_unauthorized', 'Linear rejected this API key')
      }
      if (type === 'Ratelimited') {
        throw new LinearServiceError(429, 'linear_rate_limited', 'Linear rate limit reached; try again shortly')
      }
      if (type === 'InvalidInput' || type === 'UserError') {
        throw new LinearServiceError(400, 'linear_invalid_input', 'Linear rejected the requested change')
      }
      throw new LinearServiceError(502, 'linear_error', 'Linear request failed')
    }
    if (!isRecord(payload.data)) throw invalidUpstream()
    return payload.data
  }
}

function mapUser(value: JsonRecord | null): LinearUser | null {
  if (!value) return null
  return {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    avatarUrl: optionalString(value, 'avatarUrl'),
  }
}

function mapState(value: JsonRecord, teamId: string, teamName: string): LinearWorkflowState {
  return {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    type: requiredString(value, 'type'),
    color: requiredString(value, 'color'),
    position: requiredNumber(value, 'position'),
    teamId,
    teamName,
  }
}

function mapProject(value: JsonRecord): LinearProject {
  return {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    description: optionalString(value, 'description') ?? '',
    color: requiredString(value, 'color'),
    icon: optionalString(value, 'icon'),
    progress: requiredNumber(value, 'progress'),
    state: requiredString(value, 'state'),
    targetDate: optionalString(value, 'targetDate'),
    url: requiredString(value, 'url'),
  }
}

function mapLabel(value: JsonRecord): LinearLabel {
  return {
    id: requiredString(value, 'id'),
    name: requiredString(value, 'name'),
    color: requiredString(value, 'color'),
  }
}

function mapIssue(value: JsonRecord): LinearIssueSummary {
  const team = objectField(value, 'team')
  const teamId = requiredString(team, 'id')
  const teamName = requiredString(team, 'name')
  return {
    id: requiredString(value, 'id'),
    identifier: requiredString(value, 'identifier'),
    title: requiredString(value, 'title'),
    priority: requiredNumber(value, 'priority'),
    priorityLabel: requiredString(value, 'priorityLabel'),
    estimate: value.estimate === null || value.estimate === undefined
      ? null
      : requiredNumber(value, 'estimate'),
    dueDate: optionalString(value, 'dueDate'),
    updatedAt: requiredString(value, 'updatedAt'),
    url: requiredString(value, 'url'),
    assignee: mapUser(optionalObject(value, 'assignee')),
    state: mapState(objectField(value, 'state'), teamId, teamName),
    teamId,
    teamName,
    labels: nodes(value, 'labels').map(mapLabel),
  }
}

function mapComment(value: JsonRecord): LinearComment {
  const fallbackAuthor = optionalObject(value, 'botActor') ?? optionalObject(value, 'externalUser')
  const children = value.children === undefined || value.children === null
    ? []
    : nodes(value, 'children').map(mapComment)
  return {
    id: requiredString(value, 'id'),
    body: requiredString(value, 'body'),
    createdAt: requiredString(value, 'createdAt'),
    updatedAt: requiredString(value, 'updatedAt'),
    parentId: optionalString(value, 'parentId'),
    author: mapUser(optionalObject(value, 'user') ?? fallbackAuthor),
    children,
  }
}

const ISSUE_CARD_FIELDS = `
  id identifier title priority priorityLabel estimate dueDate updatedAt url
  assignee { id name avatarUrl }
  state { id name type color position }
  team { id name }
  labels(first: 50) { nodes { id name color } }
`

const COMMENT_FIELDS = `
  id body createdAt updatedAt parentId
  user { id name avatarUrl }
  botActor { id name avatarUrl }
  externalUser { id name avatarUrl }
`

export class LinearService {
  constructor(
    readonly store = new LinearAccountStore(),
    private readonly fetchImpl: LinearFetch = fetch,
  ) {}

  listAccounts(): Promise<LinearAccount[]> {
    return this.store.list()
  }

  async connectAccount(labelValue: unknown, keyValue: unknown): Promise<LinearAccount> {
    const label = validateLabel(labelValue)
    const apiKey = validateApiKey(keyValue)
    const client = new LinearGraphqlClient(apiKey, this.fetchImpl)
    const data = await client.request(`
      query CommandoLinearViewer {
        viewer { id name }
        organization { id name }
      }
    `)
    const viewer = objectField(data, 'viewer')
    const organization = objectField(data, 'organization')
    return this.store.add({
      label,
      apiKey,
      viewerName: requiredString(viewer, 'name'),
      workspaceName: requiredString(organization, 'name'),
    })
  }

  removeAccount(accountId: string): Promise<void> {
    return this.store.remove(accountId)
  }

  async listProjects(accountId: string): Promise<{ projects: LinearProject[]; truncated: boolean }> {
    const client = await this.client(accountId)
    const projects: LinearProject[] = []
    let after: string | null = null
    let truncated = false
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await client.request(`
        query CommandoLinearProjects($after: String) {
          projects(first: 50, after: $after) {
            nodes { id name description color icon progress state targetDate url archivedAt }
            pageInfo { hasNextPage endCursor }
          }
        }
      `, { after })
      for (const project of nodes(data, 'projects')) {
        if (project.archivedAt === null || project.archivedAt === undefined) projects.push(mapProject(project))
      }
      const info = pageInfo(data, 'projects')
      if (!info.hasNextPage) return { projects, truncated: false }
      after = info.endCursor
      truncated = true
    }
    return { projects, truncated }
  }

  async getBoard(accountId: string, projectIdValue: string): Promise<LinearBoard> {
    const projectId = validateId(projectIdValue, 'Project id')
    const client = await this.client(accountId)
    let after: string | null = null
    let project: LinearProject | null = null
    const issues: LinearIssueSummary[] = []
    const states = new Map<string, LinearWorkflowState>()
    const teams = new Map<string, string>()
    let truncated = false
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await client.request(`
        query CommandoLinearBoard($projectId: String!, $after: String) {
          project(id: $projectId) {
            id name description color icon progress state targetDate url archivedAt
            teams(first: 50) { nodes { id name } }
            issues(first: 100, after: $after) {
              nodes { ${ISSUE_CARD_FIELDS} archivedAt }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `, { projectId, after })
      const rawProject = optionalObject(data, 'project')
      if (!rawProject) throw new LinearServiceError(404, 'project_not_found', 'Linear project not found')
      project ??= mapProject(rawProject)
      for (const team of nodes(rawProject, 'teams')) {
        teams.set(requiredString(team, 'id'), requiredString(team, 'name'))
      }
      for (const rawIssue of nodes(rawProject, 'issues')) {
        if (rawIssue.archivedAt !== null && rawIssue.archivedAt !== undefined) continue
        const issue = mapIssue(rawIssue)
        issues.push(issue)
        teams.set(issue.teamId, issue.teamName)
      }
      const info = pageInfo(rawProject, 'issues')
      if (!info.hasNextPage) {
        truncated = false
        break
      }
      after = info.endCursor
      truncated = true
    }
    if (!project) throw invalidUpstream()
    await Promise.all([...teams].map(async ([teamId, teamName]) => {
      const data = await client.request(`
        query CommandoLinearTeamStates($teamId: String!) {
          team(id: $teamId) {
            states(first: 100) { nodes { id name type color position } }
          }
        }
      `, { teamId })
      const team = optionalObject(data, 'team')
      if (!team) return
      for (const rawState of nodes(team, 'states')) {
        const state = mapState(rawState, teamId, teamName)
        states.set(state.id, state)
      }
    }))
    return {
      project,
      issues: issues.sort((left, right) => left.identifier.localeCompare(right.identifier)),
      states: [...states.values()].sort(compareStates),
      truncated,
    }
  }

  async getIssue(accountId: string, issueIdValue: string): Promise<LinearIssueDetail> {
    const issueId = validateId(issueIdValue, 'Issue id')
    const client = await this.client(accountId)
    const issueData = await client.request(`
      query CommandoLinearIssue($issueId: String!) {
        issue(id: $issueId) {
          ${ISSUE_CARD_FIELDS}
          description createdAt
          creator { id name avatarUrl }
          project { id name }
          cycle { id name }
        }
      }
    `, { issueId })
    const rawIssue = optionalObject(issueData, 'issue')
    if (!rawIssue) throw new LinearServiceError(404, 'issue_not_found', 'Linear issue not found')
    const summary = mapIssue(rawIssue)

    const stateData = await client.request(`
      query CommandoLinearIssueStates($teamId: String!) {
        team(id: $teamId) {
          states(first: 100) { nodes { id name type color position } }
        }
      }
    `, { teamId: summary.teamId })
    const team = optionalObject(stateData, 'team')
    const availableStates = team
      ? nodes(team, 'states')
        .map((state) => mapState(state, summary.teamId, summary.teamName))
        .sort(compareStates)
      : []

    let after: string | null = null
    const comments = new Map<string, LinearComment>()
    let commentsTruncated = false
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await client.request(`
        query CommandoLinearIssueComments($issueId: String!, $after: String) {
          issue(id: $issueId) {
            comments(first: 100, after: $after) {
              nodes { ${COMMENT_FIELDS} }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `, { issueId, after })
      const current = optionalObject(data, 'issue')
      if (!current) throw new LinearServiceError(404, 'issue_not_found', 'Linear issue not found')
      for (const value of nodes(current, 'comments')) {
        const comment = mapComment(value)
        comments.set(comment.id, comment)
      }
      const info = pageInfo(current, 'comments')
      if (!info.hasNextPage) {
        commentsTruncated = false
        break
      }
      after = info.endCursor
      commentsTruncated = true
    }
    return {
      ...summary,
      description: optionalString(rawIssue, 'description') ?? '',
      createdAt: requiredString(rawIssue, 'createdAt'),
      creator: mapUser(optionalObject(rawIssue, 'creator')),
      project: mapNamedReference(optionalObject(rawIssue, 'project')),
      cycle: mapNamedReference(optionalObject(rawIssue, 'cycle')),
      availableStates,
      comments: buildCommentTree([...comments.values()]),
      commentsTruncated,
    }
  }

  async updateIssueState(accountId: string, issueIdValue: string, stateIdValue: unknown): Promise<LinearIssueSummary> {
    const issueId = validateId(issueIdValue, 'Issue id')
    const stateId = validateId(stateIdValue, 'State id')
    const client = await this.client(accountId)
    const data = await client.request(`
      mutation CommandoLinearIssueState($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
          issue { ${ISSUE_CARD_FIELDS} }
        }
      }
    `, { issueId, stateId })
    const payload = objectField(data, 'issueUpdate')
    if (payload.success !== true) throw new LinearServiceError(502, 'linear_error', 'Linear did not update the issue')
    return mapIssue(objectField(payload, 'issue'))
  }

  async createComment(
    accountId: string,
    issueIdValue: string,
    bodyValue: unknown,
    parentIdValue?: unknown,
  ): Promise<LinearComment> {
    const issueId = validateId(issueIdValue, 'Issue id')
    const body = validateBody(bodyValue)
    const parentId = parentIdValue === undefined || parentIdValue === null
      ? null
      : validateId(parentIdValue, 'Parent comment id')
    const client = await this.client(accountId)
    const data = await client.request(`
      mutation CommandoLinearComment($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { ${COMMENT_FIELDS} children(first: 1) { nodes { id } } }
        }
      }
    `, { input: { issueId, body, ...(parentId ? { parentId } : {}) } })
    const payload = objectField(data, 'commentCreate')
    if (payload.success !== true) throw new LinearServiceError(502, 'linear_error', 'Linear did not create the comment')
    return mapComment(objectField(payload, 'comment'))
  }

  private async client(accountId: string): Promise<LinearGraphqlClient> {
    const account = await this.store.credential(validateId(accountId, 'Account id'))
    return new LinearGraphqlClient(account.apiKey, this.fetchImpl)
  }
}

function mapNamedReference(value: JsonRecord | null): { id: string; name: string } | null {
  return value ? { id: requiredString(value, 'id'), name: requiredString(value, 'name') } : null
}

function buildCommentTree(comments: LinearComment[]): LinearComment[] {
  const byId = new Map<string, LinearComment>(
    comments.map((comment) => [comment.id, { ...comment, children: [] }]),
  )
  const roots: LinearComment[] = []
  for (const comment of byId.values()) {
    const parent = comment.parentId ? byId.get(comment.parentId) : undefined
    if (parent) parent.children.push(comment)
    else roots.push(comment)
  }
  const sort = (items: LinearComment[]): LinearComment[] => items
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((comment) => ({ ...comment, children: sort(comment.children) }))
  return sort(roots)
}

function compareStates(left: LinearWorkflowState, right: LinearWorkflowState): number {
  const order: Record<string, number> = {
    triage: 0,
    backlog: 1,
    unstarted: 2,
    started: 3,
    completed: 4,
    canceled: 5,
    duplicate: 6,
  }
  return (order[left.type] ?? 99) - (order[right.type] ?? 99)
    || left.position - right.position
    || left.teamName.localeCompare(right.teamName)
}
