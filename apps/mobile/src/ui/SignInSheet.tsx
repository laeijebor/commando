import { useEffect, useState } from 'react'
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

import { DaemonHttpError, fetchAuthBootstrap, signInWithEmail } from '../hosts/api'
import { useHostsStore } from '../hosts/store'
import type { Host } from '../hosts/types'
import { useTheme } from '../theme'
import { Button } from './primitives'

/**
 * Screen 01's sign-in sheet. The email is prefilled from
 * `GET /api/auth/bootstrap` so the owner only types a password; token-only
 * daemons switch to the automation-token field instead.
 */
export function SignInSheet({
  host,
  visible,
  onClose,
}: {
  host: Host | null
  visible: boolean
  onClose: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const updateHost = useHostsStore((state) => state.updateHost)
  const setCookie = useHostsStore((state) => state.setCookie)
  const refreshReachability = useHostsStore((state) => state.refreshReachability)

  const [mode, setMode] = useState<'email' | 'token'>('email')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    if (!visible || !host) return
    setError(null)
    setPassword('')
    setMode(host.auth.kind === 'token' ? 'token' : 'email')
    setToken(host.auth.kind === 'token' ? host.auth.token : '')
    let cancelled = false
    void fetchAuthBootstrap(host)
      .then((bootstrap) => {
        if (cancelled) return
        if (bootstrap.ownerEmail) setEmail(bootstrap.ownerEmail)
        if (!bootstrap.enabled) {
          setMode('token')
          setHint('This daemon has email auth disabled — use its automation token.')
        } else if (bootstrap.needsOwner) {
          setHint('No owner account yet. Create one in the web cockpit first.')
        } else {
          setHint('Owner account · session lasts 30 days')
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setHint(null)
        setError(cause instanceof Error ? cause.message : 'Could not reach the daemon')
      })
    return () => {
      cancelled = true
    }
  }, [visible, host])

  const submit = async (): Promise<void> => {
    if (!host) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'token') {
        await updateHost(host.id, { auth: { kind: 'token', token: token.trim() } })
        setCookie(host.id, null)
      } else {
        const result = await signInWithEmail(host, email.trim(), password)
        await updateHost(host.id, { auth: { kind: 'session' } })
        setCookie(host.id, result.cookie)
      }
      await refreshReachability(host.id)
      onClose()
    } catch (cause) {
      const message = cause instanceof DaemonHttpError || cause instanceof Error
        ? cause.message
        : 'Sign in failed'
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Dismiss" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.surface, borderColor: theme.borderMid },
          ]}
        >
          <View style={[styles.grab, { backgroundColor: theme.borderStrong }]} />
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={[styles.title, { color: theme.text }]}>
              {host ? `Sign in to ${host.name}` : 'Sign in'}
            </Text>
            {hint ? <Text style={[styles.hint, { color: theme.muted }]}>{hint}</Text> : null}

            {mode === 'email' ? (
              <>
                <Field label="Email">
                  <TextInput
                    accessibilityLabel="Email"
                    autoCapitalize="none"
                    autoComplete="email"
                    keyboardType="email-address"
                    onChangeText={setEmail}
                    placeholder="owner@example.com"
                    placeholderTextColor={theme.textDim}
                    style={[styles.input, { color: theme.text }]}
                    value={email}
                  />
                </Field>
                <Field label="Password">
                  <TextInput
                    accessibilityLabel="Password"
                    autoCapitalize="none"
                    onChangeText={setPassword}
                    onSubmitEditing={() => void submit()}
                    placeholder="••••••••"
                    placeholderTextColor={theme.textDim}
                    secureTextEntry
                    style={[styles.input, { color: theme.text }]}
                    value={password}
                  />
                </Field>
              </>
            ) : (
              <Field label="Token">
                <TextInput
                  accessibilityLabel="Automation token"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setToken}
                  placeholder="COMMANDO_TOKEN"
                  placeholderTextColor={theme.textDim}
                  style={[styles.input, styles.mono, { color: theme.text }]}
                  value={token}
                />
              </Field>
            )}

            {error ? <Text style={[styles.error, { color: theme.red }]}>{error}</Text> : null}

            <Button busy={busy} label="Sign in" onPress={() => void submit()} variant="primary" />

            <Pressable onPress={() => setMode(mode === 'email' ? 'token' : 'email')}>
              <Text style={[styles.switch, { color: theme.accent }]}>
                {mode === 'email' ? 'Use automation token' : 'Use owner email'}
              </Text>
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme()
  return (
    <View
      style={[styles.field, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }]}
    >
      <Text style={[styles.fieldLabel, { color: theme.muted }]}>{label}</Text>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingTop: 8,
    paddingBottom: 28,
  },
  grab: { width: 36, height: 5, borderRadius: 3, alignSelf: 'center', marginBottom: 6 },
  content: { paddingHorizontal: 16, gap: 12 },
  title: { fontSize: 20, fontWeight: '800', letterSpacing: -0.2 },
  hint: { fontSize: 13 },
  field: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  fieldLabel: { fontSize: 12, fontWeight: '600', minWidth: 74 },
  input: { flex: 1, fontSize: 15, paddingVertical: 4 },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  error: { fontSize: 13 },
  switch: { fontSize: 13, fontWeight: '600', paddingVertical: 6 },
})
