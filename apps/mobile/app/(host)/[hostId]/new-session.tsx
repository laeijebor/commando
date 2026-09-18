import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
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

import type { GitRepoInfo } from '@commando/tmux-create'

import { createTmuxSession, fetchRepoInfo, runInPane } from '../../../src/daemon/paneApi'
import { useDaemonConnection } from '../../../src/daemon/useDaemonConnection'
import {
  AGENT_CHOICES,
  agentRunCommand,
  baseLabel,
  buildSessionRequest,
  effectiveBranch,
  previewWorktreePath,
  repoOptions,
  type AgentChoice,
  type RepoOption,
} from '../../../src/create/model'
import {
  loadDirectoryHistory,
  loadPrepareCommands,
  rememberDirectory,
  rememberPrepareCommand,
} from '../../../src/create/prefs'
import { useHostsStore } from '../../../src/hosts/store'
import { toggleMutedSession, usePushStore } from '../../../src/notifications'
import { useTheme } from '../../../src/theme'
import { CreateSheet } from '../../../src/ui/CreateSheet'
import { FormError, RowGroup, TextRow, ToggleRow, ValueRow } from '../../../src/ui/formPrimitives'
import { Meta, SectionHeader, Segmented } from '../../../src/ui/primitives'

const REPO_PROBE_DEBOUNCE_MS = 200

/**
 * Screen 07. One `POST /api/tmux/sessions` with the worktree block, then —
 * when an agent was picked — one `POST /api/pane-management/panes/:id/run` to
 * start it in the pane the daemon just created.
 */
export default function NewSessionScreen(): React.JSX.Element {
  const theme = useTheme()
  const router = useRouter()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const host = useHostsStore((state) => state.hosts.find((candidate) => candidate.id === hostId))
  const state = useDaemonConnection(host)

  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  const [directoryHistory, setDirectoryHistory] = useState<string[]>([])
  const [prepareByRepo, setPrepareByRepo] = useState<Record<string, string>>({})
  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const [repo, setRepo] = useState<GitRepoInfo | null>(null)
  const [worktreeEnabled, setWorktreeEnabled] = useState(true)
  const [branchEdit, setBranchEdit] = useState<string | null>(null)
  const [pathEdit, setPathEdit] = useState<string | null>(null)
  const [prepareCommand, setPrepareCommand] = useState('')
  const [prepareEnabled, setPrepareEnabled] = useState(true)
  const [agent, setAgent] = useState<AgentChoice>('claude')
  const [prompt, setPrompt] = useState('')
  const [notify, setNotify] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const probeVersion = useRef(0)

  const repos = useMemo(
    () => repoOptions(state.snapshot, directoryHistory),
    [state.snapshot, directoryHistory],
  )
  const branch = effectiveBranch(name, branchEdit)
  const defaultPath = previewWorktreePath(repo, branch)
  const worktreePath = pathEdit ?? defaultPath
  const isRepo = Boolean(repo?.isRepo && repo.mainRoot)
  const selectedRepo = repos.find((option) => option.root === directory)

  useEffect(() => {
    void loadDirectoryHistory().then(setDirectoryHistory)
    void loadPrepareCommands().then(setPrepareByRepo)
  }, [])

  // Nothing is selected on the first render, so the newest remembered
  // directory (or the first repo a pane is sitting in) becomes the default.
  useEffect(() => {
    if (directory) return
    const fallback = directoryHistory[0] ?? repos[0]?.root
    if (fallback) setDirectory(fallback)
  }, [directory, directoryHistory, repos])

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

  const submit = useCallback(async () => {
    if (!host) return
    setBusy(true)
    setError(null)
    try {
      const request = buildSessionRequest(
        { name, directory, worktreeEnabled, branch, worktreePath, prepareCommand, prepareEnabled },
        repo,
      )
      const { created } = await createTmuxSession(host, request)
      setDirectoryHistory(await rememberDirectory(directory))
      if (repo?.mainRoot) await rememberPrepareCommand(repo.mainRoot, prepareCommand)
      // The daemon evaluates push rules per device, so "notify me" is the
      // absence of the session from the muted list rather than a local flag.
      const push = usePushStore.getState()
      const muted = push.rules.mutedSessions.includes(created.sessionName)
      if (muted === notify) {
        await push.setRules(toggleMutedSession(push.rules, created.sessionName), useHostsStore.getState().hosts)
      }
      const command = agentRunCommand(agent, prompt)
      if (command) {
        try {
          await runInPane(host, created.paneId, command)
        } catch (runError) {
          // The session exists either way, so the error is shown rather than
          // swallowed, and the sheet stays open on the created session.
          setError(runError instanceof Error ? runError.message : 'The agent did not start')
          setBusy(false)
          return
        }
      }
      router.replace({
        pathname: '/(host)/[hostId]/pane/[paneId]',
        params: { hostId: hostId ?? '', paneId: created.paneId },
      })
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Creating the session failed')
      setBusy(false)
    }
  }, [
    agent,
    branch,
    directory,
    host,
    hostId,
    name,
    notify,
    prepareCommand,
    prepareEnabled,
    prompt,
    repo,
    router,
    worktreeEnabled,
    worktreePath,
  ])

  return (
    <CreateSheet
      action="Create"
      actionEnabled={name.trim().length > 0 && !busy}
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
      <Segmented onChange={setAgent} options={AGENT_CHOICES} value={agent} />
      {agent === 'shell' ? (
        <Meta>The session opens an interactive shell and nothing is run in it.</Meta>
      ) : agent === 'opencode' ? (
        <Meta>OpenCode takes no prompt argument, so it starts bare.</Meta>
      ) : (
        <View style={[styles.promptField, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }]}>
          <TextInput
            accessibilityLabel="Opening prompt"
            multiline
            onChangeText={setPrompt}
            placeholder="Plan the Expo companion app. Read the spec first and update the checklist as you go."
            placeholderTextColor={theme.textDim}
            style={[styles.promptInput, { color: theme.text }]}
            value={prompt}
          />
        </View>
      )}

      <RowGroup>
        <ToggleRow
          label="Notify me when it needs input or finishes"
          onChange={setNotify}
          value={notify}
        />
      </RowGroup>

      <Text style={[styles.footnote, { color: theme.textDim }]}>
        Recent directories and per-repo preparation commands are remembered on this device — the
        same values the desktop create dialog keeps.
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
  promptField: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  promptInput: { fontSize: 14, lineHeight: 20, minHeight: 92, textAlignVertical: 'top' },
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
