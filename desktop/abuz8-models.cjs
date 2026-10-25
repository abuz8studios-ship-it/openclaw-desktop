'use strict';

// abuz8-models.cjs — Local Model Control, bundled inside OPC-1.
// Ahmad 2026-09-03: "where can I pick and choose my local models?"
// Answer: this panel. Served on loopback only (127.0.0.1:18790) and opened in
// a Zait window — no browser, no shell.
//
// 2026-09-20 Harness Stage 2 (PRD_PLUGGABLE_HARNESS.md §4, kind: surface):
// this file used to BE the model registry, the fleet supervisor, the health
// checker, the HF client, the benchmark runner, and the updater surface —
// 1,492 lines, one file, no seams. It is now the HTTP server and routing
// table ONLY. Everything it used to compute now lives behind a require():
//   abuz8-config.cjs    — shared path roots, config I/O, net probes, scoring
//   abuz8-registry.cjs  — kind: brain   — disk scan, start/stop, roles, fleet
//   abuz8-ledger.cjs    — kind: ledger  — benchmarks, media health, HF catalogue, logs
//   abuz8-kernel.cjs    — Stage 0/1     — capability manifests, /api/kernel/status
//   abuz8-tokenomics.cjs                — /api/tokenomics
//   abuz8-upgrade.cjs                  — the real upgrade tool this file shells out to
// The update-bridge functions (snapshot/rollback/apply/diff against upstream)
// stay HERE rather than in a fifth module: they are UI plumbing specific to
// this panel's update buttons, not a capability another surface would mount.
//
// The one compatibility contract that matters: electron-main.cjs requires
// this file and calls exactly two things — startPanelServer() and
// stopManaged(). Both behave identically to before the split; stopManaged()
// is a straight re-export of the registry's own (it owns the child-process
// map, this file must never keep a second one).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const cfg = require('./abuz8-config.cjs');
const registry = require('./abuz8-registry.cjs');
const ledger = require('./abuz8-ledger.cjs');

const { STATE_DIR, readConfig, portOpen } = cfg;

const PANEL_BASE = Number(process.env.OPC1_PANEL_PORT || 18790);
const PANEL_PORTS = [PANEL_BASE, PANEL_BASE + 1, PANEL_BASE + 2];
const updateBridge = require('./abuz8-update-bridge.cjs');

// ══════════════════════════════════════════════════════════════════ HTTP surface

// ── 2026-09-30 loopback guard ────────────────────────────────────────────────
// This panel binds 127.0.0.1 but has no auth, and its POST routes parse JSON no
// matter the content-type. Any web page in the user's browser could therefore
// fire a no-CORS fetch at /api/stop or /api/fleet (CSRF), and DNS rebinding
// could read responses. Two cheap, broad checks close both: the Host must be a
// loopback name, and a browser-supplied Origin must be this panel itself.
// curl/CLI send no Origin and are unaffected; the in-app window is same-origin.
function loopbackOk(req) {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return false;
  if (origin === 'null') return false;
  return true;
}

// ── isnad ledger bridge (kernel/isnad_core.py does the work; read-mostly) ──
const PY_EXE = (() => { for (const c of ['C:/Program Files/Python311/python.exe']) { try { if (fs.existsSync(c)) return c; } catch {} } return 'python'; })();
const ISNAD_CORE = path.join(STATE_DIR, 'kernel', 'isnad_core.py');
let _isnadStatusCache = { at: 0, val: null };
function isnadRun(args, timeout = 120000, script = ISNAD_CORE) {
  return new Promise((resolve) => {
    if (!fs.existsSync(script)) return resolve({ ok: false, error: 'script missing: ' + script });
    let out = '', err = '';
    let c;
    try { c = spawn(PY_EXE, ['-X', 'utf8', script, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const to = setTimeout(() => { try { c.kill(); } catch {} resolve({ ok: false, error: 'isnad timed out after ' + timeout + 'ms' }); }, timeout);
    c.stdout.on('data', (d) => { if (out.length < 2000000) out += d; });
    c.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    c.on('error', (e) => { clearTimeout(to); resolve({ ok: false, error: e.message }); });
    c.on('exit', () => { clearTimeout(to); try { resolve(JSON.parse(out)); } catch { resolve({ ok: false, error: 'isnad returned no JSON', stderr: err.slice(-400) }); } });
  });
}
async function isnadStatus() {
  if (_isnadStatusCache.val && Date.now() - _isnadStatusCache.at < 10000) return _isnadStatusCache.val;
  const v = await isnadRun(['status'], 60000);
  _isnadStatusCache = { at: Date.now(), val: v };
  return v;
}
// Body-side periodic sync (electron-main calls this): incremental, takes the
// ledger write lock, anchors off-volume. Never throws.
async function isnadSync() { _isnadStatusCache = { at: 0, val: null }; return isnadRun(['sync'], 180000); }
// The directory (yellow pages): rescans skills/mcp/http/connectors/services into small catalogs.
const DIRECTORY_PY = path.join(STATE_DIR, 'directory', 'dir.py');
async function directoryBuild() { return isnadRun(['build'], 120000, DIRECTORY_PY); }

function send(res, code, obj, type = 'application/json') {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function startPanelServer({ onRestartGateway, onDiscover, onStudio, onPark } = {}) {
  const htmlPath = path.join(__dirname, 'abuz8-models.html');
  const avatarPath = path.join(__dirname, 'avatar.html');
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (!loopbackOk(req)) { send(res, 403, { error: 'forbidden: loopback host/origin only' }); return; }
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
        try { send(res, 200, fs.readFileSync(htmlPath, 'utf8'), 'text/html; charset=utf-8'); }
        catch { send(res, 500, { error: 'panel html missing' }); }
        return;
      }
      if (req.method === 'GET' && u.pathname === '/avatar') {
        try { send(res, 200, fs.readFileSync(avatarPath, 'utf8'), 'text/html; charset=utf-8'); }
        catch { send(res, 500, { error: 'avatar html missing' }); }
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/state') { send(res, 200, await registry.state()); return; }
      if (req.method === 'GET' && u.pathname === '/api/resolve') {
        const ref = String(u.searchParams.get('ref') || '').slice(0, 300);
        if (!ref) { send(res, 400, { error: 'ref required' }); return; }
        send(res, 200, registry.resolveModel(ref));
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/vram') { send(res, 200, await registry.vramSnapshot()); return; }
      if (req.method === 'GET' && u.pathname === '/api/logs') { send(res, 200, { logs: ledger.listLogs() }); return; }
      if (req.method === 'GET' && u.pathname === '/api/update/state') { send(res, 200, updateBridge.updateState()); return; }
      if (req.method === 'GET' && u.pathname === '/api/update/diff') { send(res, 200, await updateBridge.updateDiff({checkCompatibility:u.searchParams.get('checkCompatibility')==='true'})); return; }
      // Harness Stage 0/1: what the kernel thinks is mounted, from the
      // manifests in resources\plugins, cross-checked live against real ports.
      if (req.method === 'GET' && u.pathname === '/api/kernel/status') {
        try { send(res, 200, await require('./abuz8-kernel.cjs').status()); }
        catch (e) { send(res, 500, { error: e.message }); }
        return;
      }
      // Tokenomics: what the fleet actually spent, in tokens and in dollars,
      // rolled up from the agent transcripts. Read-only.
      if (req.method === 'GET' && u.pathname === '/api/tokenomics') {
        try {
          const days = Number(u.searchParams.get('days')) || 30;
          send(res, 200, require('./abuz8-tokenomics.cjs').tokenomics({ days, refresh: u.searchParams.get('refresh') === '1' }));
        } catch (e) { send(res, 500, { error: e.message }); }
        return;
      }
      // The upgrade tool, surfaced. Reads only — the two writing calls
      // (node-swap, apply) go through the POST table below.
      if (req.method === 'GET' && u.pathname === '/api/update/preflight') { send(res, 200, await updateBridge.runUpgrade(['preflight'], { timeout: 180000 })); return; }
      if (req.method === 'GET' && u.pathname === '/api/update/inventory') { send(res, 200, await updateBridge.runUpgrade(['inventory'], { timeout: 180000 })); return; }
      if (req.method === 'GET' && u.pathname === '/api/update/verify') { send(res, 200, await updateBridge.runUpgrade(['verify'])); return; }
      if (req.method === 'GET' && u.pathname === '/api/update/slots') { send(res, 200, await updateBridge.runUpgrade(['slots'])); return; }
      if (req.method === 'GET' && u.pathname === '/api/gpu') { send(res, 200, await registry.gpuMap()); return; }
      if (req.method === 'GET' && u.pathname === '/api/models/history') { send(res, 200, { history: registry.loadHistory() }); return; }
      if (req.method === 'GET' && u.pathname === '/api/isnad/status') { send(res, 200, await isnadStatus()); return; }
      if (req.method === 'GET' && u.pathname === '/api/isnad/verify') { _isnadStatusCache = { at: 0, val: null }; send(res, 200, await isnadRun(['verify'], 60000)); return; }
      if (req.method === 'GET' && u.pathname === '/api/isnad/search') {
        const q = String(u.searchParams.get('q') || '').slice(0, 300);
        if (!q.trim()) { send(res, 400, { error: 'q required' }); return; }
        const k = Math.max(1, Math.min(20, Number(u.searchParams.get('k')) || 6));
        const args = ['search', q, '-k', String(k)];
        const mg = u.searchParams.get('min_grade'); if (['hasan', 'sahih'].includes(mg)) args.push('--min-grade', mg);
        send(res, 200, await isnadRun(args, 60000)); return;
      }
      if (req.method === 'GET' && u.pathname === '/api/isnad/chain') {
        const id = String(u.searchParams.get('id') || '');
        if (!/^isn_[0-9a-f]{12}$/.test(id)) { send(res, 400, { error: 'bad id' }); return; }
        send(res, 200, await isnadRun(['chain', id], 60000)); return;
      }
      if (req.method === 'GET' && u.pathname === '/api/benchmark') { send(res, 200, ledger.benchmarkCatalog()); return; }
      if (req.method === 'GET' && u.pathname === '/api/hf/search') {
        try { send(res, 200, await ledger.hfSearch({ q: u.searchParams.get('q') })); }
        catch (e) { send(res, 502, { error: e.message }); }
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/hf/files') {
        try { send(res, 200, await ledger.hfFiles({ repo: u.searchParams.get('repo') })); }
        catch (e) { send(res, 400, { error: e.message }); }
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/hf/resolve') {
        try { send(res, 200, await ledger.hfResolve({ repo: u.searchParams.get('repo'), quant: u.searchParams.get('quant'), file: u.searchParams.get('file') })); }
        catch (e) { send(res, 400, { error: e.message }); }
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/hf/downloads') { send(res, 200, ledger.hfDownloads()); return; }
      if (req.method === 'GET' && u.pathname === '/api/model-folders') { send(res, 200, { folders: registry.readModelFolders(), roots: registry.modelsRoots() }); return; }
      if (req.method === 'GET' && u.pathname === '/api/roles') { send(res, 200, await registry.rolesState()); return; }
      if (req.method === 'GET' && u.pathname === '/api/health/tcp') {
        const gwPort = Number(process.env.OPC1_GATEWAY_PORT || 18789);
        const panelPort = Number(process.env.OPC1_PANEL_PORT || PANEL_BASE || 18790);
        const memosPort = Number(process.env.OPC1_MEMOS_PORT || 18799);
        const reg = registry.loadReg();
        const roleRequired = (role) => {
          const r = reg && reg.roles && reg.roles[role];
          return !r || r.auto !== false;
        };
        const children = [
          ['gateway', gwPort], ['panel', panelPort], ['memos', memosPort],
          // role ports come from the registry (2026-09-30: literals 8011/8012/8021
          // went stale on the port move and reported three live brains DOWN).
          ['ornith', registry.rolePort('thinker', 8111), roleRequired('thinker')],
          ['vision', registry.rolePort('vision', 8112), roleRequired('vision')],
          ['embed', registry.rolePort('embedder', 8121), roleRequired('embedder')],
          ['voice', 8094], ['qwen_tts', 8095], ['comfy', 8188], ['hands', 8790],
        ];
        // :8001 Nemotron is NOT a stranger-pack child — listed as optional/manual only.
        const optional = [['nemotron_manual', 8001, false]];
        const row = async ([name, port, required = true]) => ({ name, port, required, up: await portOpen(port) });
        const all = await Promise.all(children.map(row));
        const required = all.filter((r) => r.required);
        const optionalChildren = all.filter((r) => !r.required);
        const opt = await Promise.all(optional.map(row));
        send(res, 200, { at: new Date().toISOString(), via: 'tcp', required, optional: [...optionalChildren, ...opt], allRequiredUp: required.every((r) => r.up) });
        return;
      }
      // 2026-09-16 body doctor. GET = last boot's report (cheap, no disk churn);
      // ?run=1 or POST = run it now. /api/health/tcp answers "are my children
      // alive"; this answers "is my own skeleton intact".
      if (u.pathname === '/api/health/doctor' && (req.method === 'GET' || req.method === 'POST')) {
        try {
          const doc = require('./abuz8-doctor.cjs');
          if (req.method === 'POST' || u.searchParams.get('run') === '1') {
            send(res, 200, doc.run({ repair: u.searchParams.get('check') !== '1' }));
          } else {
            const last = doc.lastReport();
            send(res, 200, last || { at: null, note: 'no report yet — POST here or GET ?run=1 to run the doctor' });
          }
        } catch (e) { send(res, 500, { error: e && e.message }); }
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/health/media') { send(res, 200, await ledger.mediaHealth()); return; }
      if (req.method === 'GET' && u.pathname === '/api/log') {
        try { send(res, 200, { file: u.searchParams.get('file'), tail: ledger.tailLog(u.searchParams.get('file'), Number(u.searchParams.get('n')) || 60) }); }
        catch (e) { send(res, 400, { error: e.message }); }
        return;
      }
      if (req.method === 'POST' && ['/api/start', '/api/stop', '/api/primary', '/api/roles/bind', '/api/roles/park', '/api/ensure', '/api/restart-gateway', '/api/discover', '/api/studio/free', '/api/studio/restore', '/api/swarm', '/api/collective', '/api/provider', '/api/huggingface/defaults', '/api/update/snapshot', '/api/update/rollback', '/api/update/apply', '/api/update/node-swap', '/api/fleet', '/api/hf/download', '/api/hf/fetch', '/api/benchmark/run', '/api/model-folders', '/api/voice/install', '/api/isnad/sync'].includes(u.pathname)) {
        let b = '';
        req.on('data', (d) => { if (b.length < 20000) b += d; });
        req.on('end', async () => {
          let body = {};
          try { body = b ? JSON.parse(b) : {}; } catch { send(res, 400, { error: 'bad json' }); return; }
          try {
            if (u.pathname === '/api/start') send(res, 200, await registry.startModel(body));
            else if (u.pathname === '/api/stop') send(res, 200, await registry.stopModel(body));
            else if (u.pathname === '/api/ensure') send(res, 200, { key: registry.ensureProvider(body.alias, Number(body.port), body.kind) });
            else if (u.pathname === '/api/primary') { send(res, 200, registry.setPrimary(body)); }
            else if (u.pathname === '/api/roles/bind') { send(res, 200, registry.bindRole(body)); }
            else if (u.pathname === '/api/restart-gateway') { onRestartGateway && onRestartGateway(); send(res, 200, { restarting: true }); }
            else if (u.pathname === '/api/discover') { onDiscover && onDiscover(); send(res, 200, { rescanning: true }); }
            else if (u.pathname === '/api/studio/free') { onStudio && onStudio('free', body); send(res, 200, { freeing: true, deep: !!body.deep }); }
            else if (u.pathname === '/api/studio/restore') { onStudio && onStudio('restore', body); send(res, 200, { restoring: true }); }
            else if (u.pathname === '/api/roles/park') {
              if (!body.role) throw new Error('role required');
              send(res, 200, onPark ? onPark(body.role, body.park !== false) : { parked: false, note: 'park not wired (panel standalone)' });
            }
            else if (u.pathname === '/api/swarm') { send(res, 200, await registry.runSwarm(body)); }
            else if (u.pathname === '/api/fleet') { send(res, 200, await registry.runFleet(body)); }
            else if (u.pathname === '/api/collective') { send(res, 200, ledger.ensureCompanyBrain(body)); }
            else if (u.pathname === '/api/provider') { send(res, 200, registry.ensureCloudProvider(body)); }
            else if (u.pathname === '/api/huggingface/defaults') { send(res, 200, registry.ensureHuggingFaceModels(body)); }
            else if (u.pathname === '/api/update/snapshot') { send(res, 200, updateBridge.snapshotUpdate(body)); }
            else if (u.pathname === '/api/update/rollback') { send(res, 200, await updateBridge.rollbackUpdate(body)); }
            else if (u.pathname === '/api/update/apply') { send(res, 200, updateBridge.applyUpdate(body)); }
            // Clears the Node blocker on its own. Reversible and touches no
            // database, so it is the one upgrade step safe to run by itself.
            else if (u.pathname === '/api/update/node-swap') { send(res, 200, await updateBridge.runUpgrade(['node-swap', '--to', String(body.to || '26.7.0')].concat(body.dryRun ? ['--dry-run'] : []), { timeout: 900000 })); }
            else if (u.pathname === '/api/hf/download') { send(res, 200, ledger.hfDownload(body)); }
            else if (u.pathname === '/api/hf/fetch') { send(res, 200, await ledger.hfFetch(body)); }
            else if (u.pathname === '/api/benchmark/run') { send(res, 200, await ledger.benchmarkRun(body)); }
            else if (u.pathname === '/api/model-folders') { send(res, 200, body.action === 'remove' ? registry.removeModelFolder(body) : registry.addModelFolder(body)); }
            else if (u.pathname === '/api/voice/install') { send(res, 200, ledger.voiceInstall()); }
            else if (u.pathname === '/api/isnad/sync') { send(res, 200, await isnadSync()); }
          } catch (e) { send(res, e.statusCode || 500, { error: e.message }); }
        });
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 500, { error: e.message }); }
  });
  return new Promise((resolve) => {
    const tryPort = (i) => {
      if (i >= PANEL_PORTS.length) return resolve({ server: null, port: null });
      server.once('error', () => tryPort(i + 1));
      server.listen(PANEL_PORTS[i], '127.0.0.1', () => resolve({ server, port: PANEL_PORTS[i] }));
    };
    tryPort(0);
  });
}

// Full backward-compatible export surface. Only startPanelServer and
// stopManaged are consumed by electron-main.cjs today (verified 2026-09-20 —
// grep for "ModelsPanel\." before removing anything here); the rest is kept
// re-exported so nothing that ever imported this module for its functions
// breaks silently.
module.exports = {
  startPanelServer,
  stopManaged: registry.stopManaged,
  scanDisk: registry.scanDisk,
  state: registry.state,
  startModel: registry.startModel,
  stopModel: registry.stopModel,
  setPrimary: registry.setPrimary,
  ensureProvider: registry.ensureProvider,
  ensureCloudProvider: registry.ensureCloudProvider,
  ensureHuggingFaceModels: registry.ensureHuggingFaceModels,
  benchmarkCatalog: ledger.benchmarkCatalog,
  ensureCompanyBrain: ledger.ensureCompanyBrain,
  snapshotUpdate: updateBridge.snapshotUpdate,
  rollbackUpdate: updateBridge.rollbackUpdate,
  applyUpdate: updateBridge.applyUpdate,
  updateState: updateBridge.updateState,
  runFleet: registry.runFleet,
  gpuMap: registry.gpuMap,
  isnadSync,
  isnadStatus,
  directoryBuild,
  vramSnapshot: registry.vramSnapshot,
};
