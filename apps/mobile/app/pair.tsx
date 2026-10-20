import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Device from 'expo-device'
import * as Haptics from 'expo-haptics'
import { AppState, Linking, Modal, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Feather from '@expo/vector-icons/Feather'
import { useHostsStore } from '../src/hosts/store'
import { claimPairing, pairingLinkFromParams, parsePairingLink, type PairingLink } from '../src/pairing/client'
import { useTheme } from '../src/theme'
import { Button } from '../src/ui/primitives'

/** `commando://pair?...` and the in-app scanner share the same confirmation. */
export default function PairScreen(): React.JSX.Element {
  const theme = useTheme()
  const window = useWindowDimensions()
  const viewfinderSize = Math.min(window.width - 40, window.height * 0.45, 480)
  const router = useRouter()
  const params = useLocalSearchParams<{ v?: string | string[]; c?: string | string[]; u?: string | string[]; n?: string | string[] }>()
  const queryKey = JSON.stringify(params)
  const incoming = useMemo(() => {
    if (!params.v && !params.c && !params.u) return null
    try { return { link: pairingLinkFromParams(params), error: null } }
    catch (cause) { return { link: null, error: cause instanceof Error ? cause.message : 'Invalid pairing code' } }
    // A new OS deep link may arrive while this route is already open.
  }, [queryKey])
  const [link, setLink] = useState<PairingLink | null>(incoming?.link ?? null)
  const [error, setError] = useState<string | null>(incoming?.error ?? null)
  const [busy, setBusy] = useState(false)
  const [trying, setTrying] = useState<string | null>(null)
  const [permission, requestPermission] = useCameraPermissions()
  const scanLocked = useRef(false)
  const claimLocked = useRef(false)
  const attempt = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const incomingRef = useRef(incoming)
  const [active, setActive] = useState(true)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; attempt.current?.abort() } }, [])
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: string) => setActive(state === 'active'))
    return () => subscription.remove()
  }, [])
  useEffect(() => {
    incomingRef.current = incoming
    attempt.current?.abort()
    attempt.current = null
    claimLocked.current = false
    setBusy(false)
    setTrying(null)
    setLink(incoming?.link ?? null)
    setError(incoming?.error ?? null)
    scanLocked.current = false
  }, [incoming])
  useEffect(() => {
    if (!incoming && !link && permission && !permission.granted && permission.canAskAgain && permission.status === 'undetermined') void requestPermission()
  }, [incoming, link, permission, requestPermission])

  const close = () => { attempt.current?.abort(); attempt.current = null; if (router.canGoBack()) router.back(); else router.replace('/') }
  const scan = (data: string) => {
    if (scanLocked.current || link) return
    try {
      const parsed = parsePairingLink(data)
      scanLocked.current = true
      setError(null)
      setTrying(null)
      setLink(parsed)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Invalid QR code') }
  }
  const confirm = async () => {
    if (!link || claimLocked.current) return
    const controller = new AbortController()
    attempt.current = controller
    claimLocked.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await claimPairing(link, (Device.deviceName || 'iPhone').slice(0, 80), Platform.OS === 'android' ? 'android' : 'ios', (url) => { if (mounted.current && attempt.current === controller) setTrying(url) }, controller.signal)
      if (controller.signal.aborted) return
      const store = useHostsStore.getState()
      await store.hydrate()
      if (controller.signal.aborted) return
      const host = await useHostsStore.getState().savePairedHost({ name: result.name, baseUrl: result.baseUrl, token: result.token, pairing: { name: link.name, urls: link.urls } })
      useHostsStore.getState().rememberHost(host.id)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
      if (mounted.current && !controller.signal.aborted) router.replace({ pathname: '/(host)/[hostId]/sessions', params: { hostId: host.id } })
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Pairing failed. Ask your Mac for a new code.')
    } finally {
      if (attempt.current !== controller) return
      attempt.current = null
      claimLocked.current = false
      if (mounted.current) {
        setBusy(false)
        if (incomingRef.current !== incoming) { setTrying(null); setLink(incomingRef.current?.link ?? null); setError(incomingRef.current?.error ?? null) }
      }
    }
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
      <View style={styles.header}><Text style={[styles.title, { color: theme.text }]}>Scan QR code</Text><Pressable accessibilityLabel="Close scanner" onPress={close} hitSlop={12}><Feather name="x" size={24} color={theme.text} /></Pressable></View>
      <Text style={[styles.instruction, { color: theme.muted }]}>On your Mac, open Machine → Pair a phone. Point your camera at the code.</Text>
      <View style={[styles.viewfinder, { width: viewfinderSize, borderColor: theme.accent, backgroundColor: theme.surface }]}>
        {!incoming && !link && active && permission?.granted ? <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => scan(data)} /> : <Feather name="camera" size={48} color={theme.muted} />}
      </View>
      {!incoming && !link && !permission?.granted ? <View style={styles.permission}><Text style={{ color: theme.muted }}>Allow camera access to scan the pairing code on your Mac.</Text>{permission?.canAskAgain ? <Button label="Allow camera" onPress={() => void requestPermission()} variant="primary" /> : <Button label="Open Settings" onPress={() => void Linking.openSettings()} variant="primary" />}</View> : null}
      {error && !link ? <Text accessibilityRole="alert" style={[styles.error, { color: theme.red }]}>{error}</Text> : null}
      <Modal transparent animationType="slide" visible={link !== null} onRequestClose={close}>
        <View style={styles.backdrop} />
        <View style={[styles.sheet, { backgroundColor: theme.surface, borderColor: theme.borderMid }]}>
          <View style={[styles.grab, { backgroundColor: theme.borderStrong }]} />
          <Text style={[styles.title, { color: theme.text }]}>Pair with {link?.name}?</Text>
          <Text style={[styles.instruction, { color: theme.muted }]}>Connect using {trying ?? link?.urls[0]}</Text>
          {(link?.urls.length ?? 0) > 1 ? <Text style={[styles.addresses, { color: theme.muted }]}>Other pairing addresses: {link?.urls.slice(1).join(', ')}</Text> : null}
          <Text style={{ color: theme.muted }}>This phone will have its own access token. Revoke it any time from Pair a phone on your Mac.</Text>
          {error ? <Text accessibilityRole="alert" style={[styles.error, { color: theme.red }]}>{error}</Text> : null}
          <Button label={busy ? 'Pairing…' : 'Pair'} busy={busy} onPress={() => void confirm()} variant="primary" />
          <Button label="Cancel" onPress={close} />
        </View>
      </Modal>
    </SafeAreaView>
  )
}
const styles = StyleSheet.create({
  screen: { flex: 1, padding: 20, gap: 20 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 22, fontWeight: '800' },
  instruction: { fontSize: 15, lineHeight: 22 },
  viewfinder: { aspectRatio: 1, alignSelf: 'center', borderRadius: 28, borderWidth: 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  permission: { gap: 16 },
  error: { fontSize: 14, lineHeight: 20 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, padding: 20, paddingBottom: 40, gap: 16 },
  grab: { width: 36, height: 5, borderRadius: 3, alignSelf: 'center' },
  addresses: { fontSize: 12, lineHeight: 18 },
})
