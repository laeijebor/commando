import { type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { ChevronRight, GitBranch, Paperclip } from 'lucide-react'
import {
  chatPermissionModes,
  isChatLaunchProvider,
  chatProfileConfigDir,
  defaultWorktreePath,
  modelCatalogKey,
  sanitizeBranchName,
  requireSessionAgentLaunch,
  TmuxAgentLaunchCompatibilityError,
  type ClaudeProfile,
  type CreateTmuxSessionRequest,
  type ModelCatalogs,
  type GitRepoInfo,
  type TmuxCreatedTarget,
  type TmuxCreatedWorktree,
  type TmuxCreateResponse,
  chatLaunchPermission,
} from '../shared/tmux-create'
import { loadChatLaunch, saveChatLaunch, type ChatLaunchPreference } from './chatLaunchPreferences'
import './tmux-create.css'
import { createAgentChatsApi } from './agentChatsApi'
import { ImageViewer, Thumbnail, type ViewableImage } from './chat/ChatImages'
import { uploadChatImage, uploadChatVideo } from './chatInputApi'
import {
  agentOptions,
  loadModelChoice,
  modelCatalogFor,
  modelChoices,
  modelProvider,
  saveModelChoice,
  shortPath,
  takesImages,
  takesPrompt,
  usesClaudeProfile,
  type AgentOption,
  type StartWith,
} from './newSessionAgents'
import { AgentPicker, NewSessionModelPicker, NewSessionPermissionPicker } from './NewSessionPickers'
import { isAttachableFile, useOpeningAttachments, type AttachmentUploads } from './useOpeningAttachments'
import type { SessionNamingApi } from './sessionNamingApi'
import type { SessionNamingResponse } from '../shared/session-naming'

export type SessionCreateRepo = { root: string; name: string; defaultBranch?: string }

export type SessionCreateRequest = {
  id: number
  groupId: string
  groupName: string
  suggestedDirectories: string[]
  /** Set when the request came from a repository group; the form pre-fills its main checkout. */
  repo?: SessionCreateRepo
}

export const TMUX_CWD_HISTORY_STORAGE_KEY = 'commando.tmux-create.cwd'
export const WORKTREE_PREPARE_COMMANDS_STORAGE_KEY = 'commando.tmux-create.prepare-by-repo'
export const START_WITH_STORAGE_KEY = 'commando.tmux-create.start-with-by-repo'
const MAX_WORKING_DIRECTORY_HISTORY = 10
const REPO_PROBE_DEBOUNCE_MS = 200
const REPO_PROBE_TIMEOUT_MS = 10_000

export type TmuxCreateControlsProps = {
  token?: string
  disabled?: boolean
  /** `inline` (default) is the collapsible sidebar form; `dialog` renders the open panel only. */
  variant?: 'inline' | 'dialog'
  sessionCreateRequest?: SessionCreateRequest | null
  onCreateSession: (input: CreateTmuxSessionRequest) => Promise<TmuxCreateResponse>
  onCreated?: (created: TmuxCreatedTarget, sessionGroupId?: string, worktree?: TmuxCreatedWorktree) => void | Promise<void>
  onPendingChange?: (pending: boolean) => void
  /** Describes the repository behind a directory; without it the worktree block never appears. */
  probeRepo?: (directory: string) => Promise<GitRepoInfo>
  /** Claude profiles (config dirs) a chat pane can start with. */
  loadClaudeProfiles?: () => Promise<ClaudeProfile[]>
  /** Each provider's models, remembered by the daemon from earlier chats. */
  loadModelCatalogs?: () => Promise<ModelCatalogs>
  /** Where pasted images and videos go; defaults to the daemon's chat uploads. */
  uploads?: AttachmentUploads
  /** Names a session from its prompt when no name is given (the daemon's naming model). */
  naming?: Pick<SessionNamingApi, 'suggest' | 'describe'>
}

type RepoProbe = { directory: string; info: GitRepoInfo } | null

const START_WITH_VALUES: readonly StartWith[] = ['none', 'shell', 'claude-chat', 'codex-chat', 'muse-chat', 'cursor-chat', 'claude', 'codex', 'opencode', 'cursor']
/** Before anything is remembered, a new session is a quick Claude chat. */
const DEFAULT_START_WITH: StartWith = 'claude-chat'
const LAST_START_WITH = '*'

function knownRepoProbe(request: SessionCreateRequest | null): RepoProbe {
  const repo = request?.repo
  if (!repo) return null
  return {
    directory: repo.root,
    info: {
      isRepo: true,
      mainRoot: repo.root,
      root: repo.root,
      name: repo.name,
      ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch, remote: 'origin' } : {}),
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to create the tmux target'
}

function loadWorkingDirectoryHistory(): string[] {
  try {
    const stored = window.localStorage.getItem(TMUX_CWD_HISTORY_STORAGE_KEY)
    if (!stored) return []
    let values: unknown
    try {
      values = JSON.parse(stored)
    } catch {
      // Older versions stored only the last successful directory as plain text.
      values = [stored]
    }
    if (!Array.isArray(values)) return []
    return values
      .filter((value): value is string => typeof value === 'string' && value.startsWith('/'))
      .filter((value, index, history) => history.indexOf(value) === index)
      .slice(0, MAX_WORKING_DIRECTORY_HISTORY)
  } catch {
    return []
  }
}

function saveWorkingDirectoryHistory(value: string, history: readonly string[]): string[] {
  if (!value) return [...history]
  const nextHistory = [value, ...history.filter((directory) => directory !== value)]
    .slice(0, MAX_WORKING_DIRECTORY_HISTORY)
  try {
    window.localStorage.setItem(TMUX_CWD_HISTORY_STORAGE_KEY, JSON.stringify(nextHistory))
  } catch {
    // Persistence is optional when browser storage is unavailable.
  }
  return nextHistory
}

// Prepare commands saved before the daemon kept a copy reach it once per page load,
// so agent-opened worktrees prepare like ones created here.
const prepareCommandsSynced = new Set<string>()

export function syncStoredPrepareCommands(token: string | undefined): void {
  const api = createAgentChatsApi(token ?? '')
  for (const [root, command] of Object.entries(loadWorktreePrepareCommands())) {
    const key = JSON.stringify([token ?? '', root, command])
    if (!command.trim() || prepareCommandsSynced.has(key)) continue
    prepareCommandsSynced.add(key)
    void api.setPrepareCommand(root, command).catch((cause: unknown) => {
      // Forget the attempt so the next mount retries, e.g. after a daemon restart.
      prepareCommandsSynced.delete(key)
      console.warn('Unable to sync repository prepare command', cause)
    })
  }
}

function loadWorktreePrepareCommands(): Record<string, string> {
  try {
    const stored = window.localStorage.getItem(WORKTREE_PREPARE_COMMANDS_STORAGE_KEY)
    if (!stored) return {}
    const value = JSON.parse(stored) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(
      (entry): entry is [string, string] => entry[0].startsWith('/') && typeof entry[1] === 'string',
    ))
  } catch {
    return {}
  }
}

function saveWorktreePrepareCommand(repoRoot: string, command: string): void {
  try {
    const commands = loadWorktreePrepareCommands()
    if (command.trim()) commands[repoRoot] = command
    else delete commands[repoRoot]
    if (Object.keys(commands).length) {
      window.localStorage.setItem(WORKTREE_PREPARE_COMMANDS_STORAGE_KEY, JSON.stringify(commands))
    } else {
      window.localStorage.removeItem(WORKTREE_PREPARE_COMMANDS_STORAGE_KEY)
    }
  } catch {
    // Persistence is optional when browser storage is unavailable.
  }
}

/** What this repository last started with, else what was last started anywhere. */
function loadStartWith(repoKey: string | undefined): StartWith {
  try {
    const stored = JSON.parse(window.localStorage.getItem(START_WITH_STORAGE_KEY) ?? '{}') as Record<string, unknown> | null
    const known = (value: unknown) => START_WITH_VALUES.find((choice) => choice === value)
    return (repoKey ? known(stored?.[repoKey]) : undefined) ?? known(stored?.[LAST_START_WITH]) ?? DEFAULT_START_WITH
  } catch {
    return DEFAULT_START_WITH
  }
}

function saveStartWith(repoKey: string | undefined, startWith: StartWith): void {
  try {
    const stored = JSON.parse(window.localStorage.getItem(START_WITH_STORAGE_KEY) ?? '{}') as unknown
    const all = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : {}
    window.localStorage.setItem(START_WITH_STORAGE_KEY, JSON.stringify({ ...all, ...(repoKey ? { [repoKey]: startWith } : {}), [LAST_START_WITH]: startWith }))
  } catch {
    // Persistence is optional when browser storage is unavailable.
  }
}

const defaultUploads = (token: string): AttachmentUploads => ({
  uploadImage: (image) => uploadChatImage(token, image),
  uploadVideo: (file, signal) => uploadChatVideo(token, file, signal),
})

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0] ?? ''
}

export function TmuxCreateControls({
  token = '',
  disabled = false,
  variant = 'inline',
  sessionCreateRequest = null,
  onCreateSession,
  onCreated,
  onPendingChange,
  probeRepo,
  loadClaudeProfiles,
  loadModelCatalogs,
  uploads,
  naming,
}: TmuxCreateControlsProps) {
  const prepareEditVersion = useRef(0)
  const [openVersion, setOpenVersion] = useState(0)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const sessionNameRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const [sessionName, setSessionName] = useState('')
  const [windowName, setWindowName] = useState('')
  const [workingDirectoryHistory, setWorkingDirectoryHistory] = useState(loadWorkingDirectoryHistory)
  const [workingDirectory, setWorkingDirectory] = useState(
    sessionCreateRequest?.repo?.root ?? sessionCreateRequest?.suggestedDirectories[0] ?? workingDirectoryHistory[0] ?? '',
  )
  const [sessionGroupId, setSessionGroupId] = useState('ungrouped')
  const [sessionGroupName, setSessionGroupName] = useState('Ungrouped')
  const [sessionRepo, setSessionRepo] = useState<SessionCreateRepo | null>(null)
  const [groupDirectorySuggestions, setGroupDirectorySuggestions] = useState<string[]>([])
  const [directoryHistoryOpen, setDirectoryHistoryOpen] = useState(false)
  const [directoryHistoryFiltering, setDirectoryHistoryFiltering] = useState(false)
  const [directoryHistoryHighlight, setDirectoryHistoryHighlight] = useState(0)
  const [repoProbe, setRepoProbe] = useState<RepoProbe>(() => knownRepoProbe(sessionCreateRequest))
  const [worktreeEnabled, setWorktreeEnabled] = useState(true)
  const [branchEdited, setBranchEdited] = useState(false)
  const [branch, setBranch] = useState('')
  const [worktreePath, setWorktreePath] = useState<string | null>(null)
  const [prepareCommand, setPrepareCommand] = useState('')
  const [prepareEnabled, setPrepareEnabled] = useState(true)
  const [pending, setPending] = useState(false)
  // Known on the first render, so focus lands on the prompt only when there will be one.
  const [agentProvider, setAgentProvider] = useState<StartWith>(() => loadStartWith(
    (sessionCreateRequest?.repo?.root ?? sessionCreateRequest?.suggestedDirectories[0] ?? workingDirectoryHistory[0]) || undefined,
  ))
  const [openingPrompt, setOpeningPrompt] = useState('')
  const [claudeProfiles, setClaudeProfiles] = useState<ClaudeProfile[] | null>(null)
  /** The Claude login, shared by Claude chat and Claude terminal. */
  const [claudeProfile, setClaudeProfile] = useState<string | undefined>(() => loadChatLaunch(undefined).configDir)
  const [chatLaunch, setChatLaunch] = useState<ChatLaunchPreference>(() => loadChatLaunch(undefined))
  const [modelCatalogs, setModelCatalogs] = useState<ModelCatalogs | null>(null)
  const [modelPick, setModelPick] = useState<{ key: string; value: string } | null>(null)
  const [namingInfo, setNamingInfo] = useState<SessionNamingResponse | null>(null)
  /** Set while a model names the session; pressing create again skips the wait. */
  const namingRef = useRef<AbortController | null>(null)
  /** Set when the form goes away mid-naming (the dialog closed): the session is then not created. */
  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      namingRef.current?.abort()
    }
  }, [])
  const [namingWith, setNamingWith] = useState<string | null>(null)
  /** null follows whether something needs attention; true/false is the user's own choice. */
  const [workspaceChoice, setWorkspaceChoice] = useState<boolean | null>(null)
  const [dragging, setDragging] = useState(false)
  const [viewing, setViewing] = useState<ViewableImage | null>(null)
  const [partialCreation, setPartialCreation] = useState<{ response: TmuxCreateResponse; groupId: string } | null>(null)
  const partialCreationRef = useRef<TmuxCreateResponse | null>(null)
  const openingPartialCreationRef = useRef(false)
  const [probing, setProbing] = useState(false)
  const [probeTimedOut, setProbeTimedOut] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const probeVersion = useRef(0)
  const probeRepoRef = useRef(probeRepo)
  probeRepoRef.current = probeRepo
  const attachments = useOpeningAttachments(uploads ?? defaultUploads(token))
  const availableDirectories = [
    ...groupDirectorySuggestions,
    ...workingDirectoryHistory.filter((directory) => !groupDirectorySuggestions.includes(directory)),
  ]
  const directoryQuery = directoryHistoryFiltering ? workingDirectory.toLowerCase() : ''
  const directorySuggestions = availableDirectories.filter(
    (directory) => directoryQuery === '' || directory.toLowerCase().includes(directoryQuery),
  )
  const activeDirectoryHighlight = Math.min(
    directoryHistoryHighlight,
    Math.max(0, directorySuggestions.length - 1),
  )
  const repo = repoProbe && repoProbe.directory === workingDirectory && repoProbe.info.isRepo && repoProbe.info.mainRoot
    ? repoProbe.info
    : null
  const unavailable = disabled || pending || namingWith !== null || (probing && !repo)
  const notRepo = Boolean(probeRepo && workingDirectory && repoProbe && repoProbe.directory === workingDirectory && !repoProbe.info.isRepo)
  const promptAccepted = takesPrompt(agentProvider)
  const imagesAccepted = takesImages(agentProvider)
  const promptGiven = promptAccepted && (openingPrompt.trim() !== '' || (imagesAccepted && attachments.attachments.length > 0))
  // With a prompt the name may be left out: the daemon names the session (and its branch) from it.
  const autoName = !sessionName.trim() && promptGiven
  const effectiveBranch = branchEdited ? branch : sanitizeBranchName(sessionName)
  const previewWorktreePath = worktreePath ?? (repo?.mainRoot ? defaultWorktreePath(repo.mainRoot, effectiveBranch || '<branch>') : '')
  const worktreeRequested = Boolean(repo && worktreeEnabled)
  const prepareRequested = prepareEnabled && Boolean(prepareCommand.trim())
  const workspaceOpen = workspaceChoice ?? (notRepo || probeTimedOut)

  useEffect(() => { syncStoredPrepareCommands(token) }, [token])

  useEffect(() => {
    const root = repo?.mainRoot
    const commands = loadWorktreePrepareCommands()
    setPrepareCommand(root ? commands[root] ?? '' : '')
    if (!root || Object.hasOwn(commands, root) || (sessionCreateRequest?.repo && root !== sessionCreateRequest.repo.root)) return
    let cancelled = false
    const version = prepareEditVersion.current
    void createAgentChatsApi(token).getPrepareCommand(root).then(
      (command) => { if (!cancelled && version === prepareEditVersion.current) setPrepareCommand(command) },
      (cause: unknown) => console.warn('Unable to load repository prepare command', cause),
    )
    return () => { cancelled = true }
  }, [repo?.mainRoot, sessionCreateRequest?.id, openVersion, token])

  // The starting agent is remembered per repository; each chat provider keeps its own settings.
  const repoKey = repo?.mainRoot ?? (workingDirectory.trim() || undefined)
  const preferenceProvider = isChatLaunchProvider(agentProvider) ? agentProvider : 'claude-chat'
  useEffect(() => {
    setAgentProvider(loadStartWith(repoKey))
    setClaudeProfile(loadChatLaunch(repoKey).configDir)
    // A model picked for one repository is not a choice for the next.
    setModelPick(null)
  }, [repoKey])
  useEffect(() => {
    setChatLaunch(loadChatLaunch(repoKey, preferenceProvider))
  }, [repoKey, preferenceProvider])

  // Profiles name the Claude rows of the Agent menu, so they load straight away.
  useEffect(() => {
    if (claudeProfiles || !loadClaudeProfiles) return
    let cancelled = false
    void loadClaudeProfiles().then(
      (profiles) => { if (!cancelled) setClaudeProfiles(profiles) },
      (cause: unknown) => {
        console.warn('Unable to load Claude profiles; starting Claude on the remembered or default one', cause)
        if (!cancelled) setClaudeProfiles([])
      },
    )
    // A failed load leaves an empty list; the remembered profile (else the daemon's default) is used.
    return () => { cancelled = true }
  }, [claudeProfiles, loadClaudeProfiles])
  // The parent may pass a new function each render; refetch only when the form (re)opens.
  const loadModelCatalogsRef = useRef(loadModelCatalogs)
  loadModelCatalogsRef.current = loadModelCatalogs
  const namingRefApi = useRef(naming)
  namingRefApi.current = naming
  useEffect(() => {
    const api = namingRefApi.current
    if (!api) return
    let cancelled = false
    void api.describe().then(
      (info) => { if (!cancelled) setNamingInfo(info) },
      (cause: unknown) => console.warn('Unable to load session naming settings', cause),
    )
    return () => { cancelled = true }
  }, [openVersion, sessionCreateRequest?.id])
  useEffect(() => {
    const load = loadModelCatalogsRef.current
    if (!load) return
    let cancelled = false
    void load().then(
      (catalogs) => { if (!cancelled) setModelCatalogs(catalogs) },
      (cause: unknown) => {
        console.warn('Unable to load model lists; offering the default model', cause)
        if (!cancelled) setModelCatalogs((current) => current ?? {})
      },
    )
    return () => { cancelled = true }
  }, [openVersion, sessionCreateRequest?.id])
  // Wait for the profile list so Claude never starts on the wrong login by accident.
  const chatProfilesLoading = usesClaudeProfile(agentProvider) && Boolean(loadClaudeProfiles) && claudeProfiles === null
  // Keep a remembered profile even when the list could not be loaded this time.
  const claudeConfigDir = claudeProfiles?.length ? chatProfileConfigDir(claudeProfile, claudeProfiles) : claudeProfile
  const chatProvider = modelProvider(agentProvider)
  const catalogKey = chatProvider ? modelCatalogKey(chatProvider, chatProvider === 'claude' ? claudeConfigDir : undefined) : null
  const modelEntry = modelCatalogFor(modelCatalogs, agentProvider, claudeConfigDir)
  const models = chatProvider ? modelChoices(modelEntry) : []
  const wantedModel = catalogKey && modelPick?.key === catalogKey ? modelPick.value : catalogKey ? loadModelChoice(repoKey, catalogKey) : undefined
  // A remembered model is kept while its list is unknown (not loaded, or never seen for this profile).
  const listKnown = Boolean(modelEntry)
  const selectedModel = models.find((model) => model.value === wantedModel)?.value
    ?? (!listKnown && wantedModel ? wantedModel : models[0]?.value ?? 'default')
  const modelChoicesShown = !listKnown && wantedModel && !models.some((model) => model.value === wantedModel)
    ? [...models, { value: wantedModel, displayName: wantedModel }]
    : models
  const permissionModes = isChatLaunchProvider(agentProvider) ? chatPermissionModes(agentProvider) : []
  // Who will name the session: the naming model while it works here, else the chat's own (Claude or Codex).
  const chatModelLabel = chatProvider === 'claude' || chatProvider === 'codex'
    ? (selectedModel === 'default' ? (chatProvider === 'claude' ? 'Claude' : 'Codex') : models.find((model) => model.value === selectedModel)?.displayName ?? selectedModel)
    : null
  const namingLabel = !naming ? null
    : namingInfo?.settings.mode !== 'chat-model' && namingInfo?.status.state === 'available' ? namingInfo.label
      : chatModelLabel
  const options = agentOptions(claudeProfiles)

  useEffect(() => {
    if (!sessionCreateRequest) return
    setSessionGroupId(sessionCreateRequest.groupId)
    setSessionGroupName(sessionCreateRequest.groupName)
    setSessionRepo(sessionCreateRequest.repo ?? null)
    setRepoProbe(knownRepoProbe(sessionCreateRequest))
    setGroupDirectorySuggestions(sessionCreateRequest.suggestedDirectories)
    setWorkingDirectory(sessionCreateRequest.repo?.root ?? sessionCreateRequest.suggestedDirectories[0] ?? workingDirectoryHistory[0] ?? '')
    setDirectoryHistoryFiltering(false)
    setDirectoryHistoryHighlight(0)
    setWorktreeEnabled(true)
    setPrepareEnabled(true)
    setOpeningPrompt('')
    setBranchEdited(false)
    setWorktreePath(null)
    setWorkspaceChoice(null)
    setError('')
    setStatus('')
  }, [sessionCreateRequest])

  useEffect(() => {
    if (!sessionCreateRequest) return
    if (detailsRef.current) {
      detailsRef.current.open = true
      detailsRef.current.scrollIntoView?.({ block: 'nearest' })
    }
    ;(promptRef.current ?? sessionNameRef.current)?.focus()
  }, [sessionCreateRequest])

  useEffect(() => {
    const probe = probeRepoRef.current
    if (!probe || !workingDirectory.startsWith('/')) {
      probeVersion.current += 1
      setProbing(false)
      setProbeTimedOut(false)
      return
    }
    const version = ++probeVersion.current
    setProbing(true)
    setProbeTimedOut(false)
    let timeout: number | undefined
    const timer = window.setTimeout(() => {
      timeout = window.setTimeout(() => {
        if (version === probeVersion.current) {
          setProbing(false)
          setProbeTimedOut(true)
        }
      }, REPO_PROBE_TIMEOUT_MS)
      probe(workingDirectory)
        .then((info) => {
          if (version === probeVersion.current) {
            setRepoProbe({ directory: workingDirectory, info })
            setProbing(false)
            setProbeTimedOut(false)
          }
        })
        .catch(() => {
          if (version === probeVersion.current) {
            setRepoProbe({ directory: workingDirectory, info: { isRepo: false } })
            setProbing(false)
            setProbeTimedOut(false)
          }
        })
        .finally(() => window.clearTimeout(timeout))
    }, sessionCreateRequest && workingDirectory === (sessionCreateRequest.repo?.root ?? sessionCreateRequest.suggestedDirectories[0]) ? 0 : REPO_PROBE_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(timeout)
    }
  }, [Boolean(probeRepo), workingDirectory, sessionCreateRequest?.id])

  useEffect(() => {
    onPendingChange?.(pending)
  }, [onPendingChange, pending])

  const chooseWorkingDirectory = (directory: string) => {
    setWorkingDirectory(directory)
    setWorktreePath(null)
    setDirectoryHistoryOpen(false)
    setDirectoryHistoryFiltering(false)
  }

  const onWorkingDirectoryKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!directoryHistoryOpen) {
        setDirectoryHistoryOpen(true)
        return
      }
      if (!directorySuggestions.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setDirectoryHistoryHighlight(
        (activeDirectoryHighlight + step + directorySuggestions.length) % directorySuggestions.length,
      )
    } else if (event.key === 'Enter' && directoryHistoryOpen && directorySuggestions.length) {
      event.preventDefault()
      chooseWorkingDirectory(directorySuggestions[activeDirectoryHighlight])
    } else if (event.key === 'Escape' && directoryHistoryOpen) {
      event.preventDefault()
      event.stopPropagation()
      setDirectoryHistoryOpen(false)
    }
  }

  const pickAgent = (option: AgentOption) => {
    setAgentProvider(option.provider)
    if (option.configDir) setClaudeProfile(option.configDir)
  }

  const resetForm = (formElement: HTMLFormElement) => {
    formElement.reset()
    setSessionName('')
    setWindowName('')
    setOpeningPrompt('')
    attachments.clear()
    setBranch('')
    setBranchEdited(false)
    setWorktreePath(null)
    setPrepareEnabled(true)
  }

  const openPartialCreation = async (formElement: HTMLFormElement | null) => {
    if (!formElement || !onCreated || !partialCreation || !partialCreationRef.current || openingPartialCreationRef.current) return
    openingPartialCreationRef.current = true
    setPending(true)
    try {
      await onCreated(partialCreation.response.created, partialCreation.groupId, partialCreation.response.worktree)
      partialCreationRef.current = null
      setPartialCreation(null)
      setError('')
      setStatus('')
      resetForm(formElement)
    } catch (openError) {
      setError(errorMessage(openError))
    } finally {
      openingPartialCreationRef.current = false
      setPending(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // Pressed again while a model names the session: skip the wait.
    if (namingRef.current) {
      namingRef.current.abort()
      return
    }
    // ⌘↵ submits without the button, so its disabled state is checked here too.
    if (partialCreationRef.current || attachments.uploading || unavailable || chatProfilesLoading) return
    const formElement = event.currentTarget
    setError('')
    setStatus('')
    let nameHint = ''
    if (autoName && naming) {
      const controller = new AbortController()
      namingRef.current = controller
      // The prompt is about to be disabled; keep focus in the form so ⌘↵ can skip.
      submitRef.current?.focus()
      setNamingWith(namingLabel)
      try {
        nameHint = (await naming.suggest({
          prompt: openingPrompt,
          ...(imagesAccepted && attachments.refs.length ? { images: attachments.refs } : {}),
          ...(chatProvider ? { chat: { provider: chatProvider, ...(chatProvider === 'claude' && claudeConfigDir ? { configDir: claudeConfigDir } : {}), ...(selectedModel !== 'default' ? { model: selectedModel } : {}) } } : {}),
        }, controller.signal)).name ?? ''
      } catch (cause) {
        // Skipped, or the daemon couldn't name it: the daemon falls back to the prompt's first words.
        if (!controller.signal.aborted) console.warn('Unable to name the session', cause)
      } finally {
        namingRef.current = null
        if (!unmountedRef.current) setNamingWith(null)
      }
      if (unmountedRef.current) return
    }
    setPending(true)
    try {
      const cwd = workingDirectory
      const request: CreateTmuxSessionRequest = { name: autoName ? nameHint : sessionName, windowName, cwd, ...(autoName ? { autoName: true } : {}) }
      if (agentProvider === 'none') {
        request.empty = true
      } else if (agentProvider !== 'shell') {
        const model = chatProvider && selectedModel !== 'default' ? selectedModel : undefined
        request.agent = {
          provider: agentProvider,
          ...(promptAccepted && openingPrompt.trim() ? { prompt: openingPrompt } : {}),
          ...(imagesAccepted && attachments.refs.length ? { images: attachments.refs } : {}),
          ...(model ? { model } : {}),
          ...(agentProvider === 'codex-chat' || agentProvider === 'muse-chat' || agentProvider === 'cursor-chat' ? chatLaunchPermission(agentProvider, chatLaunch.permissionMode) : {}),
          ...(agentProvider === 'claude-chat' ? { permissionMode: chatLaunch.permissionMode } : {}),
          ...(usesClaudeProfile(agentProvider) && claudeConfigDir ? { configDir: claudeConfigDir } : {}),
        }
        if (agentProvider === 'codex-chat' || agentProvider === 'muse-chat' || agentProvider === 'cursor-chat') saveChatLaunch(repoKey, { permissionMode: chatLaunch.permissionMode }, agentProvider)
        if (usesClaudeProfile(agentProvider)) {
          // Keep a remembered profile even when the list could not be loaded this time.
          const remembered = agentProvider === 'claude-chat' ? chatLaunch : loadChatLaunch(repoKey)
          saveChatLaunch(repoKey, { ...(claudeConfigDir ? { configDir: claudeConfigDir } : {}), permissionMode: remembered.permissionMode })
        }
        // Only what was picked here is remembered, never a fallback to the default.
        if (catalogKey && modelPick?.key === catalogKey) saveModelChoice(repoKey, catalogKey, selectedModel)
      }
      if (worktreeRequested) {
        request.worktree = {
          // Left empty for an auto-named session: the daemon names the branch after it.
          branch: autoName && !branchEdited ? '' : effectiveBranch,
          ...(worktreePath ? { path: worktreePath } : {}),
          ...(prepareRequested ? { prepareCommand } : {}),
        }
      }
      if (repo?.mainRoot) {
        saveWorktreePrepareCommand(repo.mainRoot, prepareCommand)
        void createAgentChatsApi(token).setPrepareCommand(repo.mainRoot, prepareCommand.trim() ? prepareCommand : '')
          .catch((cause: unknown) => console.warn('Unable to sync repository prepare command', cause))
      }
      const result = requireSessionAgentLaunch(request, await onCreateSession(request))
      saveStartWith(repoKey, agentProvider)
      const nextHistory = saveWorkingDirectoryHistory(cwd, workingDirectoryHistory)
      setWorkingDirectoryHistory(nextHistory)
      setDirectoryHistoryOpen(false)
      const { created, worktree } = result
      setStatus(worktree
        ? `Created session ${created.paneId} in ${created.sessionName} on branch ${worktree.branch} at ${worktree.path}${prepareRequested ? '. Preparation started in the new pane' : ''}${worktree.warning ? `. ${worktree.warning}` : ''}`
        : `Created session ${created.paneId} in ${created.sessionName}`)
      onCreated?.(created, sessionGroupId, worktree)
      resetForm(formElement)
    } catch (submitError) {
      if (submitError instanceof TmuxAgentLaunchCompatibilityError) {
        partialCreationRef.current = submitError.response
        setPartialCreation({ response: submitError.response, groupId: sessionGroupId })
      }
      setError(errorMessage(submitError))
    } finally {
      setPending(false)
    }
  }

  // ⌘V anywhere in the form attaches images to the prompt; text pastes as usual.
  const onPaste = (event: ClipboardEvent<HTMLFormElement>) => {
    const files = [...event.clipboardData.files].filter(isAttachableFile)
    if (!files.length || !promptAccepted || unavailable) return
    event.preventDefault()
    attachments.add(files)
  }
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (unavailable || !promptAccepted || !hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (unavailable || !promptAccepted || !hasFiles(event)) return
    event.preventDefault()
    setDragging(false)
    attachments.add([...event.dataTransfer.files])
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    if (event.repeat) return
    formRef.current?.requestSubmit()
  }

  const destination = variant === 'dialog' ? null : sessionRepo
    ? <p className="tmux-create__destination">Repository <strong>{sessionRepo.name}</strong></p>
    : sessionGroupId !== 'ungrouped'
      ? <p className="tmux-create__destination">Session group <strong>{sessionGroupName}</strong></p>
      : null

  const noPromptText = agentProvider === 'none'
    ? 'Just the tmux session: nothing starts in it.'
    : agentProvider === 'shell' ? 'A shell starts without an opening prompt.' : 'OpenCode starts without an opening prompt.'
  const promptBox = (
    <div
      className={`tmux-create__prompt${dragging ? ' is-dragging' : ''}${promptAccepted ? '' : ' is-off'}`}
      onDragOver={onDragOver}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
      onDrop={onDrop}
    >
      {promptAccepted && attachments.attachments.length ? (
        <div className="tmux-create__attachments" aria-label="Attachments">
          {attachments.attachments.map((attachment) => (
            <Thumbnail
              key={attachment.key}
              size="sm"
              src={attachment.previewUrl}
              name={attachment.name}
              busy={!attachment.ref}
              video={attachment.video}
              onOpen={() => setViewing({ src: attachment.previewUrl, name: attachment.name, video: attachment.video })}
              onRemove={() => attachments.remove(attachment.key)}
            />
          ))}
        </div>
      ) : null}
      {promptAccepted ? (
        <textarea
          ref={promptRef}
          name="openingPrompt"
          aria-label="Opening prompt"
          value={openingPrompt}
          onChange={(event) => setOpeningPrompt(event.target.value)}
          disabled={unavailable}
          rows={attachments.attachments.length ? 2 : 4}
          placeholder={imagesAccepted ? 'Paste a screenshot or describe the task…' : 'Describe the task…'}
        />
      ) : <p className="tmux-create__no-prompt">{noPromptText}</p>}
      {promptAccepted && attachments.attachments.length && !imagesAccepted ? (
        <p className="tmux-create__message is-warning" role="status">Only chats are sent images; pick a chat to include them.</p>
      ) : null}
      {attachments.error ? (
        <p className="tmux-create__message is-error" role="alert">
          {attachments.error} <button type="button" className="tmux-create__link" onClick={attachments.dismissError}>Dismiss</button>
        </p>
      ) : null}
      <div className="tmux-create__prompt-bar">
        {imagesAccepted ? (
          <>
            <button type="button" className="tmux-create__icon-button" aria-label="Attach images or videos" title="Attach images or videos (or paste / drop them)" disabled={unavailable} onClick={() => fileInputRef.current?.click()}>
              <Paperclip aria-hidden="true" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm,.mov,.mp4,.m4v,.webm"
              multiple
              hidden
              data-testid="new-session-image-input"
              onChange={(event) => {
                attachments.add([...(event.target.files ?? [])])
                event.target.value = ''
              }}
            />
          </>
        ) : null}
        <AgentPicker options={options} provider={agentProvider} configDir={claudeConfigDir} disabled={unavailable} onPick={pickAgent} />
        {chatProvider ? (
          <NewSessionModelPicker
            models={modelChoicesShown}
            selected={selectedModel}
            updatedAt={modelEntry?.updatedAt}
            disabled={unavailable}
            onPick={(value) => { if (catalogKey) setModelPick({ key: catalogKey, value }) }}
          />
        ) : null}
        {permissionModes.length ? (
          <NewSessionPermissionPicker
            modes={permissionModes}
            selected={chatLaunch.permissionMode}
            disabled={unavailable}
            onPick={(permissionMode) => setChatLaunch((current) => ({ ...current, permissionMode }))}
          />
        ) : null}
      </div>
    </div>
  )

  const worktreeBlock = repo ? (
    <div className="tmux-create__worktree">
      <label className="tmux-create__toggle">
        <input
          type="checkbox"
          name="worktree"
          checked={worktreeEnabled}
          disabled={unavailable}
          onChange={(event) => setWorktreeEnabled(event.target.checked)}
        />
        Create a worktree and branch for this session
      </label>
      {worktreeEnabled ? (
        <>
          <label>
            Branch <span>from session name, editable</span>
            <input
              name="branch"
              value={effectiveBranch}
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              disabled={unavailable}
              placeholder={autoName ? 'Named after the session' : undefined}
              onChange={(event) => {
                setBranchEdited(true)
                setBranch(event.target.value)
              }}
            />
          </label>
          <div className="tmux-create__worktree-preview">
            {worktreePath === null ? (
              <div>
                <b>Worktree</b>
                <code>{previewWorktreePath}</code>
                <button
                  type="button"
                  className="tmux-create__link"
                  disabled={unavailable}
                  onClick={() => setWorktreePath(previewWorktreePath)}
                  aria-label="Edit worktree path"
                >
                  edit
                </button>
              </div>
            ) : (
              <label>
                Worktree path
                <input
                  name="worktreePath"
                  value={worktreePath}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={unavailable}
                  onChange={(event) => setWorktreePath(event.target.value)}
                />
              </label>
            )}
            <div>
              <b>From</b>
              <code>{repo.defaultBranch ? `${repo.remote ?? 'origin'}/${repo.defaultBranch}` : 'HEAD'}</code>
              <span>{repo.defaultBranch ? ' · fetched before branching' : ' · no remote default branch'}</span>
            </div>
          </div>
          <label>
            Prepare worktree <span>optional, saved for {repo.name ?? 'this repository'}</span>
            <textarea
              name="prepareCommand"
              value={prepareCommand}
              rows={3}
              maxLength={8_192}
              autoComplete="off"
              spellCheck={false}
              disabled={unavailable}
              placeholder="pnpm i"
              onChange={(event) => {
                const command = event.target.value
                prepareEditVersion.current += 1
                setPrepareCommand(command)
                if (repo.mainRoot) {
                  saveWorktreePrepareCommand(repo.mainRoot, command)
                  void createAgentChatsApi(token).setPrepareCommand(repo.mainRoot, command.trim() ? command : '')
                    .catch((cause: unknown) => console.warn('Unable to sync repository prepare command', cause))
                }
              }}
            />
          </label>
          <label className="tmux-create__toggle tmux-create__prepare-toggle">
            <input
              type="checkbox"
              name="prepareEnabled"
              checked={prepareEnabled}
              disabled={unavailable}
              onChange={(event) => setPrepareEnabled(event.target.checked)}
            />
            Run preparation command for this session
          </label>
        </>
      ) : null}
    </div>
  ) : notRepo ? (
    <p className="tmux-create__message is-warning">
      Not a git repository: the session opens in this folder without a worktree.
    </p>
  ) : null

  const place = workingDirectory ? <code>{shortPath(workingDirectory)}</code> : 'the default folder'
  let workspaceSummary: ReactNode
  if (probing && !repo) workspaceSummary = <>Checking {place}…</>
  else if (notRepo) workspaceSummary = <>In {place} · <b className="is-warning">not a git repo</b></>
  else if (probeTimedOut && !repo) workspaceSummary = <>In {place} · <b className="is-warning">repository check timed out</b></>
  else if (worktreeRequested && repo) {
    const base = repo.defaultBranch ? `${repo.remote ?? 'origin'}/${repo.defaultBranch}` : 'HEAD'
    const branchLabel = effectiveBranch || (autoName ? 'named from the prompt' : 'named after the session')
    workspaceSummary = <>New worktree <b>{branchLabel}</b> · {base}{prepareRequested ? <> · <code>{firstLine(prepareCommand)}</code></> : null}</>
  } else workspaceSummary = <>In {place}{repo ? ' · no worktree' : ''}</>

  const workspace = (
    <div className={`tmux-create__workspace${workspaceOpen ? ' is-open' : ''}`}>
      <button
        type="button"
        className="tmux-create__workspace-summary"
        aria-expanded={workspaceOpen}
        aria-controls={`tmux-create-workspace-${variant}`}
        onClick={() => setWorkspaceChoice(!workspaceOpen)}
      >
        <GitBranch aria-hidden="true" />
        <span>{workspaceSummary}</span>
        <ChevronRight aria-hidden="true" className="tmux-create__chevron" />
      </button>
      <div className="tmux-create__workspace-body" id={`tmux-create-workspace-${variant}`} hidden={!workspaceOpen}>
        <div className="tmux-create__field">
          <label htmlFor={`tmux-create-cwd-${variant}`}>
            Working directory <span>optional, absolute path</span>
          </label>
          <div className="tmux-create__cwd-combo">
            <input
              id={`tmux-create-cwd-${variant}`}
              name="cwd"
              value={workingDirectory}
              onChange={(event) => {
                setWorkingDirectory(event.target.value)
                setWorktreePath(null)
                setDirectoryHistoryOpen(true)
                setDirectoryHistoryFiltering(true)
                setDirectoryHistoryHighlight(0)
              }}
              onKeyDown={onWorkingDirectoryKeyDown}
              onFocus={() => {
                setDirectoryHistoryOpen(true)
                setDirectoryHistoryFiltering(false)
                setDirectoryHistoryHighlight(0)
              }}
              onClick={() => {
                setDirectoryHistoryOpen(true)
                setDirectoryHistoryFiltering(false)
                setDirectoryHistoryHighlight(0)
              }}
              onBlur={() => setDirectoryHistoryOpen(false)}
              placeholder="/Users/me/project"
              autoComplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={directoryHistoryOpen && directorySuggestions.length > 0}
              aria-controls={`tmux-create-cwd-history-${variant}`}
              aria-activedescendant={
                directoryHistoryOpen && directorySuggestions.length > 0
                  ? `tmux-create-cwd-option-${activeDirectoryHighlight}`
                  : undefined
              }
              spellCheck={false}
            />
            {directoryHistoryOpen && directorySuggestions.length > 0 ? (
              <div
                className="tmux-create__cwd-history"
                id={`tmux-create-cwd-history-${variant}`}
                role="listbox"
                aria-label="Suggested working directories"
              >
                {directorySuggestions.map((directory, index) => (
                  <button
                    key={directory}
                    id={`tmux-create-cwd-option-${index}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={directory === workingDirectory}
                    className={index === activeDirectoryHighlight ? 'is-highlighted' : undefined}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      chooseWorkingDirectory(directory)
                    }}
                    onMouseEnter={() => setDirectoryHistoryHighlight(index)}
                  >
                    {directory}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        {worktreeBlock}
        {probeTimedOut && (
          <p className="tmux-create__message is-warning" role="status">
            Repository check timed out. You can still create a session, but worktree details may be unavailable.
          </p>
        )}
        <label>
          Initial window name <span>optional</span>
          <input name="windowName" maxLength={128} autoComplete="off" value={windowName} onChange={(event) => setWindowName(event.target.value)} />
        </label>
      </div>
    </div>
  )

  const chatStart = isChatLaunchProvider(agentProvider)
  const submitLabel = namingWith ? `Naming with ${namingWith}...` : pending
    ? partialCreation ? 'Opening...' : 'Creating...'
    : probing && !repo ? 'Checking repository...'
      : attachments.uploading ? 'Uploading images...'
        : chatStart ? 'Start chat' : 'Create session'

  const panel = (
    <div className="tmux-create__panel">
      <form ref={formRef} onSubmit={submit} onPaste={onPaste} onKeyDown={onKeyDown} aria-busy={pending}>
        {destination}
        {promptBox}
        <label>
          Session name <span>{promptGiven ? 'optional' : promptAccepted ? 'required without a prompt' : ''}</span>
          <input
            ref={sessionNameRef}
            aria-label="Session name"
            name="sessionName"
            required={!autoName}
            maxLength={128}
            autoComplete="off"
            value={sessionName}
            placeholder={promptGiven ? (namingLabel ? `Auto · named by ${namingLabel}` : 'Named from the prompt') : undefined}
            onChange={(event) => setSessionName(event.target.value)}
          />
        </label>
        {workspace}

        {error && (
          <p className="tmux-create__message is-error" role="alert">
            {error}
          </p>
        )}
        {status && (
          <p className="tmux-create__message" role="status">
            {status}
          </p>
        )}

        {partialCreation ? (
          <button className="tmux-create__submit" type="button" disabled={!onCreated || pending} onClick={(event) => {
            void openPartialCreation(event.currentTarget.form)
          }}>
            Open created session {partialCreation.response.created.paneId}
          </button>
        ) : null}
        <button ref={submitRef} className="tmux-create__submit" type="submit" disabled={(unavailable && !namingWith) || Boolean(partialCreation) || chatProfilesLoading || attachments.uploading}>
          {submitLabel}
          {namingWith ? <kbd aria-hidden="true">⌘↵ to skip</kbd> : pending || attachments.uploading ? null : <kbd aria-hidden="true">⌘↵</kbd>}
        </button>
      </form>
      <ImageViewer image={viewing} onClose={() => setViewing(null)} />
    </div>
  )

  if (variant === 'dialog') {
    return <div className="tmux-create tmux-create--dialog">{panel}</div>
  }

  return (
    <details
      className="tmux-create"
      ref={detailsRef}
      onToggle={(event) => {
        if (event.currentTarget.open) {
          // This form stays mounted, so pick up choices remembered by the dialog meanwhile.
          setOpenVersion((value) => value + 1)
          const startWith = loadStartWith(repoKey)
          setAgentProvider(startWith)
          setClaudeProfile(loadChatLaunch(repoKey).configDir)
          setChatLaunch(loadChatLaunch(repoKey, isChatLaunchProvider(startWith) ? startWith : 'claude-chat'))
          return
        }
        if (sessionGroupId !== 'ungrouped') setWorkingDirectory(workingDirectoryHistory[0] ?? '')
        setSessionGroupId('ungrouped')
        setSessionGroupName('Ungrouped')
        setSessionRepo(null)
        setGroupDirectorySuggestions([])
      }}
    >
      <summary>{sessionGroupId === 'ungrouped' ? 'New session' : `New session in ${sessionGroupName}`}</summary>
      {panel}
    </details>
  )
}
