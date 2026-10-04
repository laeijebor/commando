import { GitPullRequest } from 'lucide-react'
import type { PrsApiClient } from './prsApi'
import { useSessionPrCount } from './prStore'

export function SessionPrCount({ paneIds, api, enabled, sessionName }: {
  paneIds: string[]
  api: Pick<PrsApiClient, 'pane'>
  enabled: boolean
  sessionName: string
}) {
  const count = useSessionPrCount(paneIds, api, { enabled })
  if (!count) return null
  const label = `${count} open pull ${count === 1 ? 'request' : 'requests'} in ${sessionName}`
  return <span className="session-pr-count" role="img" aria-label={label} title={label}><GitPullRequest aria-hidden="true" /><span>{count}</span></span>
}
