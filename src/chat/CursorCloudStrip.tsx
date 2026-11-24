import type { ChatSessionInfo } from '../../shared/agent-chat'
import type { PrQuickLookTab } from '../PrQuickLook'

export function CursorCloudStrip({ cloud, onOpenPr }: {
  cloud: NonNullable<ChatSessionInfo['cloud']>
  onOpenPr?: (repo: string, number: number, tab: PrQuickLookTab) => void
}) {
  const repo = cloud.repoUrl.replace('https://github.com/', '')
  const pr = cloud.prUrl ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/.exec(cloud.prUrl) : null
  return (
    <section className="chat-cloud-strip" aria-label="Cursor cloud">
      <div>
        <span>☁️ Cursor cloud · {repo}</span>
        {cloud.branch ? <a href={`${cloud.repoUrl}/tree/${cloud.branch}`} target="_blank" rel="noreferrer">{cloud.branch}</a> : null}
        {cloud.prUrl ? <a href={cloud.prUrl} target="_blank" rel="noreferrer" onClick={(event) => {
          if (!pr || !onOpenPr || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
          event.preventDefault()
          onOpenPr(pr[1]!, Number(pr[2]), 'Description')
        }}>{pr ? `PR #${pr[2]}` : 'Pull request'}</a> : null}
        {cloud.webUrl ? <a href={cloud.webUrl} target="_blank" rel="noreferrer">Open on cursor.com</a> : null}
        <span className="chat-cloud-strip__actions" />
      </div>
    </section>
  )
}
