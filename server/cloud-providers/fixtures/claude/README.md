# Provisional Claude cloud fixtures (P0a)

These are **synthetic**, not captured from an installed CLI or authenticated account.
They do not establish P0b or authorize an enabled provider capability. `9.9.9` is
an intentionally synthetic version used only by tests.

Official references checked during implementation:

- https://code.claude.com/docs/en/claude-code-on-the-web — follow-up invocation,
  `{ok, session_id, url}` success and `{ok: false, session_id, error}` failure;
  the displayed CLI link includes `?from=cli&m=0`.
- https://code.claude.com/docs/en/errors — `--print` accepts a prompt argument or stdin.

The adapter uses `claude -p --cloud <validated-id> --output-format json` with
the prompt on stdin. It accepts only the canonical matching session URL or the
documented tracking suffix above, and stores the canonical URL. Prose, partial
JSON, arrays, extra fields, conflicting identities and arbitrary URL suffixes
are not authoritative receipts. A receipt acknowledges delivery, not completion.

Creation is enabled at or above the configured minimum stable verified version.
It uses a fresh private clone of the requested GitHub branch and the interactive
`--cloud` CLI on a unique tmux socket. The working checkout is never submitted.

P0b still requires an explicitly approved executable/version, disposable target,
subscription login, and controlled live evidence. No global install, credential
reads or real cloud tasks are part of these tests.

`process.cjs` is a harmless fake executable copied to a temporary directory by
runner tests. It exercises real process behavior, never provider authentication.

`create.cjs` is a synthetic interactive executable. Tests prepend a Node shebang;
it writes the exact known trust screen, waits for Down + Enter on its PTY, then
prints a three-line synthetic receipt. It records argv/cwd/profile in the test's
temporary profile directory. It never contacts Claude or reads credentials.
