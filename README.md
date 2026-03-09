# claude-usage-statusline

Shows your [Claude plan usage limits](https://claude.ai/settings/usage) in the Claude Code statusline.

```
5h:3% 3h54m | 7d:6% 3d23h | son:1%
```

**5h** = session (resets every 5 hours) · **7d** = weekly all-models · **son** = sonnet-only weekly
Colors: green (<50%) · yellow (50–79%) · red (80%+)

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

Reads your OAuth token from Claude Code's local credentials (`~/.claude/.credentials.json` or macOS Keychain), calls `GET https://api.anthropic.com/api/oauth/usage`, and caches results for 60 seconds.

## License

MIT
