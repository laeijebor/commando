import Feather from '@expo/vector-icons/Feather'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useTheme } from '../theme'

/** A video attached on the desktop. The phone doesn't play them, so it shows a film mark where the thumbnail would be. */
export function VideoTile({ name, style }: { name: string; style: StyleProp<ViewStyle> }): React.JSX.Element {
  const theme = useTheme()
  return (
    <View accessible accessibilityLabel={`Video: ${name}`} style={[style, styles.tile, { borderColor: theme.border, backgroundColor: theme.surface }]}>
      <Feather color={theme.textSoft} name="film" size={18} />
    </View>
  )
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center' },
})
