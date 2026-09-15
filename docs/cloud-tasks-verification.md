# Cloud tasks verification

## Implemented and locally verified

The `remote-agents` feature adds an independent cloud-task journal, official-CLI
adapters, authenticated HTTP orchestration, a Cloud tasks area, and cloud HUD
cards. Tasks do not depend on tmux session lifetime.

Final automated checks for this implementation:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | 129 files / 1,781 tests passed |
| `npm run build` | Pass |
| Cloud Playwright suite | 23 tests passed |
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

- [x] Identify provider executable paths and check existing official-CLI logins (see below; no new login required).
- [ ] Supply an explicit disposable repository/branch and Codex environment ID.
- [ ] Capture actual sanitized CLI receipts and version evidence.
- [ ] Confirm remote work completes after closing its local submitter.
- [ ] Restart Commando and recover the same task without a duplicate submission.
- [ ] Verify Claude follow-up delivery and Codex results against actual accounts.
- [ ] Record a real lid-close result separately from simulated disconnect tests.
- [ ] Resolve Claude creation's source-selection gate before claiming support.

Keep the feature worktree and branch until these outstanding gates are resolved.

## Existing-connection checks

Read-only checks located both installed CLIs outside this agent shell's PATH:

| Provider | Executable | Version | Existing authentication |
| --- | --- | --- | --- |
| Claude Code | `~/.local/bin/claude` | `2.1.270` | Default, with `CLAUDE_CONFIG_DIR` **unset**: claude.ai Team |
| Claude Code (`claudep`) | Same executable | `2.1.270` | `CLAUDE_CONFIG_DIR=~/.claudep`: claude.ai Max |
| Codex | `~/.nvm/versions/node/v24.18.0/bin/codex` | `0.153.4` | ChatGPT login |

Checks used the implementation's `runCloudCli` environment construction and
explicit executable paths, without copying credential files or printing tokens,
account addresses, or task contents. `claude auth status --json` verified the
logins; Codex `login status` reported ChatGPT authentication. The authenticated
`codex cloud list --json --limit 20` request completed successfully and returned
an empty task list with no next-page cursor. This verifies read-only cloud access,
not submission or task execution. With no tasks returned, existing-task
inspection/diff could not be exercised.

Claude's installed help advertises `--cloud`, `--remote`, and `--teleport`.
This does not establish cloud-session policy or follow-up delivery on either
Claude account; no documented headless cloud-listing surface was exercised.

Explicitly setting `CLAUDE_CONFIG_DIR=~/.claude` reports signed out, despite the
unset default reporting Team authentication. `~/.claudey` also reports signed
out. Preserve **unset versus explicitly configured** profile selection rather
than treating those paths as interchangeable. The `claudep` shell alias selects
`~/.claudep`; the adapters execute binaries directly and do not inherit aliases.

Using the resolved executable overrides, both actual adapters recognize their
installed version and correctly remain **unverified** for gated actions. No
verified-version flags or shared daemon configuration were changed. Production
configuration must select the intended Team or Max profile and resolve the
executable paths; it should not request a new login simply because PATH discovery
failed. Provider submission/detach/receipt acceptance remains pending.

## Both Claude profiles implemented

The user subsequently selected both existing Claude profiles. The daemon now
constructs distinct **Claude Team** (`claude:team`) and **Claude Max**
(`claude:max`) connections alongside Codex. Team explicitly removes the child
`CLAUDE_CONFIG_DIR`; Max sets it to `~/.claudep`. Neither changes `process.env`.
Version attestations, queues, probes, task routing, and UI selection are scoped to
the full provider/context tuple. Missing profiles never substitute another login.

The connection factory now discovers the existing native Claude and NVM Codex
installations without executable overrides. A further real read-only probe
using that factory and the actual runner found Claude **2.1.272** and Codex
**0.153.4**. Simultaneous `auth status --json` calls through the configured Team
and Max child environments both succeeded with the expected subscriptions. The
parent profile variable remained unchanged. Codex's authenticated cloud list
again succeeded and returned zero tasks. No new login, cloud task, or message
was submitted, and the profile-specific mutation gates remain unverified.

Regression coverage now includes concurrent child environment isolation,
independent version gates, identical remote IDs stored under both profiles,
connection reordering/removal, per-profile messages and resume, and exact tuple
selection in list/detail/HUD. The actual-daemon test preserves both profile
identities across restart. All 23 real-App/CSS browser cases pass at desktop and
narrow widths; independent code review found no blockers in the dual-profile
change. The release gates above still apply to live task execution.
