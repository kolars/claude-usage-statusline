#!/usr/bin/env node
// Claude Code statusline: context-window usage + plan usage limits (5h/7d)
// - Context %: read from the statusline stdin payload's `context_window`
//   object (no API call). Falls back to parsing the session transcript on
//   older Claude Code versions that don't send `context_window`.
// - Plan limits: reads OAuth credentials from ~/.claude/.credentials.json
//   and calls GET https://api.anthropic.com/api/oauth/usage (cached).

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_FILE = path.join(os.tmpdir(), 'claude-usage-cache.json');
const BACKOFF_FILE = path.join(os.tmpdir(), 'claude-usage-backoff.json');
const CACHE_TTL_MS = 30 * 60_000; // 30 minutes — reduce API calls to avoid 429s
const BACKOFF_MS = 60 * 60_000; // 1 hour backoff after 429

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

// --- Context window ---------------------------------------------------------
// The number shown is the honest raw % of the model's context window
// (input_tokens + cache_creation + cache_read, matching Claude Code's own
// `used_percentage`). The COLOR (via bar(): green <50, yellow <80, red >=80)
// signals proximity to auto-compaction — auto-compact fires in the low-to-mid
// 80s% of the window, so red lands right as compaction approaches.
function ctxPctFromPayload(payload) {
  const cw = payload && payload.context_window;
  if (!cw) return null;
  // Preferred: Claude Code's pre-calculated input-only percentage.
  if (typeof cw.used_percentage === 'number') return Math.round(cw.used_percentage);
  // Fallback: compute from token counts + window size.
  const size = cw.context_window_size || 200_000;
  let used = (typeof cw.total_input_tokens === 'number') ? cw.total_input_tokens : null;
  if (used == null && cw.current_usage) {
    const u = cw.current_usage;
    used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  }
  if (used == null || !size) return null;
  return Math.round((used / size) * 100);
}

// Fallback for older Claude Code versions that don't send `context_window`:
// tail-read the transcript and sum the last assistant message's input usage.
// Window size can't be read from the transcript, so honor an explicit override
// (CLAUDE_CONTEXT_WINDOW) and otherwise assume 200k.
function ctxPctFromTranscript(payload) {
  const tp = payload && payload.transcript_path;
  if (!tp) return null;
  try {
    const size = fs.statSync(tp).size;
    const readBytes = Math.min(size, 65536);
    const fd = fs.openSync(tp, 'r');
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, size - readBytes);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      const u = o && o.message && o.message.usage;
      if (u && typeof u.input_tokens === 'number') {
        const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        const win = parseInt(process.env.CLAUDE_CONTEXT_WINDOW || '', 10) || 200_000;
        return Math.round((used / win) * 100);
      }
    }
  } catch {}
  return null;
}

function contextSegment(payload) {
  let pct = ctxPctFromPayload(payload);
  if (pct == null) pct = ctxPctFromTranscript(payload);
  if (pct == null || Number.isNaN(pct)) return null;
  if (pct < 0) pct = 0;
  return `ctx:${bar(pct)}`;
}

function isBackedOff() {
  try {
    const raw = fs.readFileSync(BACKOFF_FILE, 'utf8');
    const { until } = JSON.parse(raw);
    return Date.now() < until;
  } catch {}
  return false;
}

function setBackoff() {
  try {
    fs.writeFileSync(BACKOFF_FILE, JSON.stringify({ until: Date.now() + BACKOFF_MS }));
  } catch {}
}

async function fetchUsage() {
  const cached = readCache(false);
  if (cached) return cached;

  // Don't hit the API if we're in backoff from a 429
  if (isBackedOff()) {
    const stale = readCache(true);
    return stale || null;
  }

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
    if (resp.status === 429) {
      setBackoff(); // back off for 1 hour
      const stale = readCache(true);
      return stale || null;
    }
    if (!resp.ok) {
      touchCache();
      const stale = readCache(true);
      return stale || null;
    }
    const data = await resp.json();
    writeCache(data);
    // Clear backoff on success
    try { fs.unlinkSync(BACKOFF_FILE); } catch {}
    return { ts: Date.now(), data };
  } catch {
    touchCache();
    const stale = readCache(true);
    return stale || null;
  }
}

async function main() {
  // Consume stdin (the statusline JSON payload)
  let input = '';
  process.stdin.setEncoding('utf8');
  await new Promise(resolve => {
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', resolve);
    setTimeout(resolve, 2000);
  });

  let payload = {};
  try { payload = JSON.parse(input); } catch {}

  const parts = [];

  // Context-window usage (local — no API call). Shown first.
  const ctx = contextSegment(payload);
  if (ctx) parts.push(ctx);

  const result = await fetchUsage();
  if (!result || !result.data) {
    parts.push('\x1b[2musage: waiting...\x1b[0m');
    process.stdout.write(parts.join(' │ '));
    return;
  }

  const { ts, data: usage } = result;

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
