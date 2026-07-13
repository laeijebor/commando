# Agent instructions

## Workflow

- **Work in a git worktree, not on `main` directly.** Create a worktree with a feature branch before making changes:

  ```sh
  git worktree add ../commando-<feature> -b <feature>
  ```

  Do all work inside that worktree so `main` and other agents' work stay untouched.

- **Commit as you go.** Make small, focused commits at each meaningful step — don't batch everything into one commit at the end. Write clear, conventional commit messages (`feat:`, `fix:`, `refactor:`, ...).

- **Merge only when the feature is finished and tested.** Before merging back into `main`:
  1. `npm run typecheck` passes
  2. `npm test` passes (vitest)
  3. You have exercised the feature end-to-end where practical (e.g. `npm run dev` and drive the affected flow, or the relevant Playwright test)

  Then merge the branch into `main` and clean up:

  ```sh
  git -C <main-checkout> merge <feature>
  git worktree remove ../commando-<feature>
  git branch -d <feature>
  ```

  If any check fails, do not merge — fix it in the worktree first, or leave the branch unmerged and report what's failing.

## Commands

- `npm run dev` — start daemon (tsx watch) + web (vite) together
- `npm run build` — typecheck and build for production
- `npm run typecheck` — `tsc -b`
- `npm test` — run unit tests with vitest
- `npm run test:e2e:terminal` — Playwright terminal-fidelity e2e tests
