import { describe, expect, it } from 'vitest'
import { pullRequestImpactsFor } from './pr-impact-hook.js'

const cwd = '/work/app'
const bash = (command: string, event = 'PostToolUse') => pullRequestImpactsFor({ hook_event_name: event, tool_name: 'Bash', cwd, tool_input: { command } })

describe('pullRequestImpactsFor', () => {
  it.each([
    ['git push', [{ relation: 'pushed', cwd }]],
    ['git push -u origin feat', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'feat' }]],
    ['git push --set-upstream origin feat/x-1', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'feat/x-1' }]],
    ['git push origin HEAD:refs/heads/fix', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'fix' }]],
    ['git push origin HEAD', [{ relation: 'pushed', cwd, remote: 'origin' }]],
    ['git push --force-with-lease origin +local:remote', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'remote' }]],
    ['git push --force-with-lease=feat:abc123 origin feat', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'feat' }]],
    ['git push origin a b', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'a' }, { relation: 'pushed', cwd, remote: 'origin', branch: 'b' }]],
    ['git push https://github.com/acme/widgets.git feat', [{ relation: 'pushed', cwd, repo: 'acme/widgets', branch: 'feat' }]],
    ['git push git@github.com:acme/widgets.git feat', [{ relation: 'pushed', cwd, repo: 'acme/widgets', branch: 'feat' }]],
    ['git -C ../other push origin feat', [{ relation: 'pushed', cwd: '/work/app/../other', remote: 'origin', branch: 'feat' }]],
    ['git -c core.x=1 --no-pager push', [{ relation: 'pushed', cwd }]],
    ['cd /work/api && npm test && git push 2>&1 | tail -3', [{ relation: 'pushed', cwd: '/work/api' }]],
    ['GIT_TRACE=1 git push origin feat > /tmp/push.log', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'feat' }]],
    ['git add -A; git commit -m "fix: x"; git push origin feat', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'feat' }]],
  ])('reads %j', (command, expected) => {
    expect(bash(command)).toEqual(expected)
  })

  it.each([
    ['gh pr comment 123 -b "Fixed in abc"', [{ relation: 'commented', cwd, number: 123 }]],
    ['gh pr review https://github.com/o/r/pull/5 --approve', [{ relation: 'reviewed', cwd, repo: 'o/r', number: 5 }]],
    ['gh pr review --comment -b "nit"', [{ relation: 'reviewed', cwd }]],
    ['gh pr merge', [{ relation: 'commented', cwd }]],
    ['gh pr merge 7 --squash --delete-branch', [{ relation: 'commented', cwd, number: 7 }]],
    ['gh pr edit feat-branch --title "New title" --add-label bug', [{ relation: 'commented', cwd, branch: 'feat-branch' }]],
    ['gh pr close 9 -c "superseded by #10"', [{ relation: 'commented', cwd, number: 9 }]],
    ['gh pr ready 12 -R acme/widgets', [{ relation: 'commented', cwd, repo: 'acme/widgets', number: 12 }]],
    ['gh pr comment --repo github.com/acme/widgets 4 --body-file /tmp/b.md', [{ relation: 'commented', cwd, repo: 'acme/widgets', number: 4 }]],
    ['gh pr comment someone:their-branch -b hi', [{ relation: 'commented', cwd, branch: 'their-branch', headOwner: 'someone' }]],
    ['GH_REPO=acme/widgets gh pr comment 5 -b hi', [{ relation: 'commented', cwd, repo: 'acme/widgets', number: 5 }]],
    // Like the shell, `#5` starts a comment, so this ran on the current branch's PR.
    ['gh pr comment #5', [{ relation: 'commented', cwd }]],
    ['git push && gh pr comment 3 -b done', [{ relation: 'pushed', cwd }, { relation: 'commented', cwd, number: 3 }]],
  ])('reads %j', (command, expected) => {
    expect(bash(command)).toEqual(expected)
  })

  it.each([
    ['echo $(date) && git push origin feat', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'feat' }]],
    [`git commit -m "$(cat <<'EOF'\nfix: handle (nested) parens\n\ngit push origin nope\nEOF\n)" && git push`, [{ relation: 'pushed', cwd }]],
    ['X=$(git push origin a); git push origin b', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'b' }]],
    ['cd "$(git rev-parse --show-toplevel)" && git push https://github.com/acme/widgets feat', [{ relation: 'pushed', repo: 'acme/widgets', branch: 'feat' }]],
    ['git -C "$WT" push https://github.com/acme/widgets feat', [{ relation: 'pushed', repo: 'acme/widgets', branch: 'feat' }]],
    ['cd ~/x && gh pr comment https://github.com/acme/widgets/pull/3 -b ok', [{ relation: 'commented', repo: 'acme/widgets', number: 3 }]],
  ])('keeps reading past a substitution or lost directory: %j', (command, expected) => {
    expect(bash(command)).toEqual(expected)
  })

  // Exit 0 only proves the last list (commands joined by && and pipes) succeeded.
  it.each([
    ['git add -A && git commit -m "fix: x" && git push', [{ relation: 'pushed', cwd }]],
    ['npm test && git push origin feat 2>&1 | tail -2', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'feat' }]],
    ['git push origin feat &> /tmp/push.log', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'feat' }]],
    ['git status\ngit push origin feat\n', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'feat' }]],
    ['(cd /work/other && git status); git push origin feat', [{ relation: 'pushed', cwd, remote: 'origin', branch: 'feat' }]],
    ['(cd /work/other); gh pr comment 5 -b hi', [{ relation: 'commented', cwd, number: 5 }]],
    ['cd /work/api && (npm test) && git push', [{ relation: 'pushed', cwd: '/work/api' }]],
  ])('counts only the list that decided the exit status: %j', (command, expected) => {
    expect(bash(command)).toEqual(expected)
  })

  it.each([
    'git push origin a || git push origin b',
    'gh pr comment 42 -b hi || true',
    'false && gh pr comment 42 -b hi; echo done',
    'git push origin feat; echo "exit $?"',
    'git push origin feat\necho pushed',
    'git push origin feat &',
    'git push origin feat & wait',
    '(git push origin feat)',
    '(cd /work/other && git push origin feat)',
    'pushd /work/other && popd && git push',
    'test -n "$X" || gh pr merge 3',
  ])('reports nothing when the command may not have run or succeeded: %j', (command) => {
    expect(bash(command)).toBeUndefined()
  })

  it('ignores the PR body written through a heredoc in a substitution', () => {
    const command = `gh pr comment 42 --body "$(cat <<'EOF'
Pushed the fix. "Quoted" (and a paren
git push origin main
EOF
)"`
    expect(bash(command)).toEqual([{ relation: 'commented', cwd, number: 42 }])
  })

  it.each([
    'echo "git push origin feat"',
    "echo 'gh pr comment 5 -b x'",
    'printf "%s" git push',
    'cat <<EOF\ngit push origin feat\ngh pr merge 3\nEOF',
    'git push --dry-run origin feat',
    'git push origin --delete feat',
    'git push origin :feat',
    'git push origin --tags',
    'git push origin v1.0:refs/tags/v1.0',
    'git push origin "$BRANCH"',
    'git push origin $(git branch --show-current)',
    'gh pr comment "$PR" -b hi',
    'gh pr view 5',
    'gh pr create --title x',
    'gh pr checks 5',
    'git status # then git push',
    'bash -c "git push"',
    'git pushx',
    'gh pr comment 5 -R "$REPO"',
    'GH_REPO=$R gh pr comment 5',
    'git -C "$WT" push origin feat',
    'git --git-dir=/x/.git push origin feat',
    'cd ~/x && git push',
    'cd "$DIR" && gh pr comment 5 -b hi',
  ])('ignores %j', (command) => {
    expect(bash(command)).toBeUndefined()
  })

  it('only reads a completed Bash call', () => {
    expect(bash('git push', 'PreToolUse')).toBeUndefined()
    expect(bash('git push', 'PostToolUseFailure')).toBeUndefined()
    expect(pullRequestImpactsFor({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { command: 'git push' } })).toBeUndefined()
    expect(pullRequestImpactsFor({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git push ' + 'x'.repeat(20_001) } })).toBeUndefined()
  })

  it('leaves out an unusable working directory', () => {
    expect(pullRequestImpactsFor({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: 'relative', tool_input: { command: 'git push' } }))
      .toEqual([{ relation: 'pushed' }])
    // A relative cd from an unknown directory leads nowhere the daemon can follow.
    expect(pullRequestImpactsFor({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cd sub && git push' } }))
      .toBeUndefined()
  })

  it('keeps at most ten', () => {
    expect(bash(Array.from({ length: 12 }, (_, index) => `gh pr comment ${index + 1} -b x`).join(' && '))).toHaveLength(10)
  })

  it('reads GitHub MCP tools', () => {
    const mcp = (name: string, toolInput: Record<string, unknown>) => pullRequestImpactsFor({ hook_event_name: 'PostToolUse', tool_name: `mcp__github__${name}`, tool_input: toolInput })
    expect(mcp('add_issue_comment', { owner: 'acme', repo: 'widgets', issue_number: 4, body: 'x' })).toEqual([{ relation: 'commented', repo: 'acme/widgets', number: 4 }])
    expect(mcp('create_pull_request_review', { owner: 'acme', repo: 'widgets', pullNumber: '6', event: 'APPROVE' })).toEqual([{ relation: 'reviewed', repo: 'acme/widgets', number: 6 }])
    expect(mcp('merge_pull_request', { owner: 'acme', repo: 'widgets', pull_number: 8 })).toEqual([{ relation: 'commented', repo: 'acme/widgets', number: 8 }])
    expect(mcp('push_files', { owner: 'acme', repo: 'widgets', branch: 'feat', files: [] })).toEqual([{ relation: 'pushed', repo: 'acme/widgets', branch: 'feat' }])
    expect(mcp('get_pull_request', { owner: 'acme', repo: 'widgets', pullNumber: 8 })).toBeUndefined()
    expect(mcp('add_issue_comment', { owner: 'acme', repo: 'bad repo', issue_number: 4 })).toBeUndefined()
    expect(mcp('add_issue_comment', { owner: 'acme', repo: 'widgets', issue_number: -4 })).toBeUndefined()
  })
})
