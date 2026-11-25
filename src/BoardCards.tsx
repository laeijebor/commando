import { File, GitPullRequest, Images, LayoutDashboard, Link, ListChecks, MonitorPlay, NotebookPen, Presentation, Shapes, StickyNote, Video } from 'lucide-react'
import { memo, useState, type PointerEvent } from 'react'
import type { BoardItemKind } from '../shared/board'
import type { PanePrSummary } from './prsApi'
import { PrBadges } from './PrBadges'
import type { BoardEntry } from './BoardGeometry'

export const BOARD_STATE_LABELS = { open: 'Open', closed: 'Closed (revive)', snapshot: 'Snapshot', missing: 'Gone' }
const ICONS = { pr: GitPullRequest, canvas: LayoutDashboard, redline: NotebookPen, guide: ListChecks, slides: Presentation, diagram: Shapes, screenshot: Images, video: Video, link: Link, file: File, clip: StickyNote, page: MonitorPlay }
const KIND_LABELS: Record<BoardItemKind, string> = { pr: 'Pull request', canvas: 'Canvas', redline: 'Redline', guide: 'Guide', slides: 'Slides', diagram: 'Diagram', screenshot: 'Screenshot', video: 'Video', link: 'Link', file: 'File', clip: 'Clipping', page: 'Page' }
export const boardKindLabel = (item: BoardEntry) => KIND_LABELS[item.kind]
export type BoardThumbUrl = (item: BoardEntry, size: 320 | 960) => string

export function BoardPreview({ item, thumbUrl, large = false, lowDetail = false }: { item: BoardEntry; thumbUrl: BoardThumbUrl; large?: boolean; lowDetail?: boolean }) {
  const [failed, setFailed] = useState('')
  const hasImage = Boolean(item.thumb || item.preview?.image)
  const src = hasImage ? thumbUrl(item, large ? 960 : 320) : undefined
  const Icon = ICONS[item.kind]
  return <div className={`board-preview kind-${item.kind}${large ? ' is-large' : ''}`}>
    {src && src !== failed ? <img src={src} srcSet={hasImage && !lowDetail ? `${thumbUrl(item, 320)} 320w, ${thumbUrl(item, 960)} 960w` : undefined}
      sizes={large ? '960px' : '208px'} loading="lazy" decoding="async" alt="" onError={() => setFailed(src)} />
      : <div className="board-placeholder"><Icon aria-hidden="true" /><span>{item.kind === 'clip' ? item.caption || item.title : KIND_LABELS[item.kind]}</span>
        {['canvas', 'diagram', 'guide', 'slides', 'redline'].includes(item.kind) && <div className="board-placeholder-shapes"><i /><i /><i /></div>}
      </div>}
    {item.kind === 'video' && <span className="board-video-play" aria-hidden="true">▶</span>}
  </div>
}

export const BoardCard = memo(function BoardCard({ item, thumbUrl, onOpen, onPointerDown, lod = 'full', pr, compact = false }: {
  item: BoardEntry; thumbUrl: BoardThumbUrl; onOpen: (item: BoardEntry, trigger: HTMLElement) => void
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>, item: BoardEntry) => void
  lod?: 'full' | 'thumbnail'; pr?: PanePrSummary; compact?: boolean
}) {
  const title = pr?.title || item.title || item.preview?.title
  return <button type="button" className={`board-card${compact ? ' is-compact' : ''} kind-${item.kind} lod-${lod}`} data-board-key={item.key}
    aria-label={`Quick look: ${title}`} onClick={(event) => onOpen(item, event.currentTarget)} onPointerDown={(event) => onPointerDown?.(event, item)}>
    <div className="board-card-cover">
      <BoardPreview item={item} thumbUrl={thumbUrl} lowDetail={lod === 'thumbnail'} />
      {lod === 'full' && <><span className="board-kind">{boardKindLabel(item)}</span><span className={`board-state state-${item.state}`}>{BOARD_STATE_LABELS[item.state]}</span></>}
    </div>
    <span className="board-card-meta"><strong title={title}>{item.pinned && <span aria-label="Pinned">⌖ </span>}{item.ref.pr && `#${item.ref.pr.number} · `}{title}</strong>
      {lod === 'full' && <small>{pr ? `${pr.isDraft ? 'Draft' : pr.state} · ${pr.repo}` : item.preview?.siteName || item.caption || item.preview?.description || item.ref.url || item.ref.path || item.source}</small>}
      {pr && lod === 'full' && !compact && <span className="board-pr-badges"><PrBadges pr={pr} number={pr.number} /></span>}
    </span>
  </button>
})
