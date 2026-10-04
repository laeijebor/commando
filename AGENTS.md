# Agent instructions

## Workflow

- **Work in a git worktree, not on `main` directly.** Create a worktree with a feature branch before making changes:

  ```sh
  git worktree add ../commando-<feature> -b <feature>
  ```

  Do all work inside that worktree so `main` and other agents' work stay untouched.

- **Commit as you go.** Make small, focused commits at each meaningful step — don't batch everything into one commit at the end. Write clear, conventional commit messages (`feat:`, `fix:`, `refactor:`, ...).

- **Use the default Commando vault for planning.** Treat the relevant Markdown note in `~/.commando/notes-vaults/default` as the source of truth for plans and task status. Update its checklist as work progresses, and mark items complete only after verification.

- **Merge only when the feature is finished and tested.** Before merging back into `main`:
  1. `npm run typecheck` passes
  2. `npm test` passes (vitest)
  3. You have exercised the feature end-to-end where practical (e.g. `npm run dev` and drive the affected flow, or the relevant Playwright test)

  **Local merge is the default, with standing user authorization.** Commando is a single-user development app: once the checks above pass, merge completed work into local `main` so the user can use it in their running checkout. Do not stop at opening a PR or ask for routine local-merge approval. An explicit request to leave work unmerged or await review takes precedence.

  **Preserve the active session.** Inspect the main checkout for concurrent changes before merging. Preserve unrelated commits and untracked files; never reset, stash, or overwrite another agent's work. If main has diverged, prepare and test the combined result in your worktree, then fast-forward the main checkout after confirming it has not moved. Ask first if applying the change could interrupt the active session, requires restarting/reconfiguring the shared daemon or tmux server, or requires a migration or destructive operation. A verified local Git merge does not authorize restarting shared services.

  **Remote merging is separate.** Opening a PR does not block safe local integration. Merge on GitHub / `origin/main` only when the user requests it, after any required review is complete. Do not push unrelated local-only commits as part of merging a PR remotely.

  Then merge the branch into local `main` and clean up only your own finished worktree:

  ```sh
  git -C <main-checkout> merge <feature>
  git worktree remove ../commando-<feature>
  git branch -d <feature>
  ```

  If any check fails, do not merge — fix it in the worktree first, or leave the branch unmerged and report what's failing.

## Session Isolation

- Preserve ongoing tmux and Commando sessions whenever possible. Do not attach to, kill, restart, or reconfigure a shared tmux server or Commando daemon unless explicitly requested.
- When testing Commando, use a separate tmux server/socket and separate ports. Set `COMMANDO_TMUX_SOCKET_NAME` and `COMMANDO_PORT` to feature-specific values, and pass a separate Vite port with `vite --port` (for example, daemon `4410` and web `5273`).
- Avoid broad cleanup commands such as `tmux kill-server`, `pkill`, or stopping shared dev servers. Clean up only processes and resources launched by the agent.

## Commands

- `npm run dev` — start daemon (tsx watch) + web (vite) together
- `npm run build` — typecheck and build for production
- `npm run typecheck` — `tsc -b`
- `npm test` — run unit tests with vitest
- `npm run test:e2e:terminal` — Playwright terminal-fidelity e2e tests
