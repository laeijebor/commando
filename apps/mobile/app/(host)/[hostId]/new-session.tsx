import { PlaceholderScreen } from '../../../src/ui/Placeholder'

export default function NewSessionScreen(): React.JSX.Element {
  return (
    <PlaceholderScreen
      planned={[
        'Name, window, directory history and branch fields from the desktop create dialog',
        'Worktree block (branch, path, preparation command) for POST /api/tmux/sessions',
        'Agent picker plus opening prompt, launched with POST /api/pane-management/panes/:id/run',
        'Lighter variants of the same sheet for new windows and split panes',
      ]}
      summary="Start a session with a worktree and an agent in one go — screen 07 of the mockups."
      title="New session"
    />
  )
}
