---
name: merge-all
description: Merge this chat's ready pull requests on GitHub, then move local next into main. Use when the user runs /merge-all or asks to merge this chat's PRs and promote next.
---

# Merge this chat's ready PRs, then next into main

Running `/merge-all` is the user's explicit say-so for two things, and only
these: merging the **ready** PRs this chat opened, and fast-forwarding local
`main` to `next`. It does not cover other chats' PRs, PRs that aren't ready,
pushing `main` or `next`, deploys, or force-pushes.

`MAIN` below is the main checkout (`git worktree list | head -1`).

## 1. Find this chat's PRs and check readiness

```sh
node .claude/skills/merge-all/ready-prs.mjs
```

It finds open PRs whose description carries this pane's Commando marker
(`commando-pr-marker.mjs`) and checks each one. A PR is **ready** only when:

- it is not a draft, and GitHub reports it mergeable with a clean merge state
- every status check passed (no checks counts as passed)
- it has an approving review and no outstanding change request
- no bot finding is open: Codex's latest review has no unresolved findings and
  isn't still running, and no other bot (CodeRabbit) has an unresolved, current
  thread

If the script can't find the marker, stop and say this chat's PRs can't be
identified; don't guess from branch names. Show the user a short table of every
PR with ready/not ready and the reasons. **Never merge a PR that isn't ready,
and don't fix or override its blockers here.** Report them instead; fixing
them is separate work the user can ask for.

## 2. Make sure each ready PR is on `next`

`main` is moved from `next`, so a PR merged on GitHub must also be on `next`.
The script's `missingFromNext` lists the PR's own commits that `next` has
neither as the same patch nor under the same subject (a conflict-resolved
cherry-pick keeps its subject). An empty list means it's on `next`.

If commits are missing, integrate the PR into `next` first, exactly as
CLAUDE.md's "Integrate into next" describes: a short-lived integration
worktree, `npm run typecheck` and `npm test`, then `git fetch . HEAD:next`.
When the branch has fallen behind `origin/main`, cherry-pick only its own
commits (`git log --no-merges $(git merge-base origin/main <head>)..<head>`)
rather than merging the branch, so commits that reached `next` another way
don't conflict. If the checks fail, don't merge that PR; report it. Rerun the
script afterwards and check `missingFromNext` is empty.

## 3. Merge the ready PRs on GitHub

Merge each one with a merge commit (the repo's style), pinned to the head that
was checked, so a push made since then isn't merged unchecked:

```sh
gh pr merge <number> --merge --match-head-commit <head>
gh pr view <number> --json state --jq .state   # MERGED
```

If a merge is refused, report why and go on with the others.

## 4. Move `next` into `main`

This restarts the user's running daemon (`tsx watch`); the user asked for that
by running this skill.

1. `MAIN` must be on `main` with a clean status. If not, stop and report it;
   never stash, reset or commit someone else's changes.
2. Check for dependency changes:
   `git -C "$MAIN" diff --stat main next -- package.json pnpm-lock.yaml package-lock.json 'apps/*/package.json' 'apps/*/package-lock.json'`.
   If dependencies changed (not just scripts or test config), stop and ask
   before going on: the live stack needs an install and a restart, and running
   `npm install` under the live `desktop:dev` has crashed it before.
3. `git -C "$MAIN" merge --ff-only next`. If `main` has moved on, merge `main`
   into `next` through an integration worktree (as in CLAUDE.md), run
   typecheck and tests there, update `next`, and retry the fast-forward.
4. Check the daemon comes back: something should listen on port 4310 again
   within a minute (`lsof -nP -iTCP:4310 -sTCP:LISTEN`). If it doesn't, say so
   at once.

Never push `main` or `next`.

## 5. Tidy up and report

- For each merged PR, delete its local branch only if
  `git -C "$MAIN" merge-base --is-ancestor <branch> next` succeeds (use
  `git branch -D`, since `-d` checks against the checked-out `main`). Keep
  branches whose commits reached `next` as cherry-picks, and keep any worktree
  another chat (or this one) is still running in.
- Report: the PRs merged (number, title, merge commit), the PRs left with their
  reasons, `main`'s new commit, how many commits moved from `next`, and whether
  the daemon came back.
