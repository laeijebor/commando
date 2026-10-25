# Cloud tasks independent browser QA

`../../cloud-tasks.pw.ts` runs the real `src/App.tsx`, client stores/API adapters,
and CSS. `daemon.ts` supplies explicitly synthetic HTTP/WebSocket data using the
contracts in `shared/cloud-tasks.ts` and `src/cloudTasksApi.ts`. Capability flags
are test inputs, not verification of any installed CLI or provider account.

## Run

Check that port 5297 is free, then run from the worktree root:

```sh
COMMANDO_CHROMIUM="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
COMMANDO_E2E_VITE_PORT=5297 \
PLAYWRIGHT_JSON_OUTPUT_FILE=test-results/cloud-tasks-report.json \
npx playwright test e2e/cloud-tasks.pw.ts --workers=1 \
  --output=test-results/cloud-tasks --reporter=line,json
```

Use another verified browser executable if that cached revision is absent. The
suite respects the existing Playwright configuration's `COMMANDO_CHROMIUM`.
It starts and closes its own strict-port Vite instance; no daemon or tmux server
is needed. All `/api`, `/ws`, and `/screenshots` proxy targets fail closed to
loopback port 9. Browser routing rejects external origins and unhandled APIs.

## Coverage

Ten scenarios each run at 1440×1000 and 390×844:

- Zero tmux sessions, missing CLI, validated identity-only Claude link, dialog
  focus trap/Escape/restoration, keyboard selection and narrow Back.
- Claude Team + Claude Max + Codex connections: exact `cloudConnectionKey` tuple
  dropdown values, confirmation cleared when switching, selection retained on
  provider-list reorder, identical session IDs saved separately, connection labels
  in list/detail/HUD, messages scoped to their own context, and no Team fallback
  after the Max connection is removed. Both link fixtures use the same task title
  as well as remote ID to make connection-label ambiguity observable.
- Independent provider capabilities/account confirmation, local 202 acknowledgement,
  eventual provider receipt, and clearing the durable browser pending index.
- Prepared resume after reload: missing readiness and changed credential context
  block dispatch; explicit reconfirmation re-reads the original operation and uses
  `POST /api/cloud-operations/:id/dispatch`. A concurrent change to unknown is
  recovered without dispatching. The original operation/key/payload are preserved.
- Lost create response with a recorded unknown operation: explicit recovery and
  reload look up the original key, never POST again.
- Lost create response with no operation: reload has no restored prompt or
  in-memory retry. Re-entered changed content is rejected by digest before any
  POST; authorizing a new intent requires duplicate-risk confirmation.
- Lost Claude follow-up: an accepted session does not imply message acceptance;
  an explicit new message has a new key and leaves the old message unknown.
- Stale result, daemon outage, browser offline/online, enabled provider link,
  disabled mutations, single reconnect refresh and retained focus/unsaved title.
- On-demand read-only diff, escaped hostile prompt/status/diff, unsafe provider
  URL fallback, and 5,000-line truncation.
- HUD counts/filters independent of cloud tasks, local archive/unarchive,
  preserved selected session/pane, and cloud identity after origin removal.

Two additional cases cover the 639/640px list/detail breakpoint, long source
metadata and the 256 KiB UTF-8 cap with a multibyte overlong line.
One desktop case polls 24 active tasks twice, asserting every task reaches result
ready, bounded concurrent reads, and preservation of the selected last task.

Each case writes `cloud-qa-traffic.json` and screenshots under its Playwright
output directory. Unexpected routes, console/page errors and terminal input
fail the test. Deliberately injected transport errors and recovery 404s are
counted explicitly. Failures retain a Playwright trace. These are frontend
contract tests; backend auth/CLI/durable-dispatch and live-provider acceptance
require their separate verification packages.

## Latest QA result

Team/Max contract rerun after D's Connection label fix: **23 passed** in 38.1
seconds. Both complete dual-profile flows now pass, including link/message/
reorder/removal assertions. No fallback selectors, expected-failure annotations,
or product-code workarounds are used. A screenshot-only adjustment scrolls the
desktop list to the top and captures selected Max detail; the two dual-profile
cases then passed again in 6.3 seconds, with refreshed captures under
`test-results/cloud-tasks-dual-profile/`.

Fixtures enforce the full provider/context tuple on submissions and require
task-bound messages/resumes to match their saved context. All provider data and
message receipts are synthetic. Strict standalone TypeScript checking passes.
