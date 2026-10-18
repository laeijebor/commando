---
name: open-chat
description: Open a new Commando chat when the user asks to start another chat or agent; list children and report to the parent. Works from a Commando tmux pane, including Codex panes without injected hook context.
---

# Open a Commando chat

Only open a chat when the user asks you to open or start another chat or agent.
Write a self-contained brief with the goal, context, relevant files, repository
rules and completion checks. The child works independently; do not wait for it.

```sh
node ~/.commando/hooks/commando-chat.mjs open --title "Fix the reconnect bug" --prompt-file /absolute/path/brief.md
```

The default creates a new session in the caller's repository on its own worktree.
Use `--location pane` only when the user asks for the chat beside you; add
`--split down` for a vertical split (the default is right). Session worktrees
default to a branch from the title; choose `--branch NAME` or `--no-worktree`
when appropriate. For a pane, `--branch NAME` creates a worktree before splitting.
Without a git repository, the new chat uses your current directory.

Use `--prompt "brief"` instead of `--prompt-file` for a short brief. The provider
and its permission mode are inherited from the caller: a hosted Claude or Codex
chat opens the same kind of chat, and so does a terminal `claude`, `codex` or `muse`. A
Claude child keeps the caller's profile (`CLAUDE_CONFIG_DIR`, such as `~/.claudew`).
A terminal caller's permissions come from its launch flags. `--agent claude-chat|codex-chat|muse-chat|claude|codex|cursor|opencode`
selects another provider. `--permission-mode plan|default|acceptEdits|bypassPermissions`
(Codex chats: `plan|default|bypassPermissions`; Muse chats: `default|acceptEdits|bypassPermissions`) can lower a chat's permissions but
never raise them. Codex's `default` (workspace access) and Muse's `default` (sandboxed
tools run without asking) both rank with Claude's `acceptEdits`. Muse's `acceptEdits`
approves everything inside its sandbox and needs a `bypassPermissions` caller; Muse's
`bypassPermissions` is full access (`--yolo`, no sandbox).

The CLI reads `TMUX_PANE`, `COMMANDO_PORT` (default 4310), and the private hook
token automatically. `COMMANDO_AGENT_HOOK_TOKEN_PATH` can override its token file.
Run it in your own Commando pane; never spoof another pane or pass a target.
It prints JSON. If a rate or depth limit requires owner approval, it waits up
to ten minutes. Dismissal, expiry or supersession exits with code 3. A partial
creation error includes the created target: inspect it and do not open it again.

Check the chats you opened:

```sh
node ~/.commando/hooks/commando-chat.mjs list
```

If another agent opened your chat, send one short line to your parent when
finished or blocked (maximum 1000 characters):

```sh
node ~/.commando/hooks/commando-chat.mjs report "Finished: reconnect fix and tests pass."
```

Keep reports specific and self-contained. Chat parents queue reports while
busy. Terminal parents must be available for input; if reporting fails, keep
the result in your chat and explain the failure.
