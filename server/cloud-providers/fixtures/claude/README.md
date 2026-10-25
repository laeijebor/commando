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

Creation remains disabled even with an exact verified version: a supported,
enforceable source-selection/no-bundle policy has not been established.

P0b still requires an explicitly approved executable/version, disposable target,
subscription login, and controlled live evidence. No global install, credential
reads or real cloud tasks are part of these tests.

`process.cjs` is a harmless fake executable copied to a temporary directory by
runner tests. It exercises real process behavior, never provider authentication.
