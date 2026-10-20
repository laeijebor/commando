import { useId } from 'react'
import { SvgXml } from 'react-native-svg'
import { sessionAvatarSvg, type SessionIdentity } from '@commando/session-identity'

export function SessionAvatar({ identity, size = 32 }: { identity: SessionIdentity; size?: number }): React.JSX.Element {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  return <SvgXml accessible={false} xml={sessionAvatarSvg(identity, size, `avatar${id}`)} width={size} height={size} />
}
