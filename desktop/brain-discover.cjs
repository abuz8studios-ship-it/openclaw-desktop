#!/usr/bin/env node
// brain-discover.cjs — 2026-09-02 (Ahmad's rule: "if there is a brain anywhere on
// the system they should both be able to automatically find it and bind to it").
//
// Scans this machine for every OpenAI-compatible engine (llama.cpp, vLLM, LM Studio,
// Ollama, FreeToken, LiteLLM, anything on the usual ports), records the live ones
// in C:\Users\wirec\.openclaw-OPC-1\body\brains.json (mirror: E:\ABU\ops\brains.json), and binds BOTH bodies to them:
//   • OpenClaw / OPC-1  → sovereign home openclaw.json  models.providers.auto-<port>
//   • Hermes            → %LOCALAPPDATA%\hermes\config.yaml  (via hermes_brain_sync.py)
// Dead auto-providers are removed again on the next scan, so no dead paths linger.
// Nemotron :8001 stays primary for both; discovered brains are added as fallbacks.
// Cloud brains: any provider in openclaw.json with an https baseUrl is probed for
// /models and reported live/dead in brains.json (keys are never printed).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');

const os = require('node:os');
const HOME = process.env.USERPROFILE || os.homedir();
const ROOT = process.env.OPC1_HOME || path.join(os.homedir(), '.openclaw-OPC-1');
const OPENCLAW = process.env.OPENCLAW_CONFIG_PATH || path.join(ROOT, 'home', 'openclaw.json');
const REGISTRY = path.join(ROOT, 'body', 'brains.json');
const REGISTRY_MIRROR = 'E:\\ABU\\ops\\brains.json'; // Hermes compat (best-effort)
const HERMES_SYNC = 'E:\\ABU\\ops\\hermes_brain_sync.py';
const HERMES_PY = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe');
const PRIMARY_PORT = 8001;

// Ports worth knocking on. Cheap: one HEAD-sized GET each, 1.5s timeout.
const PORTS = [8001, 8000, 8002, 8003, 8004, 8005, 8008, 8010, 8011, 8012, 8013, 8014, 8015, 8020, 8080, 8081, 8090, 8100,
  1234, 5000, 5001, 5118, 5120, 7860, 8888, 8899, 8900, 9000, 9001, 11434, 11435, 4000, 4141, 3000, 3001, 30000, 8780];

function get(url, timeout = 1500, headers = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { if (body.length < 200000) body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function parseModels(body) {
  try {
    const j = JSON.parse(body);
    if (Array.isArray(j.data)) return j.data.map((m) => m.id).filter(Boolean);
    if (Array.isArray(j.models)) return j.models.map((m) => m.name || m.id).filter(Boolean); // ollama /api/tags
  } catch {}
  return [];
}

async function probePort(port) {
  const base = `http://127.0.0.1:${port}`;
  let r = await get(`${base}/v1/models`);
  let kind = 'openai-compatible';
  if (!r || r.status !== 200) {
    r = await get(`${base}/api/tags`);
    kind = 'ollama';
    if (!r || r.status !== 200) return null;
  }
  const models = parseModels(r.body);
  if (!models.length) return null;
  // llama.cpp exposes /props with the loaded context size; use it when present.
  let ctx = 32768;
  const props = await get(`${base}/props`, 800);
  if (props && props.status === 200) {
    try { const p = JSON.parse(props.body); if (p.default_generation_settings && p.default_generation_settings.n_ctx) ctx = p.default_generation_settings.n_ctx; } catch {}
  }
  return { port, baseUrl: kind === 'ollama' ? `${base}/v1` : `${base}/v1`, kind, models, contextWindow: ctx };
}

async function probeCloud(name, p) {
  const url = (p.baseUrl || '').replace(/\/$/, '') + '/models';
  const r = await get(url, 4000, { Authorization: `Bearer ${p.apiKey || ''}`, 'x-api-key': p.apiKey || '', 'anthropic-version': '2023-06-01' });
  return { name, baseUrl: p.baseUrl, live: !!r && r.status < 400, status: r ? r.status : null };
}

async function main() {
  const local = (await Promise.all(PORTS.map(probePort))).filter(Boolean);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(OPENCLAW, 'utf8')); } catch (e) { console.error('openclaw.json unreadable:', e.message); process.exit(2); }
  cfg.models = cfg.models || {}; cfg.models.providers = cfg.models.providers || {};
  const prov = cfg.models.providers;

  // Cloud: every https provider already configured (keys live in openclaw.json).
  const cloud = [];
  for (const [name, p] of Object.entries(prov)) {
    if (/^https:/.test(p.baseUrl || '')) cloud.push(await probeCloud(name, p));
  }

  // Which local engines are already hand-configured (non-auto)? Don't duplicate them.
  const handPorts = new Set();
  for (const [name, p] of Object.entries(prov)) {
    if (!/^auto-\d+$/.test(name)) { const m = /127\.0\.0\.1:(\d+)|localhost:(\d+)/.exec(p.baseUrl || ''); if (m) handPorts.add(Number(m[1] || m[2])); }
  }
  // Snapshot auto-providers BEFORE mutate. Rewriting openclaw.json on every
  // scan invalidates the Control UI config hash (2026.9.1:
  // "config changed since last load; re-run config.get and retry").
  const autoSig = (obj) => JSON.stringify(
    Object.keys(obj).filter((k) => obj[k] && /^auto-\d+$/.test(k)).sort().map((k) => ({
      k, baseUrl: obj[k].baseUrl, ids: (obj[k].models || []).map((m) => m.id),
    }))
  );
  const prevAuto = autoSig(prov);

  // Drop stale auto providers, then add the live ones.
  for (const name of Object.keys(prov)) {
    // One-time heal (2026-09-18): pre-fix scans persisted `_auto: true` flags
    // that the gateway validator rejects as unrecognized keys. The auto set is
    // now keyed on the `auto-<port>` name alone, so the flag is dead weight.
    if (prov[name] && prov[name]._auto) delete prov[name]._auto;
    if (/^auto-\d+$/.test(name)) delete prov[name];
  }
  const d = cfg.agents = cfg.agents || {}; d.defaults = d.defaults || {}; d.defaults.model = d.defaults.model || {};
  const fb = (d.defaults.model.fallbacks || []).filter((f) => !/^auto-\d+\//.test(f));
  const bound = [];
  for (const b of local) {
    if (handPorts.has(b.port)) { bound.push({ ...b, boundAs: 'hand-configured' }); continue; }
    const name = `auto-${b.port}`;
    prov[name] = {
      api: 'openai-completions',
      apiKey: b.kind === 'ollama' ? 'ollama' : 'local',
      baseUrl: b.baseUrl,
      models: b.models.slice(0, 12).map((id) => ({ id, name: `${id} (auto :${b.port})`, contextWindow: b.contextWindow, maxTokens: 8192, input: ['text'] })),
    };
    if (b.port !== PRIMARY_PORT) fb.push(`${name}/${b.models[0]}`);
    bound.push({ ...b, boundAs: name });
  }
  const nextAuto = autoSig(prov);
  if (prevAuto !== nextAuto) {
    d.defaults.model.fallbacks = fb;
    fs.writeFileSync(OPENCLAW, JSON.stringify(cfg, null, 2));
    console.log('brains: openclaw.json updated (auto-provider delta)');
  } else {
    console.log('brains: openclaw.json left untouched (no auto-provider delta)');
  }

  const registry = { scannedAt: new Date().toISOString(), primary: `http://127.0.0.1:${PRIMARY_PORT}/v1`, local: bound, cloud };
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2));
  try { fs.mkdirSync(path.dirname(REGISTRY_MIRROR), { recursive: true }); fs.writeFileSync(REGISTRY_MIRROR, JSON.stringify(registry, null, 2)); } catch {}
  console.log(`brains: ${bound.length} local, ${cloud.filter((c) => c.live).length}/${cloud.length} cloud live`);

  // Hand the same registry to Hermes.
  if (fs.existsSync(HERMES_SYNC) && fs.existsSync(HERMES_PY)) {
    await new Promise((res) => { const c = spawn(HERMES_PY, [HERMES_SYNC], { windowsHide: true, stdio: 'inherit' }); c.on('exit', res); c.on('error', res); });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
