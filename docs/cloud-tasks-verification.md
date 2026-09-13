# Cloud tasks verification

## Implemented and locally verified

The `remote-agents` feature adds an independent cloud-task journal, official-CLI
adapters, authenticated HTTP orchestration, a Cloud tasks area, and cloud HUD
cards. Tasks do not depend on tmux session lifetime.

Final automated checks for this implementation:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | 128 files / 1,742 tests passed |
| `npm run build` | Pass |
| Cloud Playwright suite | 21 tests passed |
| Standalone TypeScript check of cloud E2E files | Pass |

The browser suite renders the real App and CSS using fail-closed synthetic
HTTP/WebSocket fixtures. It covers desktop/narrow layouts, zero tmux sessions,
linking without CLIs, receipt versus local acceptance, lost-response recovery,
prepared-operation resume, account-context changes, message uncertainty, diff
escaping/truncation, archive, focus restoration, and fair 24-task polling.

`server/cloud-daemon.test.ts` additionally launches the actual daemon in a
temporary HOME with unique tmux sockets, ephemeral ports and nonexistent
provider executable paths. It verifies the real owner cookie/bearer gate,
anonymous/hook-token denial, Origin enforcement, persisted links and operations
across restart, and corrupt-journal isolation. These are not provider calls.

An independent adversarial review drove fixes for expected-context binding,
queue starvation, observation-error backoff, explicit prepared create/message/link
resume, visibility of conflicting late receipts, and digest-bound draft re-entry.

## Provider acceptance still pending

Neither provider CLI was available on the implementation shell's PATH. No live
provider task, actual laptop-sleep test, repository upload or subscription charge
was performed. The user selected both providers for smoke verification but has
not supplied a disposable repository/branch or Codex environment.

Consequently, adapter fixtures are explicitly synthetic, CLI capabilities are
disabled until the installed version is explicitly verified, and this branch
must not be represented as having passed authenticated cloud acceptance.

Claude cloud creation remains disabled independently of the version setting:
there is no verified enforceable no-bundle source-selection path yet. Existing
Claude sessions can be linked; follow-up can be enabled after version/account
verification. Codex submission, observation and diff can be enabled after its
version/account/environment verification. See README for configuration.

Before completing release acceptance:

- [ ] Identify provider executable paths and sign in through their official CLIs.
- [ ] Supply an explicit disposable repository/branch and Codex environment ID.
- [ ] Capture actual sanitized CLI receipts and version evidence.
- [ ] Confirm remote work completes after closing its local submitter.
- [ ] Restart Commando and recover the same task without a duplicate submission.
- [ ] Verify Claude follow-up delivery and Codex results against actual accounts.
- [ ] Record a real lid-close result separately from simulated disconnect tests.
- [ ] Resolve Claude creation's source-selection gate before claiming support.

Keep the feature worktree and branch until these outstanding gates are resolved.
