# claude-usage-statusline

Shows your live **context-window usage** and [Claude plan usage limits](https://claude.ai/settings/usage) in the Claude Code statusline.

```
ctx:17% │ 5h:3% 3h54m │ 7d:6% 3d23h │ son:1% │ 4m ago
```

**ctx** = context window used · **5h** = session (resets every 5 hours) · **7d** = weekly all-models · **son** = sonnet-only weekly · trailing `Nm ago` = age of the cached usage data
Colors: green (<50%) · yellow (50–79%) · red (80%+)

The **ctx** percentage is the honest fraction of the model's context window in use
(input + cache tokens, matching Claude Code's own `used_percentage`, and it knows
about 1M-context models). The color escalates toward red as you approach
auto-compaction — auto-compact fires in the low-to-mid 80s% of the window, so red
is your "compaction is near" warning.

## Setup

Requires Node.js 18+ and Claude Code with a Pro/Max subscription.

**1. Download the script to `~/.claude/hooks/`:**

```bash
# macOS / Linux
curl -o ~/.claude/hooks/usage-statusline.js \
  https://raw.githubusercontent.com/kolars/-claude-usage-statusline/main/usage-statusline.js

# Windows (PowerShell)
iwr "https://raw.githubusercontent.com/kolars/-claude-usage-statusline/main/usage-statusline.js" `
  -OutFile "$env:USERPROFILE\.claude\hooks\usage-statusline.js"
```

**2. Add to `~/.claude/settings.json`:**

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/hooks/usage-statusline.js"
  }
}
```

**3. Restart Claude Code.**

## How it works

**Context %** comes straight from the JSON payload Claude Code pipes to the
statusline on stdin (the `context_window` object) — no API call, no token cost.
On older Claude Code versions that don't send `context_window`, it falls back to
tail-reading the session transcript; in that fallback the window size defaults to
200k and can be overridden with the `CLAUDE_CONTEXT_WINDOW` env var.

**Plan limits** read your OAuth token from Claude Code's local credentials
(`~/.claude/.credentials.json` or macOS Keychain), call
`GET https://api.anthropic.com/api/oauth/usage`, and cache results for 30 minutes
(with a 1-hour backoff after a `429`) to stay well under rate limits.

## License

MIT
