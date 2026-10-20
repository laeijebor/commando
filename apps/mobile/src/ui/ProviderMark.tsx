import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme'
import { providerPresentation } from './providerPresentation'
import { withAlpha } from './primitives'

export function ProviderMark({ provider }: { provider?: string }): React.JSX.Element {
  const theme = useTheme()
  const presentation = providerPresentation(provider)
  const color = theme[presentation.accent]
  return <View accessibilityLabel={presentation.name} style={[styles.mark, { backgroundColor: withAlpha(color, 0.13), borderColor: withAlpha(color, 0.23) }]}><Text style={[styles.glyph, { color }]}>{presentation.mark}</Text></View>
}
const styles = StyleSheet.create({
  mark: { minWidth: 25, height: 21, paddingHorizontal: 4, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 9, fontWeight: '700', letterSpacing: 0.3 },
})
