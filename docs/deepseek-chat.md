# DeepSeek chat

Choose **DeepSeek chat** under **Start with** when creating a session, or in an empty pane. It runs DeepSeek V4.1 Flash (`deepseek-flash`, with a 1M context window) through the Claude Code runtime. Requests are billed to your DeepSeek account. A Cursor or Anthropic subscription is not used.

## Set up the API key

Get an API key from [DeepSeek](https://platform.deepseek.com/api_keys). On the machine running the Commando daemon, create `~/.commando/deepseek/settings.json`:

```json
{
  "env": {
    "DEEPSEEK_API_KEY": "your-deepseek-api-key"
  }
}
```

Keep the file private (`chmod 600 ~/.commando/deepseek/settings.json`). If it already exists, add the key to its existing `env` object. Do not put the key in a repository or a chat message.

Open a new DeepSeek chat after saving the key. Close a chat already showing the missing-key notice and create a new one. The shared daemon does not need to restart. For a manually launched pane, an explicit `DEEPSEEK_API_KEY` environment variable also works for that process; the settings file keeps the key available across restarts and automatic resumes.

## Behavior

- Streaming replies, images, file and shell tools, approvals, queues, plans, and MCP use the existing Claude Code chat adapter.
- Permission modes are Ask before edits, Accept edits, Plan mode, and Bypass permissions. Model-specific Claude auto-review, fast mode, and effort levels are not offered.
- The model menu lists only DeepSeek V4.1 Flash. Claude aliases and subagents also route to DeepSeek.
- Configuration and transcripts live in `~/.commando/deepseek`, separate from Claude profiles. Saved conversations appear as **DeepSeek** and reopen as DeepSeek chats.
- Switching the conversation to the Claude Code terminal UI is unavailable. Continue in Commando chat, or view its host log.
- Without a key, the chat displays setup instructions and makes no model request.

From an existing tmux pane, `commando-agent deepseek` starts the same provider. Use `--resume ID` to reopen a conversation and `--permission-mode MODE` to select permissions. The endpoint and Flash model are fixed for this provider.

DeepSeek documents the underlying Claude Code integration [here](https://api-docs.deepseek.com/guides/coding_agents/).
