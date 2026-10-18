import { useId } from 'react'
import { sessionAvatarSvg, type SessionIdentity } from '../shared/session-identity'

/** Decorative: the surrounding row supplies the accessible session name. */
export function SessionAvatar({ identity, size = 18, glyph = false }: { identity: SessionIdentity; size?: number; glyph?: boolean }) {
  const id = useId()
  return glyph
    ? <span aria-hidden="true" className="session-glyph-tile" style={{ width: size, height: size, backgroundColor: `${identity.color}30`, color: identity.color }}>{identity.glyph}</span>
    : <span aria-hidden="true" className="session-avatar" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: sessionAvatarSvg(identity, size, `session-${id}`) }} />
}
