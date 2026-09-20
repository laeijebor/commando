import { useMemo, useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import type { CommandoSnapshot, WebPaneEngine, WebPanePlacement } from '@commando/protocol'

import { useTheme } from '../theme'
import { Button, EmptyState, SectionHeader, withAlpha } from '../ui/primitives'

export type OpenTileRequest = {
  url: string
  anchor: string
  placement: WebPanePlacement
  engine: WebPaneEngine
}

type AnchorChoice = { paneId: string; label: string; detail: string }

function anchorChoices(snapshot: CommandoSnapshot | null): AnchorChoice[] {
  if (!snapshot) return []
  const sessions = new Map(snapshot.sessions.map((session) => [session.id, session.name]))
  const windows = new Map(snapshot.windows.map((window) => [window.id, window.name]))
  return snapshot.panes
    .filter((pane) => !pane.dead)
    .map((pane) => ({
      paneId: pane.id,
      label: `${sessions.get(pane.sessionId) ?? pane.sessionId} · ${windows.get(pane.windowId) ?? pane.windowId}`,
      detail: `${pane.title || pane.command} · ${pane.id}`,
    }))
}

/**
 * The "+" sheet: a URL and the pane to put the tile beside. The daemon needs
 * an anchor because tiles live in the app-side layout tree next to a real tmux
 * pane — there is no such thing as a free-floating tile.
 */
export function OpenTileSheet({
  visible,
  snapshot,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  visible: boolean
  snapshot: CommandoSnapshot | null
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (request: OpenTileRequest) => void
}): React.JSX.Element {
  const theme = useTheme()
  const [url, setUrl] = useState('')
  const [anchor, setAnchor] = useState<string | null>(null)
  const [placement, setPlacement] = useState<WebPanePlacement>('right')

  const choices = useMemo(() => anchorChoices(snapshot), [snapshot])
  const selected = anchor ?? choices[0]?.paneId ?? null
  const ready = url.trim().length > 0 && selected !== null && !busy

  return (
    <Modal animationType="slide" onRequestClose={onCancel} presentationStyle="pageSheet" visible={visible}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.sheet, { backgroundColor: theme.bg }]}
      >
        <View style={[styles.nav, { borderBottomColor: theme.border }]}>
          <Pressable accessibilityRole="button" onPress={onCancel}>
            <Text style={[styles.navAction, { color: theme.muted }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.navTitle, { color: theme.text }]}>Open a tile</Text>
          <Pressable
            accessibilityRole="button"
            disabled={!ready}
            onPress={() => {
              if (!ready || selected === null) return
              // Chromium is the only engine the phone can render.
              onSubmit({ url: url.trim(), anchor: selected, placement, engine: 'chromium' })
            }}
          >
            <Text style={[styles.navAction, { color: ready ? theme.accent : theme.textDim }]}>Open</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <SectionHeader label="URL" />
          <TextInput
            accessibilityLabel="Tile URL"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={setUrl}
            placeholder="http://127.0.0.1:5173/"
            placeholderTextColor={theme.textDim}
            style={[styles.input, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text }]}
            value={url}
          />

          <SectionHeader label="Beside" note="The tile shares this pane's half of the window" />
          {choices.length === 0 ? (
            <EmptyState
              body="Connect to the host and open a pane first; a tile has to sit beside one."
              title="No panes to anchor to"
            />
          ) : (
            <View style={styles.choices}>
              {choices.map((choice) => {
                const active = choice.paneId === selected
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    key={choice.paneId}
                    onPress={() => setAnchor(choice.paneId)}
                    style={[
                      styles.choice,
                      {
                        backgroundColor: active ? withAlpha(theme.accent, 0.12) : theme.surface,
                        borderColor: active ? theme.accent : theme.border,
                      },
                    ]}
                  >
                    <Text style={[styles.choiceLabel, { color: theme.text }]}>{choice.label}</Text>
                    <Text style={[styles.choiceDetail, { color: theme.muted }]}>{choice.detail}</Text>
                  </Pressable>
                )
              })}
            </View>
          )}

          <SectionHeader label="Placement" />
          <View style={styles.placements}>
            {(['right', 'below', 'auto'] as const).map((option) => {
              const active = option === placement
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  key={option}
                  onPress={() => setPlacement(option)}
                  style={[
                    styles.placement,
                    {
                      backgroundColor: active ? theme.surfaceSoft : theme.surface,
                      borderColor: active ? theme.borderStrong : theme.border,
                    },
                  ]}
                >
                  <Text style={[styles.placementLabel, { color: active ? theme.text : theme.muted }]}>
                    {option}
                  </Text>
                </Pressable>
              )
            })}
          </View>

          {error ? <Text style={[styles.error, { color: theme.red }]}>{error}</Text> : null}

          <Text style={[styles.note, { color: theme.textDim }]}>
            External origins open paused until you confirm them, and the daemon renders the page in
            its own Chromium — the URL is resolved on the host, not on this phone.
          </Text>

          <Button busy={busy} disabled={!ready} label="Open tile" onPress={() => {
            if (!ready || selected === null) return
            onSubmit({ url: url.trim(), anchor: selected, placement, engine: 'chromium' })
          }} variant="primary" />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  navTitle: { fontSize: 17, fontWeight: '700' },
  navAction: { fontSize: 15, fontWeight: '600' },
  body: { padding: 16, paddingBottom: 48, gap: 10 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15 },
  choices: { gap: 8 },
  choice: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, gap: 2 },
  choiceLabel: { fontSize: 14, fontWeight: '600' },
  choiceDetail: { fontSize: 12 },
  placements: { flexDirection: 'row', gap: 8 },
  placement: { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  placementLabel: { fontSize: 13, fontWeight: '600' },
  error: { fontSize: 13, lineHeight: 18 },
  note: { fontSize: 12, lineHeight: 17 },
})
