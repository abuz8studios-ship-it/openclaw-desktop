#!/usr/bin/env node
// brain-discover.cjs — 2026-09-02 (Ahmad's rule: "if there is a brain anywhere on
// the system they should be able to find it").
//
// Scans this machine for every OpenAI-compatible engine (llama.cpp, vLLM, LM Studio,
// Ollama, FreeToken, anything on the usual ports), records the live ones
// in C:\Users\wirec\.openclaw-OPC-1\body\brains.json. Discovery is an inventory:
// explicit provider routes and fallback choices remain in the canonical config.
// The thinker role's port comes from the model registry.
// Cloud brains: any provider in openclaw.json with an https baseUrl is probed for
// /models and reported live/dead in brains.json (keys are never printed).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const os = require('node:os');
const ROOT = process.env.OPC1_HOME || path.join(os.homedir(), '.openclaw-OPC-1');
const OPENCLAW = process.env.OPENCLAW_CONFIG_PATH || path.join(ROOT, 'home', 'openclaw.json');
const REGISTRY = path.join(ROOT, 'body', 'brains.json');
let ModelReg = null;
try { ModelReg = require('./models-registry.cjs'); } catch {}
function registryPrimaryPort() {
  // Thinker role port wins (user binding); shipped default is the fallback.
  try {
    const home = JSON.parse(fs.readFileSync(path.join(ROOT, 'home', 'models.registry.json'), 'utf8'));
    if (home.roles && home.roles.thinker && home.roles.thinker.port) return Number(home.roles.thinker.port);
  } catch {}
  try {
    if (ModelReg) {
      const reg = ModelReg.loadRegistry(ROOT, __dirname);
      if (reg.roles && reg.roles.thinker && reg.roles.thinker.port) return Number(reg.roles.thinker.port);
    }
  } catch {}
  return 8111; // 2026-09-30: thinker moved off 8011 (QadirOS owns it); registry is the real source
}
const PRIMARY_PORT = registryPrimaryPort();

// Ports worth knocking on: the FULL local-llama range (any model on any port —
// nothing is invisible for living on an unlisted port) plus the usual suspects
// for Ollama/LM Studio/vLLM/other services.
const PORTS = [];
for (let p = 8000; p <= 8030; p++) PORTS.push(p);
PORTS.push(1234, 5000, 5001, 5118, 5120, 7860, 8888, 8899, 8900, 9000, 9001, 11434, 11435, 4141, 3000, 3001, 30000, 8780);

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
  const bound = local.map((b) => ({ ...b, boundAs: handPorts.has(b.port) ? 'configured' : 'discovered' }));

  const registry = { scannedAt: new Date().toISOString(), primary: `http://127.0.0.1:${PRIMARY_PORT}/v1`, local: bound, cloud };
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2));
  console.log(`brains: ${bound.length} local, ${cloud.filter((c) => c.live).length}/${cloud.length} cloud live`);

}
main().catch((e) => { console.error(e); process.exit(1); });
