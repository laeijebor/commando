import { PlaceholderScreen } from '../../../src/ui/Placeholder'

export default function ActivityScreen(): React.JSX.Element {
  return (
    <PlaceholderScreen
      planned={[
        'Worklog timeline from session_brief updates, newest first',
        'Recap cards with the agent headline and changed-file counts',
        'Filters by session and by update kind (changed / decision / check / blocker)',
      ]}
      summary="A cross-session feed of what the agents have been doing — the desktop worklog, flattened."
      title="Activity"
    />
  )
}
