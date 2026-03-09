# claude-usage-statusline

A lightweight Claude Code statusline script that shows your **plan usage limits** — the same data you see at [claude.ai/settings/usage](https://claude.ai/settings/usage) — directly in your terminal.

```
5h:3% 3h54m | 7d:6% 3d23h | son:1%
```

- **5h** — Current 5-hour session usage + time until reset
- **7d** — Weekly all-models usage + time until reset
- **son** — Sonnet-only weekly usage (shown when applicable)

Colors indicate usage severity: green (<50%), yellow (50–79%), red (80%+).

## Requirements

- **Node.js** 18+ (uses native `fetch`)
- **Claude Code** with an active Pro/Max subscription (OAuth credentials)

## Installation

### 1. Copy the script

```bash
# Linux / macOS
curl -o ~/.claude/hooks/usage-statusline.js \
  https://raw.githubusercontent.com/kolars/-claude-usage-statusline/main/usage-statusline.js

# Windows (PowerShell)
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/kolars/-claude-usage-statusline/main/usage-statusline.js" `
  -OutFile "$env:USERPROFILE\.claude\hooks\usage-statusline.js"
```

Or manually download `usage-statusline.js` and place it in `~/.claude/hooks/`.

### 2. Configure Claude Code

Add to your `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/hooks/usage-statusline.js"
  }
}
```

On Windows, use the full path:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:/Users/YOUR_USERNAME/.claude/hooks/usage-statusline.js\""
  }
}
```

### 3. Restart Claude Code

The statusline will appear at the bottom of your Claude Code session.

## How it works

1. Reads your OAuth access token from Claude Code's local credentials:
   - **macOS**: Keychain (`Claude Code-credentials`)
   - **Linux / Windows**: `~/.claude/.credentials.json`
2. Calls `GET https://api.anthropic.com/api/oauth/usage` (the same endpoint the settings page uses)
3. Formats the response as a compact statusline with color-coded percentages and reset timers
4. Caches results for 60 seconds to minimize API calls

## Combining with other statuslines

If you use other statusline scripts (e.g., GSD), you can combine them. Create a wrapper script:

```js
#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const scripts = [
    path.join(__dirname, 'other-statusline.js'),
    path.join(__dirname, 'usage-statusline.js')
  ];

  let outputs = scripts.map(() => '');
  let done = 0;

  function finish() {
    if (++done < scripts.length) return;
    const parts = outputs.map(o => o.trim()).filter(Boolean);
    process.stdout.write(parts.join(' | '));
  }

  scripts.forEach((script, i) => {
    const child = spawn(process.execPath, [script], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => outputs[i] += d);
    child.on('close', finish);
    child.on('error', finish);
    child.stdin.write(input);
    child.stdin.end();
  });
});
```

## API response

The script reads these fields from the API:

```json
{
  "five_hour": { "utilization": 3, "resets_at": "2026-03-09T13:00:00+00:00" },
  "seven_day": { "utilization": 6, "resets_at": "2026-03-13T09:00:00+00:00" },
  "seven_day_sonnet": { "utilization": 1, "resets_at": "2026-03-15T12:00:00+00:00" }
}
```

## License

MIT
