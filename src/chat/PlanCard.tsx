// After t3code (MIT, T3 Tools Inc.): apps/web/src/components/chat/ProposedPlanCard.tsx.
// Copy and "Save to vault" replace its download and save-to-workspace actions.
import { useState, type ReactNode } from 'react'
import { BookmarkPlus, Check, Copy, ListChecks } from 'lucide-react'
import { chatPlanTitle } from '../../shared/agent-chat'
import { cn } from './cn'
import { canCollapsePlan, collapsedPlanPreview, planBody, type PlanItem } from '../../shared/chat-timeline'
import { Button } from './ui/button'

export type SavePlan = (markdown: string) => Promise<{ path: string }>

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; path: string } | { kind: 'failed'; error: string }

/** `~/…` reads better than the home folder in full. */
function homePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+\//, '~/')
}

export function PlanCard({ item, markdown: Markdown, onSave }: {
  item: PlanItem
  /** The timeline's Markdown renderer. */
  markdown: (props: { text: string }) => ReactNode
  onSave?: SavePlan
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [copyError, setCopyError] = useState<string | null>(null)
  const collapsible = canCollapsePlan(item.text)
  const collapsed = collapsible && !expanded
  const copy = () => {
    setCopyError(null)
    // The clipboard API needs a secure page; Commando over a LAN address isn't one.
    if (!navigator.clipboard) {
      setCopyError("This page can't use the clipboard; select the plan text to copy it")
      return
    }
    navigator.clipboard.writeText(`${item.text.trimEnd()}\n`).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      () => setCopyError("Couldn't copy the plan to the clipboard"),
    )
  }
  const saveToVault = () => {
    if (!onSave) return
    setSave({ kind: 'saving' })
    onSave(item.text).then(
      (saved) => setSave({ kind: 'saved', path: saved.path }),
      (error: unknown) => setSave({ kind: 'failed', error: error instanceof Error ? error.message : 'The plan was not saved' }),
    )
  }
  return (
    <section className="mb-3 rounded-xl border border-border bg-card px-3.5 py-3" aria-label="Plan" data-testid="plan-card">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-primary">
          <ListChecks className="size-3" aria-hidden="true" />
          Plan
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{chatPlanTitle(item.text)}</h3>
        <Button size="icon-xs" variant="ghost-muted" aria-label={copied ? 'Copied' : 'Copy plan'} title="Copy plan" onClick={copy}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
        {onSave ? (
          <Button size="xs" variant="outline" disabled={save.kind === 'saving'} onClick={saveToVault} title="Save as a note in the default Commando vault">
            <BookmarkPlus aria-hidden="true" />
            {save.kind === 'saving' ? 'Saving…' : save.kind === 'saved' ? 'Saved' : 'Save to vault'}
          </Button>
        ) : null}
      </div>
      <div className={cn('relative mt-2', collapsed && 'max-h-80 overflow-hidden')}>
        <Markdown text={collapsed ? collapsedPlanPreview(item.text) : planBody(item.text)} />
        {collapsed ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-card to-transparent" /> : null}
      </div>
      {collapsible ? (
        <div className="mt-2 flex justify-center">
          <Button size="xs" variant="outline" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Collapse plan' : 'Expand plan'}
          </Button>
        </div>
      ) : null}
      {save.kind === 'saved' ? (
        <p className="mt-2 break-all text-xs text-muted-foreground" role="status">Saved to <span className="font-mono text-secondary-label" title={save.path}>{homePath(save.path)}</span></p>
      ) : save.kind === 'failed' ? (
        <p className="mt-2 text-xs text-destructive" role="alert">{save.error}</p>
      ) : null}
      {copyError ? <p className="mt-2 text-xs text-destructive" role="alert">{copyError}</p> : null}
    </section>
  )
}
