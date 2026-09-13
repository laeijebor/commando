# Codex cloud: synthetic, provisional fixtures

These fixtures are hand-authored from official source, **not authenticated CLI
captures**. `codex-cli 0.0.0-synthetic` is a test-only version. P0b (installed
version/help, account, selected disposable environment, receipt/detachment/live
completion) remains pending. No default verified version is configured.

Source reviewed 2026-09-13, OpenAI commit
`6f39a47bb3b04de4c804187bfbf55edc56939aab`:

- [CLI arguments](https://github.com/openai/codex/blob/6f39a47bb3b04de4c804187bfbf55edc56939aab/codex-rs/cloud-tasks/src/cli.rs):
  positional optional `query`, required `--env`, optional `--branch`, list limit
  1–20 and opaque `--cursor`, read-only `diff`. No follow-up subcommand.
- [Command output](https://github.com/openai/codex/blob/6f39a47bb3b04de4c804187bfbf55edc56939aab/codex-rs/cloud-tasks/src/lib.rs):
  `run_exec_command` prints only the created task URL; `run_list_command` emits
  `{tasks, cursor}` with `id`, `url`, `status`, `updated_at` (RFC3339) and additional
  metadata. `run_diff_command` prints the selected unified diff. `status` is prose
  and exits 1 for every non-ready state, so this adapter uses list JSON instead.
- [TaskStatus](https://github.com/openai/codex/blob/6f39a47bb3b04de4c804187bfbf55edc56939aab/codex-rs/cloud-tasks-client/src/api.rs):
  kebab-case `pending`, `ready`, `applied`, `error`.
- [Status mapping and creation](https://github.com/openai/codex/blob/6f39a47bb3b04de4c804187bfbf55edc56939aab/codex-rs/cloud-tasks-client/src/http.rs):
  `pending` conflates queued, in-progress, absent and unknown upstream status.
  Thus normalize `pending` to `unknown`; `ready`/`applied` to `result_ready`;
  `error` to coarse `failed` (the CLI also collapses upstream cancellation into
  error). Preserve raw status; future statuses remain `unknown`. This cannot
  prove tests passed or distinguish queued/running/cancelled.
- [Clap positional delimiter test](https://github.com/clap-rs/clap/blob/master/tests/builder/positionals.rs),
  `only_pos_follow`, demonstrates `--` routes a following option-like value to
  the optional positional. Codex derives this parser without overriding it.
- Current reference: https://developers.openai.com/codex/cli/reference/;
  also queried Context7 `/openai/codex` for cloud command syntax/output.

## Configuration and boundaries

Constructor options override `COMMANDO_CODEX_CLI` (default `codex`),
`COMMANDO_CLOUD_CODEX_VERIFIED_VERSION` (unset by default), and
`COMMANDO_CLOUD_CODEX_CONTEXT` (default `codex:default`). The verified version is
the **parsed semantic version**, e.g. `0.0.0-synthetic` from the test CLI output
`codex-cli 0.0.0-synthetic`; it must match exactly, not a label or semver range.
`CloudProviderInfo.version` also returns that semantic version. Setting it asserts external P0
verification, not account detection. Creation still requires account confirmation.
User-supplied local links remain possible when the CLI is missing or unverified.

A spawned create with one exact, canonical, newline-terminated receipt is accepted
even if the process subsequently exits nonzero, times out, or is signalled. The
newline from upstream `println!` establishes the complete task-ID boundary;
unterminated output, extra prose, multiple URLs, and any runner truncation remain
`delivery_unknown`. A known pre-spawn failure remains rejected. The synthetic
executable verifies receipt precedence over an actual later nonzero exit.

Only `cloud exec --env ID --branch BRANCH -- PROMPT` is dispatched. Repository,
checkout and commit metadata are never passed as argv/cwd, pushed, or bundled.
The shared runner excludes `CODEX_STARTING_DIFF` (upstream injects its value
as a pre-apply patch); the synthetic executable test checks that boundary using
B's actual runner. No provider auth/credential state is copied by the adapter.
The literal prompt `-` is rejected because Codex interprets it as stdin, even
after the positional delimiter.

Inspection scans at most five pages of 20 tasks, 15 seconds and 256 KiB per
page, exact IDs only. Cursor loops, malformed output, list misses and scan bounds
raise observation errors, never invented remote failures. Network errors and raw
stderr are not persisted as provider diagnostics.

Diffs are read-only plaintext, VT sequences removed and remaining controls visibly
escaped, bounded at 256 KiB / 5,000 lines after normalization. HTML-looking code
remains text; the UI must use text-node rendering (not innerHTML). Truncation is
explicit. Neither a diff nor a zero process exit establishes task success.
