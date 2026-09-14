---
name: commando-prs
description: Link pull requests to their originating Commando pane. Use when creating a PR or editing its description from a tmux pane, including gh pr create and GitHub MCP tools.
---

# Pull request provenance

When creating a PR from a Commando pane, retrieve its ownership marker:

```sh
node "$HOME/.commando/hooks/commando-pr-marker.mjs"
```

Append the returned HTML comment exactly once to the PR description **before
creating it**, regardless of whether you use `gh pr create`, a body file, or a
GitHub MCP tool. Keep it when editing the description. It is hidden on GitHub
and makes Commando's HUD and pane worklog link back to this pane.

Do not hard-code UUIDs, copy a marker from another PR, or infer ownership from
a matching branch name. A branch can be used by several panes. If the CLI
fails, report that pane linkage could not be established; never silently
claim success. These instructions do not grant permission to create a PR.

## Existing PRs

Only add a missing marker after confirming which pane actually created the
PR, using its creation transcript or explicit user confirmation. Obtain the
marker from that pane and preserve the full existing description. Leave
markers belonging to closed/recreated panes intact; a newly created pane is
not automatically the same owner.
