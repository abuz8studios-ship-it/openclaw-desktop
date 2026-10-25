'use strict';

// abuz8-update-bridge.cjs — the panel's reversible update plumbing.
//
// This module deliberately owns only snapshot/rollback/apply/diff behavior.
// It has no model-process map and no registry state. Keeping that boundary
// explicit prevents the panel router and the model registry from growing back
// into one second monolith.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawn, execFile } = require('node:child_process');
const execFileAsync = require('node:util').promisify(execFile);

const cfg = require('./abuz8-config.cjs');
const { OPC1_ROOT, RESOURCES, STATE_DIR, OPENCLAW_JSON, PRODUCT_ROOT, readConfig } = cfg;

const UPDATE_SLOTS_DIR = path.join(PRODUCT_ROOT, 'backups', 'in-app-update-slots');
const UPDATE_LOG = path.join(STATE_DIR, 'logs', 'app-update.log');

function snapshotUpdate({ label = 'manual' } = {}) {
  fs.mkdirSync(UPDATE_SLOTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slot = path.join(UPDATE_SLOTS_DIR, `${stamp}-${String(label).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)}`);
  fs.mkdirSync(slot, { recursive: true });
  const files = [
    [OPENCLAW_JSON, 'openclaw.json'],
    [path.join(PRODUCT_ROOT, 'ABUZ8_UPSTREAM.json'), 'ABUZ8_UPSTREAM.json'],
    [path.join(PRODUCT_ROOT, 'LEDGER_LOG.md'), 'LEDGER_LOG.md'],
    [path.join(__dirname, 'abuz8-models.cjs'), 'abuz8-models.cjs'],
    [path.join(__dirname, 'abuz8-update-bridge.cjs'), 'abuz8-update-bridge.cjs'],
    [path.join(__dirname, 'abuz8-models.html'), 'abuz8-models.html'],
    [path.join(__dirname, 'electron-main.cjs'), 'electron-main.cjs'],
  ];
  const copied = [];
  for (const [src, rel] of files) {
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(slot, rel));
    copied.push(rel);
  }
  const manifest = { createdAt: new Date().toISOString(), label, slot, copied };
  fs.writeFileSync(path.join(slot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(UPDATE_SLOTS_DIR, 'last-good.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function listUpdateSlots() {
  fs.mkdirSync(UPDATE_SLOTS_DIR, { recursive: true });
  return fs.readdirSync(UPDATE_SLOTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const slot = path.join(UPDATE_SLOTS_DIR, d.name);
      try { return JSON.parse(fs.readFileSync(path.join(slot, 'manifest.json'), 'utf8')); }
      catch { return { slot, label: d.name, createdAt: null, copied: [] }; }
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function rollbackUpdate({ slot, tree = false } = {}) {
  if (tree) return runUpgrade(['rollback'].concat(slot ? ['--slot', String(slot)] : []), { timeout: 900000 });
  const slots = listUpdateSlots();
  const chosen = slot ? slots.find((s) => s.slot === slot || path.basename(s.slot) === slot) : slots[0];
  if (!chosen) throw new Error('no rollback slot available');
  const restore = [
    ['openclaw.json', OPENCLAW_JSON],
    ['ABUZ8_UPSTREAM.json', path.join(PRODUCT_ROOT, 'ABUZ8_UPSTREAM.json')],
    ['LEDGER_LOG.md', path.join(PRODUCT_ROOT, 'LEDGER_LOG.md')],
    ['abuz8-models.cjs', path.join(__dirname, 'abuz8-models.cjs')],
    ['abuz8-update-bridge.cjs', path.join(__dirname, 'abuz8-update-bridge.cjs')],
    ['abuz8-models.html', path.join(__dirname, 'abuz8-models.html')],
    ['electron-main.cjs', path.join(__dirname, 'electron-main.cjs')],
  ];
  const restored = [];
  for (const [rel, dst] of restore) {
    const src = path.join(chosen.slot, rel);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, dst);
    restored.push(rel);
  }
  return { rolledBack: true, slot: chosen.slot, restored, restartRequired: true };
}

function applyUpdate({ target = 'latest', dryRun = false, includeFlagged = false } = {}) {
  if (target !== 'latest' && !/^\d{4}\.\d+\.\d+(-[A-Za-z0-9.]+)?$/.test(String(target))) throw new Error('bad target version');
  const snapshot = snapshotUpdate({ label: `pre-update-${target}` });
  fs.mkdirSync(path.dirname(UPDATE_LOG), { recursive: true });
  fs.appendFileSync(UPDATE_LOG, `\n[${new Date().toISOString()}] upgrade requested target=${target} dryRun=${!!dryRun} includeFlagged=${!!includeFlagged} snapshot=${snapshot.slot}\n`);
  const args = [path.join(__dirname, 'abuz8-upgrade.cjs'), 'apply', '--target', String(target), '--json'];
  if (dryRun) args.push('--dry-run');
  if (includeFlagged) args.push('--include-flagged');
  const fd = fs.openSync(UPDATE_LOG, 'a');
  const child = spawn(upgradeNodeExe(), args, {
    cwd: __dirname,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, OPENCLAW_CONFIG_PATH: OPENCLAW_JSON },
  });
  child.unref && child.unref();
  return { ok: true, started: true, pid: child.pid, target, dryRun: !!dryRun, snapshot: snapshot.slot, log: UPDATE_LOG, poll: 'GET /api/update/state' };
}

function upgradeNodeExe() {
  const candidates = [process.env.OPC1_UPGRADE_NODE, path.join(RESOURCES, 'runtime', 'node', 'node.exe'), process.env.OPENCLAW_NODE_EXE, 'node.exe'].filter(Boolean);
  return candidates[0];
}

const upgradeJobs = new Map();
let lastPreflight = null;
function runUpgrade(args, { timeout = 120000 } = {}) {
  const key = JSON.stringify(args);
  const readonly = ['preflight', 'inventory', 'verify', 'slots'].includes(args[0]);
  if (readonly && upgradeJobs.has(key)) return upgradeJobs.get(key);
  const job = execFileAsync(upgradeNodeExe(), [path.join(__dirname, 'abuz8-upgrade.cjs'), ...args, '--json'], {
    cwd: __dirname, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, OPENCLAW_CONFIG_PATH: OPENCLAW_JSON },
  }).catch((e) => ({ stdout: e.stdout || '', stderr: e.stderr || e.message, status: e.code }))
    .then((r) => {
      const out = (r.stdout || '').trim();
      const starts = [out.indexOf('{'), out.indexOf('[')].filter((i) => i >= 0);
      let result;
      try { result = JSON.parse(starts.length ? out.slice(Math.min(...starts)) : out); }
      catch { result = { error: 'upgrade tool returned unparseable output', status: r.status, tail: (out + '\n' + (r.stderr || '')).slice(-800) }; }
      if (args[0] === 'preflight') lastPreflight = { at: Date.now(), result };
      return result;
    }).finally(() => { if (upgradeJobs.get(key) === job) upgradeJobs.delete(key); });
  if (readonly) upgradeJobs.set(key, job);
  return job;
}

function updateState() {
  let logTail = '';
  try { logTail = fs.readFileSync(UPDATE_LOG, 'utf8').split(/\r?\n/).slice(-60).join('\n'); } catch {}
  return { channel: readConfig().cfg?.update?.channel || 'stable', slots: listUpdateSlots(), productRoot: PRODUCT_ROOT, log: UPDATE_LOG, logTail };
}

function pinnedUpstream() {
  try {
    const u = JSON.parse(fs.readFileSync(path.join(PRODUCT_ROOT, 'ABUZ8_UPSTREAM.json'), 'utf8'));
    return u.upstream ? String(u.upstream).replace(/^.*@/, '') : null;
  } catch { return null; }
}

function npmLatest(tag = 'latest') {
  return new Promise((resolve) => {
    const req = https.get(`https://registry.npmjs.org/openclaw/${tag}`, { timeout: 12000 }, (res) => {
      let b = '';
      res.on('data', (d) => { if (b.length < 200000) b += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          resolve({ tag, version: j.version, time: j.time && j.time[j.version], desc: (j.description || '').slice(0, 300), engineNode: (j.engines && j.engines.node) || null });
        } catch { resolve({ tag, error: 'unparseable' }); }
      });
    });
    req.on('error', (e) => resolve({ tag, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ tag, error: 'timeout' }); });
  });
}

const NODE_ENGINE_BY_VERSION = {
  '2026.9.2': '>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0',
  '2026.9.3': '>=24.16.0 <25 || >=26.1.0',
  '2026.9.4': '>=24.16.0 <25 || >=26.1.0',
};

async function bundledNodeVersion() {
  try {
    const exe = cfg.firstExisting([path.join(RESOURCES, 'runtime', 'node', 'node.exe'), path.join(OPC1_ROOT, 'runtime', 'node', 'node.exe')]);
    if (!exe) return null;
    return String((await execFileAsync(exe, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true })).stdout).trim();
  } catch { return null; }
}
function releaseDetails(version) {
  return new Promise((resolve) => {
    const req = https.get('https://api.github.com/repos/openclaw/openclaw/releases/tags/v' + encodeURIComponent(version), {
      headers: { 'User-Agent': 'OPC-1-update-preview', Accept: 'application/vnd.github+json' }, timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { if (body.length < 256000) body += chunk; });
      res.on('end', () => {
        try { const j = JSON.parse(body); resolve({ title: j.name || version, notes: typeof j.body === 'string' ? j.body.slice(0, 16000) : '', url: j.html_url || null, publishedAt: j.published_at || null, error: res.statusCode !== 200 ? 'Release notes unavailable (' + res.statusCode + ')' : null }); }
        catch { resolve({ notes: '', error: 'Release notes unavailable' }); }
      });
    });
    req.on('error', () => resolve({ notes: '', error: 'Release notes unavailable' }));
    req.on('timeout', () => { req.destroy(); resolve({ notes: '', error: 'Release notes request timed out' }); });
  });
}
let previewCache = null, previewJob = null;
async function upstreamPreview(channel) {
  if (previewCache && previewCache.channel === channel && Date.now() - previewCache.at < 10 * 60 * 1000) return previewCache;
  if (previewJob) return previewJob;
  previewJob = (async () => {
    const latest = await npmLatest(channel === 'stable' ? 'latest' : channel);
    const release = latest.version ? await releaseDetails(latest.version) : { notes: '', error: latest.error };
    return previewCache = { channel, at: Date.now(), latest, release };
  })().finally(() => { previewJob = null; });
  return previewJob;
}

function satisfiesRange(version, range) {
  if (!version || !range) return null;
  const v = String(version).replace(/^v/, '').split('.').map(Number);
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d < 0 ? -1 : 1; }
    return 0;
  };
  return range.split('||').some((clause) => clause.trim().split(/\s+/).filter(Boolean).every((part) => {
    const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(part.trim());
    if (!m) return false;
    const bound = m[2].split('.').map(Number);
    while (bound.length < 3) bound.push(0);
    const c = cmp(v, bound);
    switch (m[1] || '=') {
      case '>=': return c >= 0;
      case '>': return c > 0;
      case '<=': return c <= 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  }));
}

async function updateDiff({ checkCompatibility = false } = {}) {
  const pinned = pinnedUpstream();
  const channel = readConfig().cfg?.update?.channel || 'stable';
  const { latest, release } = await upstreamPreview(channel);
  const available = !!(pinned && latest.version && pinned !== latest.version && !latest.error);
  const nodeBundled = await bundledNodeVersion();
  const requires = latest.engineNode || (latest.version ? NODE_ENGINE_BY_VERSION[latest.version] || null : null);
  const nodeOk = requires ? satisfiesRange(nodeBundled, requires) : null;
  const blockers = [];
  if (available) {
    blockers.push('vendored install: `openclaw update` refuses with "package manager owner is unknown" — resources\\app is bundled inside the Electron app, no package manager owns it. The package must be overlaid by hand (npm pack + merge).');
    if (nodeOk === false) blockers.push(`bundled Node ${nodeBundled} does not satisfy ${latest.version}'s requirement (${requires}). resources\\runtime\\node\\node.exe must be replaced first or the gateway will not start.`);
    blockers.push('sqlite schema migration is forward-only: once the new build opens the state DB, ' + `${pinned} refuses it. Rollback becomes restore-from-backup, not a downgrade.`);
  }
  if (checkCompatibility && !upgradeJobs.has('["preflight"]')) {
    lastPreflight = null;
    runUpgrade(['preflight'], { timeout: 180000 }).catch((e) => { lastPreflight = { at: Date.now(), result: { error: e.message } }; });
  }
  const pre = lastPreflight && Date.now() - lastPreflight.at < 10 * 60 * 1000 ? lastPreflight.result : null;
  const toolOk = pre && !pre.error && Array.isArray(pre.blockers);
  const realBlockers = toolOk ? pre.blockers.map((b) => `${b.id}: ${b.detail}${b.fix ? ` — fix: ${b.fix}` : ''}`) : blockers;
  const selfApplicable = toolOk ? !!pre.selfApplicable && available : false;
  return {
    pinned, channel, latest, release, updateAvailable: available, selfApplicable,
    compatibility: { status: upgradeJobs.has('["preflight"]') ? 'checking' : pre ? (pre.error ? 'failed' : pre.selfApplicable ? 'ready' : 'blocked') : 'not-checked', result: pre },
    blockers: available ? realBlockers : [],
    warnings: toolOk ? pre.warnings : [],
    localEdits: toolOk ? { discovered: pre.localEdits?.modified ?? null, covered: (pre.localEdits?.covered || []).map((c) => c.file), uncovered: (pre.localEdits?.uncovered || []).map((c) => c.file), flagged: (pre.localEdits?.covered || []).filter((c) => c.flagged).map((c) => c.rule) } : null,
    node: { bundled: nodeBundled, requiredByLatest: requires, satisfied: nodeOk },
    releaseUrl: latest.version ? `https://github.com/openclaw/openclaw/releases/tag/v${latest.version}` : null,
    apply: selfApplicable ? 'POST /api/update/apply {"target":"<version>"} — overlay updater: verified state backup, dist replaced, local edits re-applied, deps reinstalled. Rollback: POST /api/update/rollback.' : (available ? `NOT yet applicable: ${realBlockers.length} blocker(s) above. Clear them (e.g. POST /api/update/node-swap) and re-check.` : 'up to date'),
    tool: toolOk ? { preflight: 'GET /api/update/preflight', inventory: 'GET /api/update/inventory', nodeSwap: 'POST /api/update/node-swap', verify: 'GET /api/update/verify' } : { error: pre && pre.error },
  };
}

module.exports = {
  snapshotUpdate,
  listUpdateSlots,
  rollbackUpdate,
  applyUpdate,
  runUpgrade,
  updateState,
  updateDiff,
};
