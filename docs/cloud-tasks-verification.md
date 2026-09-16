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

## Live acceptance: Codex smoke passed; Claude pending

The original implementation was verified with synthetic fixtures. On 2026-09-16,
the user supplied a Codex environment and one real read-only task was submitted
through the actual service, journal, runner, and Codex adapter. Its provider
receipt, detached progression to result-ready, UI observation, and recovery
across an isolated daemon restart passed. Details are below.

This is live Codex evidence for CLI **0.153.4**. Claude follow-up/cloud creation
and a physical laptop-lid-close test have not been exercised. Automated fixtures
remain explicitly synthetic. Verification flags were set only for the isolated
Codex test processes; shared daemon configuration was not changed.

Claude cloud creation remains disabled independently of the version setting:
there is no verified enforceable no-bundle source-selection path yet. Existing
Claude sessions can be linked; follow-up can be enabled after version/account
verification. Codex submission and observation passed against the supplied
environment; a nonempty diff was not produced by this read-only task. See README
for version-gated configuration.

Before completing release acceptance:

- [x] Identify provider executable paths and check existing official-CLI logins (see below; no new login required).
- [x] Use the supplied Codex environment and Commando's pushed default branch, `main`.
- [x] Capture an actual Codex receipt and CLI 0.153.4 version evidence.
- [x] Observe Codex reaching result-ready after its local submitter exits.
- [x] Restart isolated Commando and recover the same task without a duplicate submission.
- [ ] Verify Claude Team and Max follow-up delivery against actual cloud sessions.
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

## Live Codex smoke — 2026-09-16

**Target:** the user-supplied environment, labeled `laeijebor/commando` by the
provider, with explicit branch `main`. The request asked for a read-only summary
of README/package.json run/test instructions, no changes/install/build/test/git
writes or PRs, and a 60-second wait to make detached execution observable.

| Evidence | Observed |
| --- | --- |
| CLI | `codex-cli 0.153.4` |
| Actual adapter invocation | `cloud exec --env <supplied-id> --branch main -- <read-only-prompt>` |
| Local submission acknowledgement | Durable `prepared` operation before CLI dispatch |
| Provider receipt | Canonical task URL plus newline, parsed successfully; exit 0 |
| First observation | `pending` → normalized `unknown`, not guessed queued/running |
| After the local submitter exited | Provider status became `ready` → `result_ready` |
| Remote diff summary | 0 files changed, 0 lines added, 0 lines removed |
| Real production App/CSS | Displayed the saved task and “Result ready”; no JS errors |
| Isolated daemon restart | Same local/remote task IDs, operation ID, installation identity and receipt hash |
| Duplicate check | Exactly 1 task and 1 operation before and after restart |

The create CLI returned at 04:36:12 UTC. Its submitting service then stopped and
closed its journal. A separate process reopened the same journal at 04:37:20
without invoking create. The provider's result-ready update was timestamped
04:38:16 UTC. The real UI subsequently refreshed that record, restarted its
isolated daemon once, and refreshed the same identity again.

The CLI listing's `environment_id` was null; the submitted request records the
supplied ID, while the returned `environment_label` identifies the repository.
We did not infer a different environment or a verified remote commit from that
missing field. `ready` is result availability, not proof that the generated
summary is correct or that tests passed; tests were not requested.

Only one provider task was created. Subsequent CLI/API requests were observations.
The isolated daemon, browser and review tile were cleaned up; the shared daemon
and existing agent sessions were preserved. Detailed evidence, private task
references and screenshots are recorded in the default vault's cloud-agent note.
The provider task remains available for review. Physical laptop sleep, Claude
session messages and nonempty diff retrieval remain separate verification work.
