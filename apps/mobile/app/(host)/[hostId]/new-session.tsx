import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router'
import Feather from '@expo/vector-icons/Feather'
import * as Haptics from 'expo-haptics'
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { MAX_CHAT_IMAGES } from '@commando/agent-chat'
import type { ChatLaunchProvider, ChatPermissionMode, ClaudeProfile, GitRepoInfo, ModelCatalogs, TmuxCreatedTarget } from '@commando/tmux-create'
import {
  chatPermissionModes,
  chatProfileConfigDir,
  claudeProfileLabel,
  isChatLaunchProvider,
  modelCatalogFor,
  modelCatalogKey,
  modelChoices,
  modelProvider,
  requireSessionAgentLaunch,
  TmuxAgentLaunchCompatibilityError,
} from '@commando/tmux-create'

import { AttachmentStrip, pickFromSheet, useAttachmentUploads } from '../../../src/chat/attachments'
import { pastedImage, useClipboardImage, type ClipboardImageData } from '../../../src/chat/clipboard'
import { IconButton, Pill, showSheet } from '../../../src/chat/ComposerParts'
import { PasteImageBar } from '../../../src/chat/PasteImageBar'
import { createTmuxSession, fetchClaudeProfiles, fetchModelCatalogs, fetchRepoInfo } from '../../../src/daemon/paneApi'
import { useDaemonConnection } from '../../../src/daemon/useDaemonConnection'
import {
  AGENT_CHOICES,
  DEFAULT_AGENT_CHOICE,
  baseLabel,
  buildSessionRequest,
  defaultPermission,
  effectiveBranch,
  previewWorktreePath,
  repoOptions,
  takesImages,
  usesClaudeProfile,
  type AgentChoice,
  type RepoOption,
} from '../../../src/create/model'
import {
  loadDirectoryHistory,
  loadLaunchStore,
  loadPrepareCommands,
  rememberDirectory,
  rememberLaunch,
  rememberPrepareCommand,
  resolveLaunch,
  type LaunchStore,
} from '../../../src/create/prefs'
import { useHostsStore } from '../../../src/hosts/store'
import { toggleMutedSession, usePushStore } from '../../../src/notifications'
import { useTheme } from '../../../src/theme'
import { CreateSheet } from '../../../src/ui/CreateSheet'
import { FormError, RowGroup, TextRow, ToggleRow, ValueRow } from '../../../src/ui/formPrimitives'
import { Meta, SectionHeader } from '../../../src/ui/primitives'
import { routeParams } from '../../../src/layout/routeParams'

const REPO_PROBE_DEBOUNCE_MS = 200

/**
 * Screen 07. A single creation request starts the selected CLI in the new
 * pane's PTY, after worktree preparation, and returns that owned target.
 *
 * The screen is a hidden tab, so it stays mounted between visits: a `repo`
 * param (from a repository's "+" in the chat list) re-points it, `at` makes
 * the same repository count as a new request, and a finished create resets it.
 */
export default function NewSessionScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const focused = useIsFocused()
  const { hostId, repo: repoParam, at: requestedAt } = useLocalSearchParams<{ hostId: string; repo?: string; at?: string }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const state = useDaemonConnection(host)

  const [name, setName] = useState('')
  const [directory, setDirectory] = useState(repoParam ?? '')
  const [directoryHistory, setDirectoryHistory] = useState<string[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [prepareByRepo, setPrepareByRepo] = useState<Record<string, string>>({})
  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [repo, setRepo] = useState<GitRepoInfo | null>(null)
  const [worktreeEnabled, setWorktreeEnabled] = useState(true)
  const [branchEdit, setBranchEdit] = useState<string | null>(null)
  const [pathEdit, setPathEdit] = useState<string | null>(null)
  const [prepareCommand, setPrepareCommand] = useState('')
  const [prepareEnabled, setPrepareEnabled] = useState(true)
  /** How sessions were last started here and anywhere; null until read from the device. */
  const [launchStore, setLaunchStore] = useState<LaunchStore | null>(null)
  const [agent, setAgent] = useState<AgentChoice>(DEFAULT_AGENT_CHOICE)
  const [permissions, setPermissions] = useState<Partial<Record<ChatLaunchProvider, ChatPermissionMode>>>({})
  // The Claude profiles the daemon offers; the remembered one, else the default (as in Settings).
  const [profiles, setProfiles] = useState<ClaudeProfile[] | null>(null)
  const [profilePick, setProfilePick] = useState<string | undefined>(undefined)
  const [catalogs, setCatalogs] = useState<ModelCatalogs | null>(null)
  /** A model picked here, for the catalog it was picked from. */
  const [modelPick, setModelPick] = useState<{ key: string; value: string } | null>(null)
  const [fastPick, setFastPick] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [notify, setNotify] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)
  const uploads = useAttachmentUploads(host, setAttachError)
  const probeVersion = useRef(0)
  const createdTarget = useRef<TmuxCreatedTarget | null>(null)
  const attachButton = useRef<View>(null)
  const modelRef = useRef<View>(null)
  const permissionRef = useRef<View>(null)
  const profileRef = useRef<View>(null)

  const repos = useMemo(
    () => repoOptions(state.snapshot, directoryHistory),
    [state.snapshot, directoryHistory],
  )
  const branch = effectiveBranch(name, branchEdit)
  const defaultPath = previewWorktreePath(repo, branch)
  const worktreePath = pathEdit ?? defaultPath
  const isRepo = Boolean(repo?.isRepo && repo.mainRoot)
  const selectedRepo = repos.find((option) => option.root === directory)

  // The starting agent and its settings are remembered per repository (else from the last session).
  const repoKey = repo?.mainRoot ?? (directory.trim() || undefined)
  const launch = useMemo(() => (launchStore ? resolveLaunch(launchStore, repoKey) : {}), [launchStore, repoKey])
  const chat = isChatLaunchProvider(agent) ? agent : null
  const permissionMode = chat ? defaultPermission(chat, permissions[chat]) : 'default'
  const configDir = usesClaudeProfile(agent)
    ? (profiles?.length ? chatProfileConfigDir(profilePick, profiles) : profilePick)
    : undefined
  const chatProvider = modelProvider(agent)
  const catalogKey = chatProvider ? modelCatalogKey(chatProvider, chatProvider === 'claude' ? configDir : undefined) : null
  const modelEntry = modelCatalogFor(catalogs, agent, configDir)
  const models = chatProvider ? modelChoices(modelEntry) : []
  const wantedModel = catalogKey && modelPick?.key === catalogKey ? modelPick.value : catalogKey ? launch.models?.[catalogKey] : undefined
  // A remembered model is kept while its list is unknown (not loaded, or never seen for this profile).
  const listKnown = Boolean(modelEntry)
  const shownModels = !listKnown && wantedModel && !models.some((model) => model.value === wantedModel)
    ? [...models, { value: wantedModel, displayName: wantedModel }]
    : models
  const selectedModel = shownModels.find((model) => model.value === wantedModel)?.value ?? models[0]?.value ?? 'default'
  const selectedModelOption = shownModels.find((model) => model.value === selectedModel)
  // Only chats take fast mode, on a model that offers it.
  const fastAvailable = Boolean(chat && selectedModelOption?.supportsFast)
  const fast = fastAvailable && fastPick
  const imagesAccepted = takesImages(agent)
  const promptAccepted = agent !== 'shell' && agent !== 'opencode'

  useEffect(() => {
    void loadDirectoryHistory()
      .then(setDirectoryHistory, () => undefined)
      .finally(() => setHistoryLoaded(true))
    void loadPrepareCommands().then(setPrepareByRepo)
    void loadLaunchStore().then(setLaunchStore, () => setLaunchStore({}))
  }, [])

  // A session created but not opened (its launch unconfirmed, or a later step failed) belongs to
  // that visit; leaving, or a new "+", starts a fresh request rather than offering it again.
  const forgetCreated = useCallback(() => {
    if (!createdTarget.current) return
    createdTarget.current = null
    setError(null)
  }, [])
  useEffect(() => { if (!focused) forgetCreated() }, [focused, forgetCreated])

  // A "+" beside a repository asks for a session there, even when the screen is already open.
  useEffect(() => {
    if (!repoParam) return
    forgetCreated()
    setDirectory(repoParam)
    setPathEdit(null)
  }, [repoParam, requestedAt, forgetCreated])

  // Remembered settings apply on the first read, then whenever the directory reaches a repository
  // (or folder) with its own record. Typing a path through others keeps what was picked here.
  const launchApplied = useRef(false)
  useEffect(() => {
    if (!launchStore) return
    if (launchApplied.current && !(repoKey && launchStore[repoKey])) return
    launchApplied.current = true
    setAgent(launch.startWith ?? DEFAULT_AGENT_CHOICE)
    setPermissions(launch.permissions ?? {})
    setProfilePick(launch.configDir)
    setFastPick(launch.fast ?? false)
    // A model picked for one repository is not a choice for the next.
    setModelPick(null)
    // Only a new repository (or the first read) re-applies what was remembered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchStore === null, repoKey])

  // Nothing is selected on the first render, so the newest remembered
  // directory (or the first repo a pane is sitting in) becomes the default,
  // once the history has been read rather than whichever arrives first.
  useEffect(() => {
    if (directory || !historyLoaded) return
    const fallback = directoryHistory[0] ?? repos[0]?.root
    if (fallback) setDirectory(fallback)
  }, [directory, directoryHistory, historyLoaded, repos])

  // Profiles and model lists are read again on each visit, as the desktop does on each open.
  useEffect(() => {
    if (!host || !focused) return
    let cancelled = false
    fetchClaudeProfiles(host)
      .then((found) => { if (!cancelled) setProfiles(found) })
      // An older daemon has no list; it then starts the chat with its own default.
      .catch(() => { if (!cancelled) setProfiles((current) => current ?? []) })
    fetchModelCatalogs(host)
      .then((found) => { if (!cancelled) setCatalogs(found) })
      // Without lists the picker offers the provider's default model.
      .catch(() => { if (!cancelled) setCatalogs((current) => current ?? {}) })
    return () => { cancelled = true }
  }, [host, focused])

  // Only the daemon can say whether a directory is a checkout, so the worktree
  // block stays hidden until `GET /api/git/repo` says it is.
  useEffect(() => {
    if (!host || !directory.startsWith('/')) {
      setRepo(null)
      return
    }
    const version = ++probeVersion.current
    const timer = setTimeout(() => {
      fetchRepoInfo(host, directory)
        .then((info) => {
          if (version === probeVersion.current) setRepo(info)
        })
        .catch(() => {
          if (version === probeVersion.current) setRepo({ isRepo: false })
        })
    }, REPO_PROBE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [host, directory])

  // Preparation commands are remembered per repository, the way the desktop
  // create dialog remembers them.
  useEffect(() => {
    const root = repo?.mainRoot
    setPrepareCommand(root ? prepareByRepo[root] ?? '' : '')
  }, [repo?.mainRoot, prepareByRepo])

  const chooseRepo = useCallback((option: RepoOption) => {
    setDirectory(option.root)
    setPathEdit(null)
    setRepoPickerOpen(false)
  }, [])

  /** After a create the screen is ready for the next session; it stays mounted as a hidden tab. */
  const resetForm = useCallback(() => {
    createdTarget.current = null
    setName('')
    setPrompt('')
    uploads.setAttachments([])
    setAttachError(null)
    setBranchEdit(null)
    setPathEdit(null)
    setWorktreeEnabled(true)
    setPrepareEnabled(true)
    setModelPick(null)
    setError(null)
    setBusy(false)
  }, [uploads.setAttachments])

  const openPane = useCallback((paneId: string) => {
    resetForm()
    router.replace({ pathname: '/(host)/[hostId]/pane/[paneId]', params: routeParams({ hostId: hostId ?? '', paneId }) })
  }, [hostId, resetForm, router])

  /** Room for more images, or why there is none (the error is shown). */
  const roomForImages = (): number => {
    setAttachError(null)
    const room = MAX_CHAT_IMAGES - uploads.attachments.length
    if (room <= 0) setAttachError(`A message can carry at most ${MAX_CHAT_IMAGES} images`)
    return Math.max(0, room)
  }

  const attach = async () => {
    const room = roomForImages()
    if (!room) return
    try {
      const picked = await pickFromSheet(attachButton.current, room)
      if (picked?.length) uploads.add(picked)
    } catch (pickError) {
      setAttachError(pickError instanceof Error ? pickError.message : String(pickError))
    }
  }

  const clipboardImage = useClipboardImage(focused && imagesAccepted && !busy)
  const pasteImage = (data: ClipboardImageData) => {
    if (!roomForImages()) return
    clipboardImage.dismiss()
    const image = pastedImage(data)
    if (!image) {
      setAttachError('The clipboard image is in a format that can\'t be attached')
      return
    }
    void Haptics.selectionAsync()
    uploads.add([image])
  }

  const pickModel = async () => {
    const index = await showSheet(modelRef.current, 'Model', shownModels.map((model) => model.displayName), shownModels.findIndex((model) => model.value === selectedModel))
    const model = index === null ? undefined : shownModels[index]
    if (model && catalogKey) setModelPick({ key: catalogKey, value: model.value })
  }

  const permissionOptions = chat ? chatPermissionModes(chat) : []
  const pickPermission = async () => {
    if (!chat) return
    const index = await showSheet(permissionRef.current, 'Permissions', permissionOptions.map((mode) => mode.label), permissionOptions.findIndex((mode) => mode.value === permissionMode))
    const mode = index === null ? undefined : permissionOptions[index]
    if (mode) setPermissions((current) => ({ ...current, [chat]: mode.value }))
  }

  const profileOptions = usesClaudeProfile(agent) && profiles && profiles.length > 1 ? profiles : []
  const pickProfile = async () => {
    const index = await showSheet(profileRef.current, 'Claude profile', profileOptions.map(claudeProfileLabel), profileOptions.findIndex((profile) => profile.configDir === configDir))
    const profile = index === null ? undefined : profileOptions[index]
    if (profile) setProfilePick(profile.configDir)
  }

  const submit = useCallback(async () => {
    if (!host) return
    if (createdTarget.current) {
      openPane(createdTarget.current.paneId)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const request = buildSessionRequest(
        {
          name, directory, worktreeEnabled, branch, worktreePath, prepareCommand, prepareEnabled, agent,
          prompt: promptAccepted ? prompt : '',
          permissionMode, configDir, model: selectedModel, fast,
          images: imagesAccepted ? uploads.refs : [],
        },
        repo,
      )
      const { created } = requireSessionAgentLaunch(request, await createTmuxSession(host, request))
      createdTarget.current = created
      setDirectoryHistory(await rememberDirectory(directory))
      if (repo?.mainRoot) await rememberPrepareCommand(repo.mainRoot, prepareCommand)
      // Only what was picked here is remembered for the model, never a fallback to the default.
      setLaunchStore(await rememberLaunch(repoKey, {
        startWith: agent,
        ...(chat ? { permissions: { [chat]: permissionMode } } : {}),
        ...(configDir ? { configDir } : {}),
        ...(catalogKey && modelPick?.key === catalogKey ? { models: { [catalogKey]: selectedModel } } : {}),
        ...(fastAvailable ? { fast: fastPick } : {}),
      }))
      // The daemon evaluates push rules per device, so "notify me" is the
      // absence of the session from the muted list rather than a local flag.
      const push = usePushStore.getState()
      const muted = push.rules.mutedSessions.includes(created.sessionName)
      if (muted === notify) {
        await push.setRules(toggleMutedSession(push.rules, created.sessionName), useHostsStore.getState().hosts)
      }
      openPane(created.paneId)
    } catch (createError) {
      const compatibilityError = createError instanceof TmuxAgentLaunchCompatibilityError
      if (compatibilityError) createdTarget.current = createError.response.created
      const detail = createError instanceof Error ? createError.message : 'Creating the session failed'
      setError(compatibilityError ? detail : createdTarget.current ? `Session ${createdTarget.current.sessionName} was created, but preferences could not be saved: ${detail}` : detail)
      setBusy(false)
    }
  }, [
    agent,
    branch,
    catalogKey,
    chat,
    configDir,
    directory,
    fast,
    fastAvailable,
    fastPick,
    host,
    imagesAccepted,
    modelPick,
    name,
    notify,
    openPane,
    prepareCommand,
    prepareEnabled,
    prompt,
    promptAccepted,
    permissionMode,
    repo,
    repoKey,
    selectedModel,
    uploads.refs,
    worktreeEnabled,
    worktreePath,
  ])

  return (
    <CreateSheet
      action={createdTarget.current ? 'Open session' : 'Create'}
      actionEnabled={(Boolean(createdTarget.current) || name.trim().length > 0) && !busy && !uploads.uploading}
      busy={busy}
      onAction={() => void submit()}
      onCancel={() => router.back()}
      subtitle={host ? `on ${host.name}` : undefined}
      title="New session"
    >
      {error ? <FormError message={error} /> : null}

      <RowGroup>
        <TextRow label="Name" onChangeText={setName} placeholder="companion-app" value={name} />
        <ValueRow
          hint={selectedRepo ? selectedRepo.root : undefined}
          label="Repository"
          onPress={repos.length ? () => setRepoPickerOpen(true) : undefined}
          value={selectedRepo?.name ?? (repos.length ? 'Choose' : 'None known')}
        />
        <TextRow
          label="Directory"
          mono
          onChangeText={(next) => {
            setDirectory(next)
            setPathEdit(null)
          }}
          placeholder="/Users/leo/code/commando"
          value={directory}
        />
      </RowGroup>

      {isRepo ? (
        <>
          <SectionHeader label="Worktree" />
          <RowGroup>
            <ToggleRow
              hint="Keeps the main checkout untouched"
              label="Create a worktree and branch"
              onChange={setWorktreeEnabled}
              value={worktreeEnabled}
            />
            {worktreeEnabled ? (
              <>
                <TextRow
                  label="Branch"
                  mono
                  onChangeText={setBranchEdit}
                  placeholder="feat/companion-app"
                  value={branch}
                />
                <TextRow
                  label="Path"
                  mono
                  onChangeText={setPathEdit}
                  placeholder={defaultPath}
                  value={worktreePath}
                />
                <ValueRow label="From" value={baseLabel(repo)} />
                <TextRow
                  label="Preparation"
                  mono
                  onChangeText={setPrepareCommand}
                  placeholder="npm install"
                  value={prepareCommand}
                />
                <ToggleRow
                  hint={prepareCommand.trim() || 'Nothing to run yet'}
                  label="Run preparation"
                  onChange={setPrepareEnabled}
                  value={prepareEnabled}
                />
              </>
            ) : null}
          </RowGroup>
        </>
      ) : repo && !repo.isRepo ? (
        <Meta>{directory} is not a git checkout, so no worktree can be created.</Meta>
      ) : null}

      <SectionHeader label="Start with" />
      <View style={styles.agentChoices}>
        {AGENT_CHOICES.map((choice) => (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: agent === choice.value, disabled: busy }}
            disabled={busy}
            key={choice.value}
            onPress={() => setAgent(choice.value)}
            style={[styles.agentChoice, {
              backgroundColor: agent === choice.value ? theme.surfaceSoft : theme.surfaceRaised,
              borderColor: agent === choice.value ? theme.accent : theme.border,
            }]}
          >
            <Text style={{ color: agent === choice.value ? theme.text : theme.muted }}>{choice.label}</Text>
          </Pressable>
        ))}
      </View>
      {!promptAccepted ? (
        <Meta>{agent === 'shell' ? 'The session opens an interactive shell and nothing is run in it.' : 'OpenCode starts without an opening prompt.'}</Meta>
      ) : (
        <View style={[styles.promptField, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }]}>
          {uploads.attachments.length ? (
            <AttachmentStrip
              attachments={uploads.attachments}
              onRemove={(attachment) => {
                setAttachError(null)
                uploads.remove(attachment.key)
              }}
              style={styles.attachments}
            />
          ) : null}
          {clipboardImage.available ? (
            <PasteImageBar onDismiss={clipboardImage.dismiss} onError={setAttachError} onImage={pasteImage} />
          ) : null}
          <TextInput
            accessibilityLabel="Opening prompt"
            multiline
            onChangeText={setPrompt}
            onFocus={clipboardImage.recheck}
            placeholder={imagesAccepted ? 'Describe the task, or attach a screenshot…' : 'Describe the task…'}
            placeholderTextColor={theme.textDim}
            style={[styles.promptInput, { color: theme.text }]}
            value={prompt}
          />
          {imagesAccepted || chatProvider || profileOptions.length ? (
            <View style={styles.promptBar}>
              {imagesAccepted ? <IconButton disabled={busy} icon="paperclip" label="Attach images" onPress={() => void attach()} ref={attachButton} /> : null}
              <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills}>
                {profileOptions.length ? (
                  <Pill
                    a11y="Profile"
                    disabled={busy}
                    label={claudeProfileLabel(profileOptions.find((profile) => profile.configDir === configDir) ?? profileOptions[0]!)}
                    onPress={() => void pickProfile()}
                    ref={profileRef}
                  />
                ) : null}
                {chatProvider ? (
                  <Pill
                    a11y="Model"
                    disabled={busy || shownModels.length < 2}
                    label={selectedModel === 'default' ? 'Default model' : selectedModelOption?.displayName ?? selectedModel}
                    onPress={() => void pickModel()}
                    ref={modelRef}
                  />
                ) : null}
                {fastAvailable ? (
                  <Pill a11y="Fast mode" disabled={busy} label={fast ? '⚡ Fast' : 'Fast off'} on={fast} onPress={() => setFastPick(!fast)} />
                ) : null}
                {chat ? (
                  <Pill
                    a11y="Permissions"
                    disabled={busy}
                    label={permissionOptions.find((mode) => mode.value === permissionMode)?.label ?? permissionMode}
                    onPress={() => void pickPermission()}
                    ref={permissionRef}
                  />
                ) : null}
              </ScrollView>
            </View>
          ) : null}
        </View>
      )}
      {attachError ? (
        <View style={styles.attachError}>
          <Feather color={theme.red} name="alert-circle" size={13} />
          <Text accessibilityLiveRegion="polite" style={[styles.attachErrorText, { color: theme.red }]}>{attachError}</Text>
        </View>
      ) : null}
      {uploads.attachments.length && !imagesAccepted ? (
        <Meta>Only chats are sent images; pick a chat to include them.</Meta>
      ) : null}

      {agent === 'cursor' ? <Meta>Starts the Cursor CLI agent in the terminal pane.</Meta> : null}

      <RowGroup>
        <ToggleRow
          label="Notify me when it needs input or finishes"
          onChange={setNotify}
          value={notify}
        />
      </RowGroup>

      <Text style={[styles.footnote, { color: theme.textDim }]}>
        Recent directories, per-repo preparation commands and how you last started a session (agent,
        model, fast mode, permissions and profile) are remembered on this device.
      </Text>

      <Modal
        animationType="slide"
        onRequestClose={() => setRepoPickerOpen(false)}
        transparent
        visible={repoPickerOpen}
      >
        <Pressable
          accessibilityLabel="Dismiss"
          onPress={() => setRepoPickerOpen(false)}
          style={styles.backdrop}
        />
        <View style={[styles.picker, { backgroundColor: theme.surface, borderColor: theme.borderMid }]}>
          <View style={[styles.pickerGrab, { backgroundColor: theme.borderStrong }]} />
          <Text style={[styles.pickerTitle, { color: theme.text }]}>Repository</Text>
          <ScrollView contentContainerStyle={styles.pickerBody}>
            {repos.map((option) => (
              <Pressable
                accessibilityRole="button"
                key={option.root}
                onPress={() => chooseRepo(option)}
                style={[
                  styles.pickerRow,
                  {
                    backgroundColor: theme.surfaceRaised,
                    borderColor: option.root === directory ? theme.accent : theme.border,
                  },
                ]}
              >
                <View style={styles.pickerText}>
                  <Text style={[styles.pickerName, { color: theme.text }]}>{option.name}</Text>
                  <Text numberOfLines={1} style={[styles.pickerPath, { color: theme.muted }]}>
                    {option.root}
                  </Text>
                </View>
                {option.branch ? (
                  <Text style={[styles.pickerBranch, { color: theme.muted }]}>⎇ {option.branch}</Text>
                ) : option.fromHistory ? (
                  <Text style={[styles.pickerBranch, { color: theme.textDim }]}>recent</Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </CreateSheet>
  )
}

const styles = StyleSheet.create({
  agentChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  agentChoice: { minHeight: 44, flexBasis: '30%', flexGrow: 1, alignItems: 'center', borderRadius: 10, borderWidth: 1, padding: 10 },
  promptField: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  promptInput: { fontSize: 14, lineHeight: 20, minHeight: 92, textAlignVertical: 'top' },
  attachments: { paddingTop: 4 },
  promptBar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: -6 },
  pills: { alignItems: 'center', gap: 6, paddingRight: 4 },
  attachError: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  attachErrorText: { flex: 1, fontSize: 12.5, lineHeight: 17 },
  footnote: { fontSize: 12, lineHeight: 18 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  picker: {
    maxHeight: '70%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingTop: 8,
    paddingBottom: 28,
    paddingHorizontal: 16,
    gap: 10,
  },
  pickerGrab: { width: 36, height: 5, borderRadius: 3, alignSelf: 'center' },
  pickerTitle: { fontSize: 18, fontWeight: '800' },
  pickerBody: { gap: 8, paddingBottom: 12 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pickerText: { flex: 1, gap: 2 },
  pickerName: { fontSize: 15, fontWeight: '600' },
  pickerPath: { fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  pickerBranch: { fontSize: 12 },
})
