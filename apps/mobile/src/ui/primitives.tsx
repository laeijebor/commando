import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native'

import type { AgentProvider, AgentStatusKind } from '@commando/protocol'
import { statusColor, useTheme, type Theme } from '../theme'
import { providerLabel } from '../agents/selectors'

export function ScreenTitle({ title, trailing }: { title: string; trailing?: ReactNode }): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={styles.screenTitle}>
      <Text style={[styles.screenTitleText, { color: theme.text }]}>{title}</Text>
      {trailing}
    </View>
  )
}

export function SectionHeader({ label, note }: { label: string; note?: string }): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={styles.sectionHeader}>
      <Text style={[styles.sectionLabel, { color: theme.muted }]}>{label.toUpperCase()}</Text>
      {note ? <Text style={[styles.sectionNote, { color: theme.textDim }]}>{note}</Text> : null}
    </View>
  )
}

export function Card({
  children,
  raised,
  style,
}: {
  children: ReactNode
  raised?: boolean
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: raised ? theme.surfaceRaised : theme.surface, borderColor: theme.border },
        style,
      ]}
    >
      {children}
    </View>
  )
}

export type DotTone = 'accent' | 'amber' | 'green' | 'red' | 'muted' | 'cyan'

export function Dot({
  tone,
  size = 8,
  hollow,
  square,
}: {
  tone: DotTone
  size?: number
  hollow?: boolean
  square?: boolean
}): React.JSX.Element {
  const theme = useTheme()
  const color = toneColor(theme, tone)
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: square ? 2 : size / 2,
        backgroundColor: hollow ? 'transparent' : color,
        borderWidth: hollow ? 2 : 0,
        borderColor: color,
      }}
    />
  )
}

function toneColor(theme: Theme, tone: DotTone): string {
  switch (tone) {
    case 'accent':
      return theme.accent
    case 'amber':
      return theme.amber
    case 'green':
      return theme.green
    case 'red':
      return theme.red
    case 'cyan':
      return theme.cyan
    default:
      return theme.textFaint
  }
}

/**
 * Status dots follow the desktop shapes described in the mockup: a filled
 * circle while working, amber for a pending question, a hollow ring when done
 * and a red square for a failure.
 */
export function StatusDot({ status, size = 9 }: { status: AgentStatusKind; size?: number }): React.JSX.Element {
  const theme = useTheme()
  const color = statusColor(theme, status)
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: status === 'failed' ? 2 : size / 2,
        backgroundColor: status === 'done' ? 'transparent' : color,
        borderWidth: status === 'done' ? 2 : 0,
        borderColor: color,
      }}
    />
  )
}

export function Pill({
  label,
  tone = 'mute',
}: {
  label: string
  tone?: 'claude' | 'codex' | 'opencode' | 'shell' | 'mute' | 'ok' | 'warn' | 'bad'
}): React.JSX.Element {
  const theme = useTheme()
  const [background, color] = pillColors(theme, tone)
  return (
    <View style={[styles.pill, { backgroundColor: background }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  )
}

function pillColors(theme: Theme, tone: string): [string, string] {
  switch (tone) {
    case 'claude':
      return [withAlpha(theme.accent, 0.16), theme.accent]
    case 'codex':
      return [withAlpha(theme.cyan, 0.14), theme.cyan]
    case 'opencode':
      return [withAlpha(theme.amber, 0.14), theme.amber]
    case 'ok':
      return [withAlpha(theme.green, 0.14), theme.green]
    case 'warn':
      return [withAlpha(theme.amber, 0.16), theme.amber]
    case 'bad':
      return [withAlpha(theme.red, 0.16), theme.red]
    default:
      return [theme.surfaceSoft, theme.muted]
  }
}

export function ProviderPill({ provider }: { provider: AgentProvider }): React.JSX.Element {
  const tone = provider === 'claude' || provider === 'codex' || provider === 'opencode' ? provider : 'mute'
  return <Pill label={providerLabel(provider)} tone={tone} />
}

/** `#rrggbb` + alpha → `rgba(...)`, so tokens stay single-sourced as hex. */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  if (value.length !== 6) return hex
  const red = Number.parseInt(value.slice(0, 2), 16)
  const green = Number.parseInt(value.slice(2, 4), 16)
  const blue = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

export function ProgressBar({
  ratio,
  tone = 'accent',
}: {
  ratio: number
  tone?: DotTone
}): React.JSX.Element {
  const theme = useTheme()
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  return (
    <View style={[styles.bar, { backgroundColor: theme.surfaceSoft }]}>
      <View
        style={{
          width: `${clamped * 100}%`,
          height: '100%',
          borderRadius: 2,
          backgroundColor: toneColor(theme, tone),
        }}
      />
    </View>
  )
}

export function Button({
  label,
  onPress,
  variant = 'default',
  disabled,
  busy,
  style,
}: {
  label: string
  onPress: () => void
  variant?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  busy?: boolean
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  const theme = useTheme()
  const primary = variant === 'primary'
  const danger = variant === 'danger'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={[
        styles.button,
        {
          backgroundColor: primary
            ? theme.accent
            : danger
              ? withAlpha(theme.red, 0.12)
              : theme.surfaceSoft,
          borderColor: primary ? 'transparent' : danger ? withAlpha(theme.red, 0.3) : theme.borderMid,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? theme.accentInk : theme.text} size="small" />
      ) : (
        <Text
          style={[
            styles.buttonLabel,
            { color: primary ? theme.accentInk : danger ? theme.red : theme.text },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (next: T) => void
}): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={[styles.segmented, { backgroundColor: theme.surfaceRaised, borderColor: theme.border }]}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              active ? { backgroundColor: theme.surfaceSoft } : null,
            ]}
          >
            <Text style={[styles.segmentLabel, { color: active ? theme.text : theme.muted }]}>
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function EmptyState({ title, body }: { title: string; body?: string }): React.JSX.Element {
  const theme = useTheme()
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: theme.textSoft }]}>{title}</Text>
      {body ? <Text style={[styles.emptyBody, { color: theme.muted }]}>{body}</Text> : null}
    </View>
  )
}

export function Meta({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }): React.JSX.Element {
  const theme = useTheme()
  return <Text style={[styles.meta, { color: theme.muted }, style]}>{children}</Text>
}

export const styles = StyleSheet.create({
  screenTitle: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 12,
  },
  screenTitleText: { fontSize: 32, fontWeight: '800', letterSpacing: -0.6 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 4,
  },
  sectionLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  sectionNote: { fontSize: 12 },
  card: { borderWidth: 1, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14 },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  pillText: { fontSize: 11, fontWeight: '600' },
  bar: { height: 4, borderRadius: 2, overflow: 'hidden' },
  button: {
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonLabel: { fontSize: 15, fontWeight: '600' },
  segmented: { flexDirection: 'row', borderRadius: 10, borderWidth: 1, padding: 3, gap: 3 },
  segment: { flex: 1, borderRadius: 8, paddingVertical: 7, alignItems: 'center' },
  segmentLabel: { fontSize: 13, fontWeight: '600' },
  empty: { paddingVertical: 32, paddingHorizontal: 8, gap: 6 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  emptyBody: { fontSize: 13, lineHeight: 19 },
  meta: { fontSize: 12 },
})
