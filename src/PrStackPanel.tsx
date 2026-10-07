import { useEffect, useState } from 'react'
import type { PrStack } from '../shared/pr-stacks'
import type { PrSummary, PrsApiClient } from './prsApi'
import './pr-stacks.css'

export function PrStackPanel({ repo, pr, api }: { repo: string; pr: PrSummary; api: PrsApiClient }) {
  const [stack, setStack] = useState<PrStack | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const number = pr.stack?.number
  useEffect(() => {
    let active = true
    setStack(null)
    setError('')
    if (number) void api.stack(repo, number).then((value) => { if (active) setStack(value) })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Unable to load stack') })
    return () => { active = false }
  }, [api, repo, number, retry])
  if (!number) return <p>This PR is not in a native GitHub stack. Use <strong>Create stack</strong> in the PR sidebar to link a branch chain or create a PR on top of an open PR.</p>
  if (error) return <p role="alert">{error} <button type="button" className="pr-pop-btn" onClick={() => setRetry((value) => value + 1)}>Retry stack</button></p>
  if (!stack) return <p role="status">Loading stack…</p>
  return <section className="pr-stack-panel" aria-label={`Stack #${stack.number}`}>
    <h3>Stack #{stack.number} <small>{stack.pullRequests.length} PRs · {stack.open ? 'open' : 'completed'}</small></h3>
    <p>Bottom to top · targets <code>{stack.baseRefName}</code></p>
    <ol className="pr-stack-chain">
      {stack.pullRequests.map((member, index) => <li key={member.number} aria-current={member.number === pr.number ? 'step' : undefined}>
        <span className="pr-stack-position">{index + 1}</span>
        <a href={member.url} target="_blank" rel="noreferrer">#{member.number} <code>{member.headRefName}</code></a>
        <span className={`pr-state ${member.isDraft && member.state === 'open' ? 'draft' : member.state}`}>{member.isDraft && member.state === 'open' ? 'draft' : member.state}</span>
        {member.number === pr.number ? <small>this PR</small> : null}
      </li>)}
    </ol>
  </section>
}
