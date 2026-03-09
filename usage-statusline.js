#!/usr/bin/env node
// Claude Code statusline: shows plan usage limits (5h session + weekly)
// Reads OAuth credentials from ~/.claude/.credentials.json (Linux/Windows)
// or macOS Keychain (Claude Code-credentials)
// Calls GET https://api.anthropic.com/api/oauth/usage

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CACHE_FILE = path.join(os.tmpdir(), 'claude-usage-cache.json');
const CACHE_TTL_MS = 60_000; // 60 seconds

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const cached = JSON.parse(raw);
    if (Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;
  } catch {}
  return null;
}

function writeCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

function getAccessToken() {
  // macOS: read from Keychain
  if (process.platform === 'darwin') {
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      return JSON.parse(raw).claudeAiOauth.accessToken;
    } catch {}
  }

  // Linux / Windows: read from credentials file
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    return creds.claudeAiOauth.accessToken;
  } catch {}

  return null;
}

function formatReset(resetAt) {
  if (!resetAt) return '';
  const now = new Date();
  const reset = new Date(resetAt);
  const diffMs = reset - now;
  if (diffMs <= 0) return 'now';
  const h = Math.floor(diffMs / 3_600_000);
  const m = Math.floor((diffMs % 3_600_000) / 60_000);
  if (h > 24) {
    const days = Math.floor(h / 24);
    const remH = h % 24;
    return remH > 0 ? `${days}d${remH}h` : `${days}d`;
  }
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function colorize(pct) {
  // green < 50%, yellow 50-79%, red >= 80%
  if (pct >= 80) return `\x1b[31m${pct}%\x1b[0m`;
  if (pct >= 50) return `\x1b[33m${pct}%\x1b[0m`;
  return `\x1b[32m${pct}%\x1b[0m`;
}

async function fetchUsage() {
  const cached = readCache();
  if (cached) return cached;

  const token = getAccessToken();
  if (!token) return null;

  try {
    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(3000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    writeCache(data);
    return data;
  } catch {
    return null;
  }
}

async function main() {
  // Consume stdin (required by Claude Code statusline protocol)
  let input = '';
  process.stdin.setEncoding('utf8');
  await new Promise(resolve => {
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', resolve);
    setTimeout(resolve, 2000);
  });

  const usage = await fetchUsage();
  if (!usage) {
    process.stdout.write('');
    return;
  }

  const parts = [];

  // 5-hour session
  if (usage.five_hour) {
    const pct = Math.round(usage.five_hour.utilization);
    const reset = formatReset(usage.five_hour.resets_at);
    parts.push(`5h:${colorize(pct)}${reset ? ' \x1b[2m' + reset + '\x1b[0m' : ''}`);
  }

  // 7-day all models
  if (usage.seven_day) {
    const pct = Math.round(usage.seven_day.utilization);
    const reset = formatReset(usage.seven_day.resets_at);
    parts.push(`7d:${colorize(pct)}${reset ? ' \x1b[2m' + reset + '\x1b[0m' : ''}`);
  }

  // Sonnet-only (if present)
  if (usage.seven_day_sonnet) {
    const pct = Math.round(usage.seven_day_sonnet.utilization);
    parts.push(`son:${colorize(pct)}`);
  }

  process.stdout.write(parts.join(' | '));
}

main().catch(() => {});
