const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FETCH_TIMEOUT = 3000;
const PORT_SCAN_RANGE = [40000, 50000];
const PORT_SCAN_CONCURRENCY = 10;
const DATA_FILE = path.join(__dirname, 'data.json');

let cachedServers = null;
let cachedServersAt = 0;
const SERVER_CACHE_TTL = 60000;

const portCache = new Map();
const PORT_CACHE_TTL = 120000;

function httpsPost(hostname, port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const timedOut = setTimeout(() => reject(new Error('Request timeout')), FETCH_TIMEOUT);
    const opts = {
      hostname, port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      rejectUnauthorized: false,
      timeout: FETCH_TIMEOUT,
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        clearTimeout(timedOut);
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Invalid JSON response')); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

function httpPost(hostname, port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const timedOut = setTimeout(() => reject(new Error('Request timeout')), FETCH_TIMEOUT);
    const opts = {
      hostname, port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      timeout: FETCH_TIMEOUT,
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        clearTimeout(timedOut);
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Invalid JSON response')); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function findLanguageServers() {
  const now = Date.now();
  if (cachedServers && now - cachedServersAt < SERVER_CACHE_TTL) {
    return cachedServers;
  }

  const patterns = [
    '%language_server%',
    '%language_server_win%',
    '%codeium%',
    '%exa%',
  ];

  const results = [];
  for (const pattern of patterns) {
    try {
      const batch = await queryProcesses(pattern);
      for (const s of batch) {
        if (!results.some(r => r.pid === s.pid)) {
          results.push(s);
        }
      }
    } catch {}
  }

  cachedServers = results;
  cachedServersAt = now;
  return results;
}

function queryProcesses(nameFilter) {
  return new Promise((resolve) => {
    const ps = spawn('powershell', [
      '-NoProfile', '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "name like '${nameFilter}'" | Select-Object ProcessId, CommandLine | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`
    ]);
    let stdout = '';
    ps.stdout.on('data', d => stdout += d);
    ps.on('close', () => {
      const lines = stdout.trim().split(/\r?\n/).filter(l => l.includes('|'));
      const servers = [];
      for (const line of lines) {
        const sep = line.indexOf('|');
        const pid = parseInt(line.substring(0, sep).trim(), 10);
        const cmd = line.substring(sep + 1).trim();
        if (isNaN(pid) || !cmd) continue;

        const cmdLower = cmd.toLowerCase();
        const isAntigravity =
          cmdLower.includes('antigravity') ||
          /--app_data_dir\s+["']?[^"'\s]*antigravity/i.test(cmd);
        if (!isAntigravity) continue;

        const csrfMatch =
          cmd.match(/--csrf_token[=\s]+"([^"]+)"/) ||
          cmd.match(/--csrf_token[=\s]+'([^']+)'/) ||
          cmd.match(/--csrf_token[=\s]+(\S+)/);
        if (!csrfMatch) continue;

        servers.push({ pid, csrfToken: csrfMatch[1].trim(), commandLine: cmd });
      }
      resolve(servers);
    });
  });
}

async function discoverPort(pid, csrfToken) {
  const cached = portCache.get(pid);
  if (cached && cached.csrfToken === csrfToken && Date.now() - cached.at < PORT_CACHE_TTL) {
    return cached.port;
  }

  const path = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
  const headers = { 'X-Codeium-Csrf-Token': csrfToken, 'Connect-Protocol-Version': '1' };
  const body = { metadata: { ideName: 'antigravity', extensionName: 'antigravity', ideVersion: 'unknown', locale: 'en' } };

  const ports = await findListeningPorts(pid);
  if (ports.length === 0) return null;

  const results = await Promise.allSettled(
    ports.map(port => httpsPost('127.0.0.1', port, path, headers, body))
  );
  const idx = results.findIndex(r => r.status === 'fulfilled');
  if (idx === -1) return null;

  const port = ports[idx];
  portCache.set(pid, { port, csrfToken, at: Date.now() });
  return port;
}

async function findListeningPorts(pid) {
  // Primary: Get-NetTCPConnection
  try {
    const output = await runPowershell(
      `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`
    );
    const ports = output.split(/\r?\n/).map(l => parseInt(l.trim(), 10)).filter(p => !isNaN(p) && p > 0);
    if (ports.length > 0) return [...new Set(ports)];
  } catch {}

  // Fallback: netstat -ano
  try {
    const output = await runPowershell(`netstat -ano -p tcp | findstr "${pid}"`);
    const ports = [];
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      if (!line.includes('LISTENING')) continue;
      const addr = parts[1] || '';
      const colon = addr.lastIndexOf(':');
      if (colon !== -1) {
        const port = parseInt(addr.substring(colon + 1), 10);
        if (!isNaN(port) && port > 0) ports.push(port);
      }
    }
    return [...new Set(ports)];
  } catch {}

  return [];
}

function runPowershell(command) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', command]);
    let stdout = '';
    ps.stdout.on('data', d => stdout += d);
    ps.on('error', reject);
    ps.on('close', () => resolve(stdout.trim()));
  });
}

async function fetchQuota(port, csrfToken) {
  const path = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
  const headers = {
    'X-Codeium-Csrf-Token': csrfToken,
    'Connect-Protocol-Version': '1',
  };
  const body = {
    metadata: { ideName: 'antigravity', extensionName: 'antigravity', ideVersion: 'unknown', locale: 'en' }
  };

  try {
    return await httpsPost('127.0.0.1', port, path, headers, body);
  } catch {
    try {
      return await httpPost('127.0.0.1', port, path, headers, body);
    } catch {
      return null;
    }
  }
}

const PLAN_ALIASES = {
  'antigravity starter quota': { display: 'Starter', css: 'starter' },
};

function normalizePlan(raw) {
  const plan = raw || 'Free';
  const key = plan.toLowerCase().trim();
  const alias = PLAN_ALIASES[key];
  if (alias) return alias;
  return { display: plan, css: plan.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown' };
}

let lastRawResponse = null;

function getLastRawResponse() {
  return lastRawResponse;
}

function parseQuotaResponse(raw) {
  if (!raw || !raw.userStatus) return null;
  lastRawResponse = raw;
  const u = raw.userStatus;

  const planRaw = u.userTier?.name || u.planName || 'Free';
  const { display: planDisplay, css: planCss } = normalizePlan(planRaw);
  const promptCredits = u.availablePromptCredits ?? u.planStatus?.availablePromptCredits ?? 0;
  const monthlyCredits = u.monthlyPromptCredits ?? u.planStatus?.planInfo?.monthlyPromptCredits ?? 0;

  const models = (u.cascadeModelConfigData?.clientModelConfigs || [])
    .filter(m => m.quotaInfo && m.quotaInfo.resetTime)
    .map(m => ({
      label: m.label || 'Unknown',
      remainingFraction: m.quotaInfo.remainingFraction ?? null,
      resetTime: m.quotaInfo.resetTime,
    }));

  return {
    email: u.accountEmail || u.email || 'unknown',
    name: u.name || '',
    plan: planDisplay,
    planCss,
    availablePromptCredits: promptCredits,
    monthlyPromptCredits: monthlyCredits,
    connected: true,
    models,
  };
}

function loadKnownAccounts() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      const list = parsed.accounts || [];
      if (!Array.isArray(list)) return [];
      return list;
    }
  } catch (e) {
    console.error('loadKnownAccounts error:', e.message);
  }
  return [];
}

function saveAccounts(accounts) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = JSON.stringify({ accounts }, null, 2);
    fs.writeFileSync(DATA_FILE, data, 'utf-8');
  } catch (e) {
    console.error('saveAccounts error:', e.message);
  }
}

function generateMockAccounts() {
  const now = Date.now();
  const ms = (h, m) => new Date(now + h * 3600000 + m * 60000).toISOString();
  return [
    {
      email: 'alice@gmail.com', name: 'Alice', plan: 'Pro', planCss: 'Pro',
      availablePromptCredits: 312, monthlyPromptCredits: 500,
      connected: true,
      models: [
        { label: 'Claude Sonnet 4.6', remainingFraction: 0.74, resetTime: ms(18, 30) },
        { label: 'Gemini 3.5 Flash', remainingFraction: 0.12, resetTime: ms(3, 45) },
        { label: 'GPT-4o', remainingFraction: null, resetTime: ms(48, 0) },
      ],
    },
    {
      email: 'bob@gmail.com', name: 'Bob', plan: 'Free', planCss: 'Free',
      availablePromptCredits: 20, monthlyPromptCredits: 100,
      connected: true,
      models: [
        { label: 'Gemini 3.5 Flash', remainingFraction: 0.45, resetTime: ms(24, 0) },
      ],
    },
    {
      email: 'carol@gmail.com', name: 'Carol', plan: 'Ultra', planCss: 'Ultra',
      availablePromptCredits: 1500, monthlyPromptCredits: 2000,
      connected: false,
      models: [
        { label: 'Claude Opus 4.6', remainingFraction: 0.88, resetTime: ms(72, 0) },
        { label: 'Gemini 3.1 Pro', remainingFraction: 0.03, resetTime: ms(1, 15) },
      ],
    },
  ];
}

function addKnownAccount(email) {
  console.log(`addKnownAccount: adding ${email}`);
  const known = loadKnownAccounts();
  if (known.some(a => a.email === email)) {
    console.log(`addKnownAccount: ${email} already exists`);
    return;
  }
  known.push({
    email,
    name: '',
    plan: 'Free',
    planCss: 'Free',
    availablePromptCredits: 0,
    monthlyPromptCredits: 0,
    connected: false,
    models: [],
  });
  saveAccounts(known);
}

async function fetchAllQuotas() {
  if (process.env.MOCK === 'true') return generateMockAccounts();

  const servers = await findLanguageServers();
  const knownAccounts = loadKnownAccounts();

  const liveByEmail = new Map();

  for (const s of servers) {
    let port = await discoverPort(s.pid, s.csrfToken);
    if (!port) continue;
    let raw = await fetchQuota(port, s.csrfToken);
    if (!raw) {
      // Cached port may be stale — clear and retry once
      portCache.delete(s.pid);
      port = await discoverPort(s.pid, s.csrfToken);
      if (!port) continue;
      raw = await fetchQuota(port, s.csrfToken);
      if (!raw) continue;
    }
    const parsed = parseQuotaResponse(raw);
    if (!parsed || !parsed.email) continue;

    if (liveByEmail.has(parsed.email)) {
      const existing = liveByEmail.get(parsed.email);
      const seenLabels = new Set(existing.models.map(m => m.label));
      for (const m of parsed.models) {
        if (!seenLabels.has(m.label)) {
          existing.models.push(m);
          seenLabels.add(m.label);
        }
      }
    } else {
      parsed.connected = true;
      liveByEmail.set(parsed.email, parsed);
    }
  }

  const seen = new Set();
  const ordered = [];

  for (const known of knownAccounts) {
    seen.add(known.email);
    const live = liveByEmail.get(known.email);
    if (live) {
      ordered.push({ ...live, connected: true });
    } else {
      const { display, css } = normalizePlan(known.plan);
      ordered.push({ ...known, plan: display, planCss: css, connected: false });
    }
  }

  for (const [email, acc] of liveByEmail) {
    if (!seen.has(email)) {
      ordered.push({ ...acc, connected: true });
    }
  }

  if (ordered.length > 0 && servers.length > 0) {
    saveAccounts(ordered);
  }

  const result = ordered.length > 0 ? ordered : generateMockAccounts();
  checkModelNotifications(result);
  return result;
}

// ─── Notifications ─────────────────────────────────────────────────────────────

const prevModelStates = new Map();
const notifications = [];

const NOTIFICATION_COOLDOWN = 10 * 60 * 1000;

function checkModelNotifications(accounts) {
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.email || !acc.models) continue;

    const prev = prevModelStates.get(acc.email) || new Map();
    const curr = new Map(acc.models.map(m => [m.label, m]));

    const batchLastNotified = prev.get('_batch') || 0;
    const availableModels = [];

    for (const [label, model] of curr) {
      const curFrac = model.remainingFraction;
      const prevFrac = prev.get(label)?.remainingFraction;

      const wasExhausted = prevFrac === null || prevFrac === 0;
      const nowAvailable = curFrac !== null && curFrac > 0;

      if (wasExhausted && nowAvailable && now - batchLastNotified > NOTIFICATION_COOLDOWN) {
        availableModels.push({ label, pct: Math.round(curFrac * 100) });
      }
    }

    prevModelStates.set(acc.email, curr);

    if (availableModels.length > 0) {
      const pct = availableModels[0].pct;
      const names = availableModels.length <= 3
        ? availableModels.map(m => m.label).join(', ')
        : `${availableModels.length} models`;
      notifications.push({
        key: `${acc.email}|_batch`,
        email: acc.email,
        name: acc.name || acc.email,
        model: names,
        pct,
        at: now,
      });
      console.log(`[notify] ${acc.email}: ${availableModels.length} model(s) available`);
      prev.set('_batch', now);
    }
  }
}

function getAndClearNotifications() {
  const result = notifications.slice();
  notifications.length = 0;
  return result;
}

// ─── Exports ───────────────────────────────────────────────────────────────────

function removeKnownAccount(email) {
  const known = loadKnownAccounts();
  const idx = known.findIndex(a => a.email === email);
  if (idx === -1) return false;
  known.splice(idx, 1);
  saveAccounts(known);
  console.log(`removeKnownAccount: removed ${email}`);
  return true;
}

function updateKnownAccount(email, updates) {
  const known = loadKnownAccounts();
  const target = known.find(a => a.email === email);
  if (!target) return false;
  Object.assign(target, updates);
  saveAccounts(known);
  console.log(`updateKnownAccount: updated ${email}`);
  return true;
}

module.exports = { findLanguageServers, fetchQuota, fetchAllQuotas, parseQuotaResponse, generateMockAccounts, addKnownAccount, loadKnownAccounts, removeKnownAccount, updateKnownAccount, getLastRawResponse, getAndClearNotifications };
