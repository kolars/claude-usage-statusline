#!/usr/bin/env node
// Claude Code statusline: shows plan usage limits (5h session + weekly)
// Reads OAuth credentials from ~/.claude/.credentials.json
// Calls GET https://api.anthropic.com/api/oauth/usage

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_FILE = path.join(os.tmpdir(), 'claude-usage-cache.json');
const CACHE_TTL_MS = 15 * 60_000; // 15 minutes — usage data changes slowly

function readCache(stale) {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const cached = JSON.parse(raw);
    if (stale || Date.now() - cached.ts < CACHE_TTL_MS) return cached;
  } catch {}
  return null;
}

function writeCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

function touchCache() {
  // On 429, bump timestamp so we don't retry for another TTL cycle
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const cached = JSON.parse(raw);
    cached.ts = Date.now();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cached));
  } catch {}
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

function formatAge(tsMs) {
  const diffMs = Date.now() - tsMs;
  if (diffMs < 60_000) return '<1m';
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h${remM}m` : `${h}h`;
}

function bar(pct) {
  // Color: green < 50, yellow < 80, red >= 80
  if (pct >= 80) return `\x1b[31m${pct}%\x1b[0m`;
  if (pct >= 50) return `\x1b[33m${pct}%\x1b[0m`;
  return `\x1b[32m${pct}%\x1b[0m`;
}

async function fetchUsage() {
  const cached = readCache(false);
  if (cached) return cached;

  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  let token;
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    token = creds.claudeAiOauth.accessToken;
  } catch {
    const stale = readCache(true);
    return stale || null;
  }

  try {
    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(3000)
    });
    if (!resp.ok) {
      touchCache(); // bump timestamp so we wait another TTL before retrying
      const stale = readCache(true);
      return stale || null;
    }
    const data = await resp.json();
    writeCache(data);
    return { ts: Date.now(), data };
  } catch {
    touchCache();
    const stale = readCache(true);
    return stale || null;
  }
}

async function main() {
  // Consume stdin (required by statusline protocol)
  let input = '';
  process.stdin.setEncoding('utf8');
  await new Promise(resolve => {
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', resolve);
    setTimeout(resolve, 2000);
  });

  const result = await fetchUsage();
  if (!result || !result.data) {
    process.stdout.write('');
    return;
  }

  const { ts, data: usage } = result;
  const parts = [];

  // 5-hour session
  if (usage.five_hour) {
    const pct = Math.round(usage.five_hour.utilization);
    const reset = formatReset(usage.five_hour.resets_at);
    parts.push(`5h:${bar(pct)}${reset ? ' \x1b[2m' + reset + '\x1b[0m' : ''}`);
  }

  // 7-day all models
  if (usage.seven_day) {
    const pct = Math.round(usage.seven_day.utilization);
    const reset = formatReset(usage.seven_day.resets_at);
    parts.push(`7d:${bar(pct)}${reset ? ' \x1b[2m' + reset + '\x1b[0m' : ''}`);
  }

  // Sonnet-only (if present)
  if (usage.seven_day_sonnet) {
    const pct = Math.round(usage.seven_day_sonnet.utilization);
    parts.push(`son:${bar(pct)}`);
  }

  // Age indicator — how old the data is
  if (ts) {
    const age = formatAge(ts);
    // Dim if fresh (<15m), yellow if stale (>30m), red if very stale (>1h)
    const ageMs = Date.now() - ts;
    let ageColor;
    if (ageMs > 3_600_000) ageColor = '\x1b[31m';      // red >1h
    else if (ageMs > 1_800_000) ageColor = '\x1b[33m';  // yellow >30m
    else ageColor = '\x1b[2m';                            // dim = fresh
    parts.push(`${ageColor}${age} ago\x1b[0m`);
  }

  process.stdout.write(parts.join(' │ '));
}

main().catch(() => {});
