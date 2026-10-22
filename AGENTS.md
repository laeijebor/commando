# Agent instructions

## Workflow

- **Work in a git worktree, not on `main` directly.** Create a worktree with a feature branch before making changes:

  ```sh
  git worktree add ../commando-<feature> -b <feature>
  ```

  Do all work inside that worktree so `main` and other agents' work stay untouched.

- **Commit as you go.** Make small, focused commits at each meaningful step — don't batch everything into one commit at the end. Write clear, conventional commit messages (`feat:`, `fix:`, `refactor:`, ...).

- **Use the default Commando vault for planning.** Treat the relevant Markdown note in `~/.commando/notes-vaults/default` as the source of truth for plans and task status. Update its checklist as work progresses, and mark items complete only after verification.

- **Integrate into `next`, not `main`.** Every merge into local `main` restarts the user's running daemon (`tsx watch`) and interrupts their work. Finished work therefore collects on a local `next` branch, and the user moves `next` into `main` in one go when a few items are ready.

  Before integrating into `next`:
  1. `npm run typecheck` passes
  2. `npm test` passes (vitest)
  3. You have exercised the feature end-to-end where practical (e.g. `npm run dev` and drive the affected flow, or the relevant Playwright test)

  **Integrating into `next` is the default, with standing user authorization.** Once the checks above pass, integrate the branch into `next` without asking. Do not stop at opening a PR. An explicit request to leave work unintegrated or await review takes precedence.

  **Never merge into local `main` yourself.** Only the user decides when `next` reaches `main`, or asks you to do it. The one exception is a change that cannot interrupt the running session, such as a docs-only change to this file that agents need to see; that may go straight to `main`.

  `next` is a local branch, like local `main`: never push it and never check it out (keeping it unchecked-out is what lets `git fetch . HEAD:next` update it). Integrate through a short-lived worktree so your feature branch stays clean for its PR:

  ```sh
  MAIN=<main-checkout>
  git -C "$MAIN" branch next main 2>/dev/null || true       # first time only: start next from local main
  git -C "$MAIN" worktree add ../commando-integrate-<feature> -b integrate-<feature> next
  cd ../commando-integrate-<feature>
  git merge main                                            # keep next level with main
  git merge <feature>                                       # resolve any conflicts here
  # If either merge needed conflict resolution, run typecheck and tests in this worktree.
  git fetch . HEAD:next                                     # fast-forward only; if next moved, merge next and retry
  cd - && git -C "$MAIN" worktree remove ../commando-integrate-<feature>
  git -C "$MAIN" branch -D integrate-<feature>
  ```

  **Preserve the active session.** Preserve unrelated commits and untracked files; never reset, stash, or overwrite another agent's work, including what is already on `next`. Ask first if applying the change would require restarting/reconfiguring the shared daemon or tmux server, or a migration or destructive operation.

  **Moving `next` into `main` (only when the user asks).** Confirm the main checkout is clean, then `git -C "$MAIN" merge --ff-only next`. If `main` has moved on, merge `main` into `next` through an integration worktree as above, test, and retry.

  **Remote merging is separate.** Opening a PR does not block integrating into `next`. Merge on GitHub / `origin/main` only when the user requests it, after any required review is complete. Do not push unrelated local-only commits as part of merging a PR remotely.

  After integrating, remove only your own finished worktree (`git -C "$MAIN" worktree remove ../commando-<feature>`). Keep the feature branch while its PR is open; once the PR is merged or closed, delete it if `git -C "$MAIN" merge-base --is-ancestor <feature> next` succeeds (`git branch -d` refuses, because it checks against the checked-out `main`).

  If any check fails, do not integrate — fix it in the worktree first, or leave the branch unintegrated and report what's failing.

## Session Isolation

- Preserve ongoing tmux and Commando sessions whenever possible. Do not attach to, kill, restart, or reconfigure a shared tmux server or Commando daemon unless explicitly requested.
- When testing Commando, use a separate tmux server/socket and separate ports. Set `COMMANDO_TMUX_SOCKET_NAME` and `COMMANDO_PORT` to feature-specific values, and pass a separate Vite port with `vite --port` (for example, daemon `4410` and web `5273`).
- Daemons on a non-default port skip GitHub (PR lists, quick look, branch PR badges) so test daemons don't drain the user's shared API budget. Set `COMMANDO_GITHUB=on` only when the feature under test needs GitHub, and stop that daemon when done.
- Avoid broad cleanup commands such as `tmux kill-server`, `pkill`, or stopping shared dev servers. Clean up only processes and resources launched by the agent.

## Commands

- `npm run dev` — start daemon (tsx watch) + web (vite) together
- `npm run build` — typecheck and build for production
- `npm run typecheck` — `tsc -b`
- `npm test` — run unit tests with vitest
- `npm run test:e2e:terminal` — Playwright terminal-fidelity e2e tests
