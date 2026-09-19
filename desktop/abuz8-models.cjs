'use strict';

// abuz8-models.cjs — Local Model Control, bundled inside OPC-1.
// Ahmad 2026-09-03: "where can I pick and choose my local models?"
// Answer: this panel. It scans E:\ABU\MODELS\llm for GGUFs on disk,
// shows which are RUNNING (port probes), starts/stops llama-server
// headless (windowsHide, logs to files — never a terminal window),
// and binds choices into C:\Users\wirec\.openclaw-OPC-1\home\openclaw.json
// (provider + primary/fallbacks per role). Served on loopback only
// (127.0.0.1:18790) and opened in a Zait window — no browser, no shell.
//
// 2026-09-04 sovereign-root fix: STATE_DIR is the NEW home room
// (C:\Users\wirec\.openclaw-OPC-1\home). The OLD dir
// C:\Users\wirec\.openclaw stays on disk as a COLD backup — never read.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

// 2026-09-10 (installer): every root resolves from env or the OS user home —
// never a hardcoded machine path. E: locations stay as OPTIONAL extras.
const os = require('node:os');
const OPC1_ROOT = process.env.OPC1_HOME || path.join(os.homedir(), '.openclaw-OPC-1');
const RESOURCES = path.join(__dirname, '..'); // resources\app -> resources
function firstExisting(candidates) { return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || candidates[0]; }
// 2026-09-11 (E: is NEVER required): the default model cache lives under the
// current user's OPC-1 root. E:\ABU\MODELS\llm is an OPTIONAL Ahmad-compat
// extra — scanned only when it exists (or force-disabled with
// OPC1_DISABLE_E_COMPAT=1 for clean-room verification). User-selected extra
// folders come from model-folders.json next to the OPC-1 root.
const E_MODELS = 'E:\\ABU\\MODELS\\llm';
const E_COMPAT = !process.env.OPC1_DISABLE_E_COMPAT;
const E_MODELS_PRESENT = E_COMPAT && fs.existsSync(E_MODELS);
const MODELS_ROOT = process.env.OPC1_MODELS || path.join(OPC1_ROOT, 'models');
try { fs.mkdirSync(MODELS_ROOT, { recursive: true }); } catch {}
const FOLDERS_FILE = path.join(OPC1_ROOT, 'model-folders.json');
// 2026-09-11: the ONLY runtime is the bundled engine (resources\engine).
// No E:\ABU fallback, ever. If the bundled engine is missing the install is
// broken -> state() reports engine.present=false and startModel refuses with
// a repair message (reinstall/repair Zait OPC-1).
const RUNTIME = firstExisting([
  path.join(RESOURCES, 'engine', 'llama-server.exe'),
  path.join(OPC1_ROOT, 'runtime', 'llama', 'llama-server.exe'),
]);
// User-selected extra model folders: model-folders.json holds
// { "folders": ["D:\\my-models", ...] }. The Ahmad mirror is appended
// automatically when present. Neither is required for anything.
function readFolderList() {
  let folders = [];
  try {
    const j = JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8'));
    if (Array.isArray(j.folders)) folders = j.folders.filter((f) => typeof f === 'string' && f.trim());
  } catch {}
  return folders;
}
function writeFolderList(folders) {
  fs.mkdirSync(path.dirname(FOLDERS_FILE), { recursive: true });
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify({ folders }, null, 2));
}
function addFolder(folder) {
  folder = String(folder || '').trim();
  if (!folder) throw new Error('folder path required');
  const abs = path.resolve(folder);
  if (!fs.existsSync(abs)) throw new Error('folder does not exist: ' + abs);
  if (!fs.statSync(abs).isDirectory()) throw new Error('not a directory: ' + abs);
  const folders = readFolderList();
  if (folders.some((f) => path.resolve(f).toLowerCase() === abs.toLowerCase())) return { folders, added: false };
  folders.push(abs);
  writeFolderList(folders);
  return { folders, added: true };
}
function removeFolder(folder) {
  const folders = readFolderList().filter((f) => path.resolve(f).toLowerCase() !== path.resolve(String(folder || '')).toLowerCase());
  writeFolderList(folders);
  return { folders };
}
// Every scan root: default cache + user folders + optional Ahmad mirror.
// { root, label } — label prefixes the dir tag so aliases never collide.
function scanRoots() {
  const roots = [{ root: MODELS_ROOT, label: null }];
  for (const f of readFolderList()) {
    try { if (fs.existsSync(f) && fs.statSync(f).isDirectory()) roots.push({ root: f, label: path.basename(f) }); } catch {}
  }
  if (E_MODELS_PRESENT) roots.push({ root: E_MODELS, label: 'ABU-MODELS' });
  const seen = new Set();
  return roots.filter((r) => { const k = path.resolve(r.root).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
const STATE_DIR = path.join(OPC1_ROOT, 'home');
const OPENCLAW_JSON = path.join(STATE_DIR, 'openclaw.json');
const BRAINS_JSON = path.join(OPC1_ROOT, 'body', 'brains.json');
const BRAINS_MIRROR = 'E:\\ABU\\ops\\brains.json';
const PANEL_BASE = Number(process.env.OPC1_PANEL_PORT || 18790);
const PANEL_PORTS = [PANEL_BASE, PANEL_BASE + 1, PANEL_BASE + 2];
const PRODUCT_ROOT = process.env.OPC1_PRODUCT_ROOT || firstExisting(['C:\\ABUZ8-Agents\\ABUZ8-OPC-1', path.join(RESOURCES, '..')]);
const UPDATE_SLOTS_DIR = path.join(PRODUCT_ROOT, 'backups', 'in-app-update-slots');
const COMPANY_BRAIN_PATH = path.join(STATE_DIR, 'kernel', 'company_brain.json');
const BENCHMARK_PATH = path.join(STATE_DIR, 'kernel', 'model_benchmarks.json');
const UPDATE_LOG = path.join(STATE_DIR, 'logs', 'app-update.log');
const COMPANY_BRAIN_PLUGIN_ID = 'memos-local-openclaw-plugin';

const FIXED = {
  'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-IQ4_NL.gguf': { alias: 'nemotron-lightning-30b', port: 8001, fixed: 'executor', starter: 'ps1-nemotron', ctx: 1048576 },
  'Ornith-1.5-35B-A3B-Q4_K_M.gguf': { alias: 'ornith-1.5-35b-a3b', port: 8011, fixed: 'thinker', starter: 'ps1-ornith', ctx: 524288 },
  'gemma-4-E4B-it-Q4_K_M.gguf': { alias: 'gemma-4-e4b-vision', port: 8012, fixed: 'vision', kind: 'vision', ctx: 16384 },
  'nomic-embed-text-v1.5.f16.gguf': { alias: 'nomic-embed-text-v1.5', port: 8021, fixed: 'embedder', kind: 'embed', ctx: 2048 },
};

// Suggested ports for switchable chat models (first free wins if taken).
const PORT_HINTS = {
  'Qwen3.8-27B-ABLITERATED-Q5_K_M.gguf': 8002,
  'Qwen3.8-27B-ABLITERATED-Q6_K.gguf': 8003,
  'Bonsai-27b-Ternary-CRACK-Q2_0.gguf': 8004,
  'Muse-Glimmer-30B-UD-Q4_K_XL.gguf': 8005,
  'Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-DAU-NEO-MAX-NEO-MTP-Q4_K_M.gguf': 8006,
  'Qwen3.5-4B-Q4_K_M.gguf': 8007,
  'LFM2.5-2.6B-Q4_K_M.gguf': 8008,
  'Ternary-Bonsai-27B-Q2_0.gguf': 8009,
  'Muse-Glimmer-30B-UD-Q5_K_L.gguf': 8010,
  'gemma-4-E2B-it-Q4_K_M.gguf': 8013,
  'Qwen3.8-27B-UD-Q5_K_XL.gguf': 8014,
  'Ternary-Bonsai-27B-dspark-Q4_1.gguf': 8015,
};
const POOL = [8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010, 8013, 8014, 8015, 8020, 8000, 8022, 8023, 8024, 8025, 8026, 8027];

const children = new Map(); // port -> ChildProcess (only servers THIS panel started)
const fleetStarted = new Set(); // ports the FLEET started — preset "off" touches only these, never role-fixed brains

function slug(s) {
  return s.replace(/\.gguf$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64);
}

function scanDisk() {
  const out = [];
  for (const { root, label } of scanRoots()) {
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch (e) { if (!label) return { error: 'MODELS root unreadable: ' + e.message, models: [] }; continue; }
  for (const dir of dirs) {    const full = path.join(root, dir);
    let files = [];
    try { files = fs.readdirSync(full).filter((f) => /\.gguf$/i.test(f)); } catch { continue; }
    const mmproj = files.find((f) => /mmproj/i.test(f));
    for (const f of files) {
      if (/mmproj/i.test(f)) continue; // projector, not a model
      if (/mtp-|draft/i.test(f) && !/ABLITERATED-Q5_K_M|ABLITERATED-Q6_K/i.test(f)) continue; // speculative drafts
      let size = 0;
      try { size = fs.statSync(path.join(full, f)).size; } catch {}
      const fix = FIXED[f];
      const isVisionFile = /gemma-4|bonsai.*crack|muse-glimmer/i.test(f) && mmproj;
      out.push({
        dir: label ? `${label}/${dir}` : dir, file: f,
        root,
        path: path.join(full, f),
        mmproj: mmproj ? path.join(full, mmproj) : null,
        gb: Math.round((size / 1073741824) * 100) / 100,
        alias: fix ? fix.alias : slug(f),
        port: fix ? fix.port : (PORT_HINTS[f] || null),
        kind: fix ? (fix.kind || (fix.fixed === 'embedder' ? 'embed' : 'chat')) : (mmproj && /gemma/i.test(f) ? 'vision' : 'chat'),
        fixed: fix ? fix.fixed : null,
        starter: fix ? fix.starter : null,
        visionCapable: !!(mmproj && !fix),
      });
    }
  }
  } // end scan roots
  // disambiguate identical filenames living in different dirs (same alias would collide in config)
  const seenAlias = new Map();
  for (const m of out) {
    if (seenAlias.has(m.alias)) {
      const first = seenAlias.get(m.alias);
      if (!first.tagged) { first.alias = `${first.alias}-${first.dir}`; first.tagged = true; }
      m.alias = `${m.alias}-${m.dir}`;
    } else seenAlias.set(m.alias, m);
  }
  // fixed brains keep their canonical ports; everyone else takes their hint if free, else first free pool port
  const used = new Set(out.filter((m) => m.fixed && m.port).map((m) => m.port));
  for (const m of out) {
    if (m.fixed) continue;
    if (!m.port || used.has(m.port)) m.port = POOL.find((p) => !used.has(p)) || 8020;
    used.add(m.port);
  }
  out.sort((a, b) => (a.fixed ? -1 : b.fixed ? 1 : 0) || a.port - b.port);
  return { models: out };
}

function portOpen(port, ms = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: ms });
    s.on('connect', () => { try { s.destroy(); } catch {} resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { try { s.destroy(); } catch {} resolve(false); });
  });
}

function getJson(url, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let b = '';
      res.on('data', (d) => { if (b.length < 50000) b += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function liveMap(models) {
  const ports = [...new Set(models.map((m) => m.port))];
  const out = {};
  await Promise.all(ports.map(async (p) => {
    const r = await getJson(`http://127.0.0.1:${p}/v1/models`);
    if (r && r.status === 200 && r.json) {
      const ids = Array.isArray(r.json.data) ? r.json.data.map((m) => m.id).filter(Boolean) : [];
      out[p] = { up: true, ids };
    } else if (await portOpen(p)) {
      out[p] = { up: true, ids: [], note: 'port open, /v1/models not answering yet (still loading?)' };
    } else out[p] = { up: false, ids: [] };
  }));
  return out;
}

function readConfig() {
  try { return { cfg: JSON.parse(fs.readFileSync(OPENCLAW_JSON, 'utf8')), error: null }; }
  catch (e) { return { cfg: null, error: e.message }; }
}

function writeConfig(cfg) {
  fs.writeFileSync(OPENCLAW_JSON, JSON.stringify(cfg, null, 2));
}

function providerKeyFor(alias) {
  // hand-configured keys already in openclaw.json keep their names.
  // Tolerant: exact id match first, then prefix either way (covers
  // nemotron-lightning vs nemotron-lightning-30b drift).
  const { cfg } = readConfig();
  if (cfg && cfg.models && cfg.models.providers) {
    for (const [k, p] of Object.entries(cfg.models.providers)) {
      const ids = (p.models || []).map((m) => m.id).filter(Boolean);
      if (ids.includes(alias)) return k;
    }
    for (const [k, p] of Object.entries(cfg.models.providers)) {
      const ids = (p.models || []).map((m) => m.id).filter(Boolean);
      if (ids.some((id) => id.startsWith(alias) || alias.startsWith(id))) return k;
    }
  }
  return 'local-' + alias;
}

function readBrains() {
  try { return JSON.parse(fs.readFileSync(BRAINS_JSON, 'utf8')); }
  catch {
    if (!E_COMPAT) return null;
    try { return JSON.parse(fs.readFileSync(BRAINS_MIRROR, 'utf8')); }
    catch { return null; }
  }
}

function findAgentModel(cfg, id) {
  // 2026.9.1 canonical: agents.entries.<id>.model.
  const entries = cfg?.agents?.entries;
  if (entries && entries[id] && entries[id].model) return entries[id].model;
  return null;
}

function ensureAllow(cfg, ref) {
  // gateway enforces agents.defaults.modelPolicy.allow — a new local ref
  // must be allowlisted or the gateway rejects it silently.
  cfg.agents = cfg.agents || {}; cfg.agents.defaults = cfg.agents.defaults || {};
  cfg.agents.defaults.modelPolicy = cfg.agents.defaults.modelPolicy || {};
  const allow = cfg.agents.defaults.modelPolicy.allow;
  if (Array.isArray(allow) && !allow.includes(ref)) {
    allow.push(ref);
    cfg.agents.defaults.modelPolicy.allow = allow.slice(-80);
  }
}

function listProviderModels(cfg) {
  const providers = cfg?.models?.providers || {};
  const out = [];
  for (const [providerKey, provider] of Object.entries(providers)) {
    for (const model of provider.models || []) {
      if (!model?.id) continue;
      const ref = `${providerKey}/${model.id}`;
      out.push({
        ref,
        providerKey,
        modelId: model.id,
        name: model.name || model.id,
        contextWindow: model.contextWindow || null,
        maxTokens: model.maxTokens || null,
        input: model.input || ['text'],
        reasoning: model.reasoning === true,
        cost: model.cost || null,
        local: String(provider.baseUrl || '').startsWith('http://127.0.0.1'),
        cloud: String(provider.baseUrl || '').startsWith('https://'),
      });
    }
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

function classifyUse(model) {
  const id = `${model.providerKey}/${model.modelId}`.toLowerCase();
  const ctx = Number(model.contextWindow || 0);
  const input = Array.isArray(model.input) ? model.input : [];
  const tags = [];
  if (input.includes('image')) tags.push('vision');
  if (/opus|sonnet|gemini.*pro|deepseek|kimi|glm|qwen|nemotron|ornith|grok|gpt|claude/.test(id) || model.reasoning) tags.push('reasoning');
  if (/qwen|coder|codex|deepseek|claude|gemini|kimi|glm/.test(id)) tags.push('code');
  if (/groq|cerebras|flash|lite|mini|nano|mercury|lfm/.test(id)) tags.push('speed');
  if (/higgsfield|comfy|flux|image|video|runway/.test(id) || input.includes('image')) tags.push('media');
  if (/nvidia|nemotron|ornith|local-|llama|qwen/.test(id)) tags.push('local-gpu');
  if (ctx >= 200000) tags.push('long-context');
  return [...new Set(tags.length ? tags : ['general'])];
}

function scoreModel(model) {
  const uses = classifyUse(model);
  const ctx = Math.min(Number(model.contextWindow || 0) / 1000, 1000);
  const localBoost = model.local ? 20 : 0;
  const reasoningBoost = uses.includes('reasoning') ? 30 : 0;
  const speedBoost = uses.includes('speed') ? 18 : 0;
  const mediaBoost = uses.includes('media') ? 14 : 0;
  return Math.round(ctx / 10 + localBoost + reasoningBoost + speedBoost + mediaBoost);
}

function benchmarkCatalog() {
  const { cfg, error } = readConfig();
  if (error) throw new Error('openclaw.json unreadable: ' + error);
  const rows = listProviderModels(cfg).map((model) => ({
    ...model,
    bestUse: classifyUse(model),
    zaitScore: scoreModel(model),
  })).sort((a, b) => b.zaitScore - a.zaitScore || a.ref.localeCompare(b.ref));
  const byRole = {
    chiefReasoning: rows.filter((m) => m.bestUse.includes('reasoning')).slice(0, 8).map((m) => m.ref),
    code: rows.filter((m) => m.bestUse.includes('code')).slice(0, 8).map((m) => m.ref),
    speed: rows.filter((m) => m.bestUse.includes('speed')).slice(0, 8).map((m) => m.ref),
    media: rows.filter((m) => m.bestUse.includes('media')).slice(0, 8).map((m) => m.ref),
    localGpu: rows.filter((m) => m.bestUse.includes('local-gpu')).slice(0, 8).map((m) => m.ref),
    longContext: rows.filter((m) => m.bestUse.includes('long-context')).slice(0, 8).map((m) => m.ref),
  };
  const result = { generatedAt: new Date().toISOString(), count: rows.length, byRole, models: rows };
  fs.mkdirSync(path.dirname(BENCHMARK_PATH), { recursive: true });
  fs.writeFileSync(BENCHMARK_PATH, JSON.stringify(result, null, 2));
  return result;
}

function ensureCompanyBrain({ mode = 'collective', selected = [] } = {}) {
  const { cfg, error } = readConfig();
  if (error) throw new Error('openclaw.json unreadable: ' + error);
  const bench = benchmarkCatalog();
  const defaults = [
    cfg.agents?.defaults?.model?.primary,
    ...(cfg.agents?.defaults?.model?.fallbacks || []),
    ...bench.byRole.chiefReasoning.slice(0, 4),
    ...bench.byRole.code.slice(0, 3),
    ...bench.byRole.speed.slice(0, 3),
    ...bench.byRole.media.slice(0, 3),
    ...bench.byRole.localGpu.slice(0, 4),
  ].filter(Boolean);
  const refs = [...new Set((selected.length ? selected : defaults).filter(Boolean))];
  cfg.agents = cfg.agents || {};
  cfg.agents.defaults = cfg.agents.defaults || {};
  const collectiveBrain = {
    ownerAgent: 'zait',
    mode,
    selectedModels: refs,
    manager: 'zait',
    workerPolicy: 'models-and-tools-are-underlings-not-agent-identities',
    swarmModes: ['collective', 'council', 'debate', 'swarm', 'specialist-fanout'],
    updatedAt: new Date().toISOString(),
  };
  cfg.plugins = cfg.plugins || {}; cfg.plugins.allow = cfg.plugins.allow || [];
  cfg.plugins.entries = cfg.plugins.entries || {};
  cfg.plugins.entries[COMPANY_BRAIN_PLUGIN_ID] = cfg.plugins.entries[COMPANY_BRAIN_PLUGIN_ID] || { enabled: true, config: {} };
  cfg.plugins.entries[COMPANY_BRAIN_PLUGIN_ID].config = cfg.plugins.entries[COMPANY_BRAIN_PLUGIN_ID].config || {};
  cfg.plugins.entries[COMPANY_BRAIN_PLUGIN_ID].config.collectiveBrain = collectiveBrain;
  for (const ref of refs) ensureAllow(cfg, ref);
  writeConfig(cfg);
  const manifest = { ...collectiveBrain, benchmarkPath: BENCHMARK_PATH, modelCount: bench.count };
  fs.mkdirSync(path.dirname(COMPANY_BRAIN_PATH), { recursive: true });
  fs.writeFileSync(COMPANY_BRAIN_PATH, JSON.stringify(manifest, null, 2));
  return manifest;
}

function ensureCloudProvider({ providerKey, baseUrl, modelId, name, apiKey = 'set-in-openclaw-config-or-env', contextWindow = 131072, input = ['text'], reasoning = true }) {
  providerKey = String(providerKey || '').trim();
  baseUrl = String(baseUrl || '').trim();
  modelId = String(modelId || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(providerKey)) throw new Error('bad providerKey');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('baseUrl must be http(s)');
  if (!modelId) throw new Error('modelId required');
  const { cfg, error } = readConfig();
  if (error) throw new Error('openclaw.json unreadable: ' + error);
  cfg.models = cfg.models || {}; cfg.models.providers = cfg.models.providers || {};
  const existing = cfg.models.providers[providerKey] || { api: 'openai-completions', apiKey, baseUrl, models: [] };
  existing.api = existing.api || 'openai-completions';
  existing.baseUrl = baseUrl;
  existing.apiKey = existing.apiKey || apiKey;
  const models = existing.models || [];
  const found = models.find((m) => m.id === modelId);
  const entry = { id: modelId, name: name || modelId, contextWindow: Number(contextWindow) || 131072, maxTokens: 8192, input, reasoning: !!reasoning };
  if (found) Object.assign(found, entry);
  else models.push(entry);
  existing.models = models;
  cfg.models.providers[providerKey] = existing;
  ensureAllow(cfg, `${providerKey}/${modelId}`);
  writeConfig(cfg);
  return { providerKey, ref: `${providerKey}/${modelId}` };
}

function ensureHuggingFaceModels({ models = [] } = {}) {
  const wanted = models.length ? models : [
    { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', name: 'Qwen3 Coder 480B A35B Instruct', contextWindow: 262144, best: 'code' },
    { id: 'deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2', contextWindow: 64000, best: 'reasoning' },
    { id: 'zai-org/GLM-4.5', name: 'GLM 4.5', contextWindow: 131072, best: 'reasoning' },
    { id: 'moonshotai/Kimi-K2-Instruct', name: 'Kimi K2 Instruct', contextWindow: 131072, best: 'long context reasoning' },
    { id: 'nvidia/Nemotron-3-Nano-30B-A3B', name: 'NVIDIA Nemotron 3 Nano 30B A3B', contextWindow: 131072, best: 'local/cloud NVIDIA worker' },
  ];
  const refs = [];
  for (const model of wanted) {
    refs.push(ensureCloudProvider({
      providerKey: 'huggingface',
      baseUrl: 'https://api-inference.huggingface.co/v1',
      modelId: model.id,
      name: `${model.name} (HF - ${model.best})`,
      contextWindow: model.contextWindow,
      apiKey: 'env:HUGGINGFACE_API_KEY',
      reasoning: true,
    }).ref);
  }
  return { providerKey: 'huggingface', refs };
}

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

function rollbackUpdate({ slot } = {}) {
  const slots = listUpdateSlots();
  const chosen = slot ? slots.find((s) => s.slot === slot || path.basename(s.slot) === slot) : slots[0];
  if (!chosen) throw new Error('no rollback slot available');
  const restore = [
    ['openclaw.json', OPENCLAW_JSON],
    ['ABUZ8_UPSTREAM.json', path.join(PRODUCT_ROOT, 'ABUZ8_UPSTREAM.json')],
    ['LEDGER_LOG.md', path.join(PRODUCT_ROOT, 'LEDGER_LOG.md')],
    ['abuz8-models.cjs', path.join(__dirname, 'abuz8-models.cjs')],
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

function applyUpdate({ channel = 'stable', restart = true, dryRun = false } = {}) {
  const allowed = new Set(['stable', 'extended-stable', 'beta', 'dev']);
  channel = String(channel || 'stable');
  if (!allowed.has(channel)) throw new Error('bad update channel');
  const snapshot = snapshotUpdate({ label: `pre-update-${channel}` });
  fs.mkdirSync(path.dirname(UPDATE_LOG), { recursive: true });
  fs.appendFileSync(UPDATE_LOG, `\n[${new Date().toISOString()}] requested channel=${channel} dryRun=${!!dryRun} restart=${!!restart} snapshot=${snapshot.slot}\n`);
  if (dryRun) return { ok: true, dryRun: true, snapshot: snapshot.slot, log: UPDATE_LOG };
  const args = [path.join(__dirname, 'openclaw.mjs'), 'update', '--channel', channel];
  if (restart) args.push('--restart-gateway');
  const fd = fs.openSync(UPDATE_LOG, 'a');
  const child = spawn(process.env.OPENCLAW_NODE_EXE || 'node.exe', args, {
    cwd: __dirname,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, OPENCLAW_CONFIG_PATH: OPENCLAW_JSON },
  });
  child.unref && child.unref();
  return { ok: true, started: true, pid: child.pid, channel, snapshot: snapshot.slot, log: UPDATE_LOG };
}

function updateState() {
  let logTail = '';
  try { logTail = fs.readFileSync(UPDATE_LOG, 'utf8').split(/\r?\n/).slice(-60).join('\n'); } catch {}
  return { channel: readConfig().cfg?.update?.channel || 'stable', slots: listUpdateSlots(), productRoot: PRODUCT_ROOT, log: UPDATE_LOG, logTail };
}

async function state() {
  const disk = scanDisk();
  const models = disk.models || [];
  const live = await liveMap(models);
  const { cfg, error: cfgError } = readConfig();
  let brains = readBrains();
  const prov = (cfg && cfg.models && cfg.models.providers) || {};
  // Studio sidecars (not GGUF-panel models but part of the body)
  const side = {};
  await Promise.all([8188, 8012, VOICE_PORT, 8011, 8790].map(async (p) => {
    const r = await getJson(`http://127.0.0.1:${p}/` + (p === 8188 ? 'system_stats' : p === VOICE_PORT ? 'health' : p === 8790 ? 'health' : 'v1/models'), 2500);
    side[p] = !!(r && r.status === 200);
  }));
  const def = (cfg && cfg.agents && cfg.agents.defaults) || {};
  return {
    models: models.map((m) => ({
      ...m,
      running: !!(live[m.port] && live[m.port].up),
      runningIds: (live[m.port] && live[m.port].ids) || [],
      providerKey: providerKeyFor(m.alias),
      managed: children.has(m.port),
    })),
    ports: live,
    primary: (def.model && def.model.primary) || null,
    fallbacks: (def.model && def.model.fallbacks) || [],
    operator: findAgentModel(cfg, 'operator'),
    auditor: findAgentModel(cfg, 'auditor'),
    imageModel: (def.imageModel) || (def.model && def.model.imageModel) || (def.image && def.image.model) || null,
    providers: Object.keys(prov),
    providerModels: cfg ? listProviderModels(cfg).map((m) => ({ ...m, bestUse: classifyUse(m), zaitScore: scoreModel(m) })).sort((a, b) => b.zaitScore - a.zaitScore) : [],
    collectiveBrain: cfg?.plugins?.entries?.[COMPANY_BRAIN_PLUGIN_ID]?.config?.collectiveBrain || null,
    studio: { comfy: side[8188], vision: side[8012], voice: side[VOICE_PORT], thinker: side[8011], hands: side[8790] },
    cfgError, scannedAt: new Date().toISOString(),
    modelsRoot: MODELS_ROOT,
    modelFolders: readFolderList(),
    lowRam: readPanelPrefs().lowRam,
    onboardingComplete: readPanelPrefs().onboardingComplete,
    eModelsCompat: E_MODELS_PRESENT,
    engine: { present: fs.existsSync(RUNTIME), path: RUNTIME },
    sidecars: readSidecars(),
    brainsScannedAt: brains ? brains.scannedAt : null,
  };
}

// Sidecar status written by the body (electron-main) into home\sidecars.json.
// Lets the panel show "not installed — here is why" instead of a bare red dot.
function readSidecars() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'sidecars.json'), 'utf8')); }
  catch { return null; }
}

function logPath(alias) { return path.join(STATE_DIR, `model-${alias}.log`); }

// 2026-09-11 (low-RAM device profile): a persisted panel preference. When on,
// every panel-started model runs with a tiny footprint: ctx 2048, one slot,
// 4 threads, no warmup — sized for 4 GB RAM / no-GPU devices (Surface Pro 3
// class). Voice + tiny GGUFs still fit; big models simply refuse to be sane
// there and the panel says so instead of pretending.
const PANEL_PREFS = path.join(OPC1_ROOT, 'panel-prefs.json');
function readPanelPrefs() {
  try {
    const j = JSON.parse(fs.readFileSync(PANEL_PREFS, 'utf8'));
    return { lowRam: !!j.lowRam, onboardingComplete: !!j.onboardingComplete };
  } catch { return { lowRam: false, onboardingComplete: false }; }
}
function writePanelPrefs(p) {
  const cur = readPanelPrefs();
  const next = { ...cur, ...p };
  fs.mkdirSync(path.dirname(PANEL_PREFS), { recursive: true });
  fs.writeFileSync(PANEL_PREFS, JSON.stringify(next, null, 2));
  return next;
}

async function startModel({ alias, port, ctx, gpu, lowRam }) {
  const disk = scanDisk();
  const m = (disk.models || []).find((x) => x.alias === alias);
  if (!m) throw new Error('model not on disk: ' + alias);
  port = Number(port || m.port);
  if (await portOpen(port)) throw new Error(`port ${port} already busy — that model is already running`);
  if (!fs.existsSync(RUNTIME)) throw new Error('bundled llama engine missing (' + RUNTIME + ') — the Zait OPC-1 install is incomplete; reinstall or run installer repair');
  const EXE = RUNTIME;
  const LOW_RAM = lowRam === true || (lowRam == null && readPanelPrefs().lowRam);

  // Fixed brains keep their canonical launchers (exact flags Ahmad settled).
  if (m.starter === 'ps1-nemotron' || m.starter === 'ps1-ornith') {
    const ps1 = m.starter === 'ps1-nemotron'
      ? path.join(OPC1_ROOT, 'body', 'ops', 'start_brain_nemotron.ps1')
      : path.join(OPC1_ROOT, 'body', 'ops', 'start_brain_ornith.ps1');
    const ps1fb = m.starter === 'ps1-nemotron'
      ? 'E:/ABU/ops/start_brain_nemotron.ps1'
      : 'E:/ABU/ops/start_brain_ornith.ps1';
    const launch = fs.existsSync(ps1) ? ps1 : ps1fb;
    const c = spawn('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launch],
      { windowsHide: true, detached: false, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref && c.unref();
    return { started: alias, via: launch, port };
  }

  const args = ['-m', m.path, '--host', '127.0.0.1', '--port', String(port),
    '-c', String(LOW_RAM ? Math.min(Number(ctx) || 2048, 2048) : (Number(ctx) || 32768)),
    '--parallel', LOW_RAM ? '1' : '2',
    '-ngl', '999', '--flash-attn', 'on', '--alias', m.alias, '--jinja', '--metrics'];
  if (LOW_RAM) args.push('--threads', '4', '--no-warmup');
  if (m.mmproj && (m.kind === 'vision' || m.visionCapable)) args.push('--mmproj', m.mmproj);
  if (m.kind === 'embed') args.push('--embeddings', '--pooling', 'mean');
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  const fd = fs.openSync(logPath(m.alias), 'a');
  fs.appendFileSync(logPath(m.alias), `\n[panel] start ${m.alias} :${port} ctx=${LOW_RAM ? Math.min(Number(ctx) || 2048, 2048) : (Number(ctx) || 32768)}${LOW_RAM ? ' LOW-RAM(1 slot,4 threads,no-warmup)' : ''} gpu=${gpu || 'both'} at ${new Date().toISOString()}\n`);
  const env = { ...process.env };
  // Ahmad 2026-09-03: switchable models default to GPU 0. Fixed brains keep their own launchers.
  if (gpu === '1') env.CUDA_VISIBLE_DEVICES = '1';
  else if (gpu === 'both') delete env.CUDA_VISIBLE_DEVICES;
  else env.CUDA_VISIBLE_DEVICES = '0';
  const c = spawn(EXE, args, { windowsHide: true, detached: false, stdio: ['ignore', fd, fd], env });
  children.set(port, c);
  c.on('error', (e) => { try { fs.appendFileSync(logPath(m.alias), `[panel] spawn error: ${e.message}\n`); } catch {} });
  c.on('exit', (code) => {
    children.delete(port);
    try { fs.appendFileSync(logPath(m.alias), `[panel] exited code=${code}\n`); } catch {}
  });
  return { started: alias, port, pid: c.pid };
}

async function stopModel({ port }) {
  port = Number(port);
  const c = children.get(port);
  if (c) {
    try { c.kill(); } catch {}
    children.delete(port);
    // belt + suspenders: make sure the port actually frees
    await new Promise((r) => setTimeout(r, 1500));
    if (await portOpen(port)) killPortOwner(port);
    return { stopped: port, via: 'child' };
  }
  // Not our child (started by ps1 / older session): kill the port owner.
  const ok = killPortOwner(port);
  return { stopped: port, via: 'port-owner', ok };
}

function killPortOwner(port) {
  try {
    const find = spawn('pwsh.exe', ['-NoProfile', '-Command',
      `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; 'killed:' + $c.OwningProcess } else { 'nobody' }`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
}

function ensureProvider(alias, port, kind) {
  const { cfg, error } = readConfig();
  if (error) throw new Error('openclaw.json unreadable: ' + error);
  cfg.models = cfg.models || {}; cfg.models.providers = cfg.models.providers || {};
  const key = providerKeyFor(alias);
  const isVision = kind === 'vision';
  const isEmbed = kind === 'embed';
  const existing = cfg.models.providers[key];
  const existingModel = existing && (existing.models || []).find((m) => {
    const id = String(m.id || '');
    return id === alias || id.startsWith(alias) || alias.startsWith(id);
  });
  if (existing && existingModel) {
    // Preserve hand-tuned compat/reasoning/cost metadata when binding an
    // already-known provider; only normalize the model id used by the panel.
    existingModel.id = alias;
    existingModel.name = existingModel.name || `${alias} (local :${port})`;
  } else {
    cfg.models.providers[key] = {
      api: 'openai-completions',
      apiKey: 'local',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      models: [{
        id: alias,
        name: `${alias} (local :${port})`,
        contextWindow: isEmbed ? 2048 : 32768,
        maxTokens: isEmbed ? 512 : 8192,
        input: isVision ? ['text', 'image'] : isEmbed ? ['text'] : ['text'],
      }],
    };
  }
  ensureAllow(cfg, `${key}/${alias}`);
  fs.writeFileSync(OPENCLAW_JSON, JSON.stringify(cfg, null, 2));
  return key;
}

function setPrimary({ role, ref }) {
  // role: default | operator | auditor | image ; ref: "provider/model"
  // 2026.9.1 canonical: agents.entries.<id>.model + agents.defaults.imageModel
  const { cfg, error } = readConfig();
  if (error) throw new Error('openclaw.json unreadable: ' + error);
  cfg.agents = cfg.agents || {}; cfg.agents.defaults = cfg.agents.defaults || {};
  cfg.agents.defaults.model = cfg.agents.defaults.model || {};
  cfg.agents.entries = cfg.agents.entries || {};
  const setEntry = (id) => {
    cfg.agents.entries[id] = cfg.agents.entries[id] || {};
    cfg.agents.entries[id].model = cfg.agents.entries[id].model || {};
    cfg.agents.entries[id].model.primary = ref;
  };
  if (role === 'default') cfg.agents.defaults.model.primary = ref;
  else if (role === 'operator') setEntry('operator');
  else if (role === 'auditor') setEntry('auditor');
  else if (role === 'image') {
    cfg.agents.defaults.imageModel = { primary: ref, fallbacks: [] };
    cfg.agents.defaults.model.imageModel = undefined;
  }
  else throw new Error('unknown role: ' + role);
  ensureAllow(cfg, ref);
  // keep fallbacks sane: ensure primary's siblings stay as fallbacks
  const fb = cfg.agents.defaults.model.fallbacks || [];
  if (!fb.includes(ref) && role !== 'image') {
    const [pk] = ref.split('/');
    if (/^local-|nemotron|ornith|vision/i.test(pk)) { fb.push(ref); cfg.agents.defaults.model.fallbacks = fb.slice(-12); }
  }
  fs.writeFileSync(OPENCLAW_JSON, JSON.stringify(cfg, null, 2));
  return { role, ref };
}

function tailLog(file, n = 60) {
  const allowed = listLogs();
  if (!allowed.includes(file)) throw new Error('log not allowed: ' + file);
  // Launchers write brain logs under the sovereign home logs room. Keep the
  // body/ops and E: locations as read-only fallbacks for older runs.
  const OPS_DIR = path.join(OPC1_ROOT, 'body', 'ops');
  const candidates = file.startsWith('brain_')
    ? [path.join(STATE_DIR, 'logs', file), path.join(STATE_DIR, file), path.join(OPS_DIR, file), path.join('E:\\ABU\\ops', file)]
    : [path.join(STATE_DIR, file)];
  const p = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
  try {
    const data = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    return data.slice(-n).join('\n');
  } catch (e) { return '(unreadable: ' + e.message + ')'; }
}

function listLogs() {
  const files = new Set();
  const logPattern = /^(model-.*|embedder|vision|voice|comfy|brain_.*)\.log$/;
  for (const dir of [STATE_DIR, path.join(STATE_DIR, 'logs')]) {
    try {
      for (const file of fs.readdirSync(dir)) if (logPattern.test(file)) files.add(file);
    } catch {}
  }
  // Keep the standard names visible even before their first launch.
  for (const file of ['brain_nemotron.log', 'brain_nemotron.err.log', 'brain_ornith.log', 'brain_ornith.err.log']) files.add(file);
  return [...files];
}

// ── Hugging Face GGUF catalog + download (2026-09-10 installer lane) ────────
// Search HF, list a repo's .gguf files with sizes, and download one into
// MODELS_ROOT with resume (Range header). Public repos need no token; a token
// is honored when present via env. Downloaded files land in a per-repo subdir
// so the existing scanDisk catalog picks them up automatically.
const https = require('node:https');
const HF_TOKEN = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || null;
function hfHeaders(extra = {}) {
  const h = { 'User-Agent': 'zait-opc1/1.1', ...extra };
  if (HF_TOKEN) h.Authorization = 'Bearer ' + HF_TOKEN;
  return h;
}
function hfGetJson(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: hfHeaders() }, (res) => {
      let b = '';
      res.on('data', (d) => { if (b.length < 2000000) b += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { reject(new Error('bad json from huggingface.co (status ' + res.statusCode + ')')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('huggingface.co timeout')); });
  });
}
async function hfSearch({ q } = {}) {
  q = String(q || '').trim();
  if (!q) return { results: [] };
  const r = await hfGetJson(`https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&limit=20`);
  const rows = (Array.isArray(r.json) ? r.json : []).map((m) => ({ repo: m.id, downloads: m.downloads || 0, likes: m.likes || 0, lastModified: m.lastModified || null }));
  return { results: rows };
}
async function hfFiles({ repo } = {}) {
  repo = String(repo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('bad repo: ' + repo);
  const r = await hfGetJson(`https://huggingface.co/api/models/${repo}`);
  if (!r.json) throw new Error('repo lookup failed (status ' + r.status + ')');
  const files = (r.json.siblings || []).map((s) => s.rfilename).filter((f) => /\.gguf$/i.test(f));
  let sizes = {};
  try {
    const t = await hfGetJson(`https://huggingface.co/api/models/${repo}/tree/main`);
    if (Array.isArray(t.json)) for (const n of t.json) if (n.path && n.size) sizes[n.path] = n.size;
  } catch {}
  return { repo, files: files.map((f) => ({ file: f, size: sizes[f] || null, mb: sizes[f] ? Math.round(sizes[f] / 1048576) : null })) };
}

const downloads = new Map(); // "repo/file" -> progress record (in-memory)
function hfStream(url, offset, redirectsLeft, cb) {
  const headers = hfHeaders(offset > 0 ? { Range: `bytes=${offset}-` } : {});
  let req;
  try {
    req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        // 2026-09-11: HF sometimes redirects to a RELATIVE path
        // (/api/resolve-cache/...) — resolve against the request URL or
        // https.get throws ERR_INVALID_URL and kills the panel (proven).
        let next;
        try { next = new URL(res.headers.location, url).toString(); }
        catch (e) { return cb(e); }
        return hfStream(next, offset, redirectsLeft - 1, cb);
      }
      cb(null, res);
    });
  } catch (e) { return cb(e); }
  req.on('error', (e) => cb(e));
}
function hfDownload({ repo, file } = {}) {
  repo = String(repo || '').trim();
  file = String(file || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('bad repo');
  if (!/^[\w.@+-]+\.gguf$/i.test(file)) throw new Error('bad file (must be a plain .gguf filename)');
  const key = `${repo}/${file}`;
  const existing = downloads.get(key);
  if (existing && existing.status === 'downloading') return existing;
  const dir = path.join(MODELS_ROOT, repo.replace(/[^\w.-]+/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file);
  let offset = 0;
  try { offset = fs.existsSync(dest) ? fs.statSync(dest).size : 0; } catch {}
  const rec = { repo, file, path: dest, total: 0, done: offset, status: 'downloading', error: null, startedAt: new Date().toISOString(), finishedAt: null };
  downloads.set(key, rec);
  hfStream(`https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`, offset, 5, (err, res) => {
    if (err) { rec.status = 'error'; rec.error = err.message; rec.finishedAt = new Date().toISOString(); return; }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      rec.status = 'error'; rec.error = 'HTTP ' + res.statusCode; rec.finishedAt = new Date().toISOString();
      res.resume(); return;
    }
    if (res.statusCode === 200 && offset > 0) { try { fs.truncateSync(dest, 0); } catch {} offset = 0; rec.done = 0; } // server ignored Range — restart clean
    const len = Number(res.headers['content-length'] || 0);
    rec.total = offset + len;
    const out = fs.createWriteStream(dest, { flags: offset > 0 ? 'a' : 'w' });
    res.on('data', (d) => { rec.done += d.length; });
    res.on('error', (e) => { rec.status = 'error'; rec.error = e.message; rec.finishedAt = new Date().toISOString(); out.destroy(); });
    out.on('error', (e) => { rec.status = 'error'; rec.error = e.message; rec.finishedAt = new Date().toISOString(); });
    out.on('finish', () => { if (rec.status === 'downloading') { rec.status = 'done'; rec.finishedAt = new Date().toISOString(); } });
    res.pipe(out);
  });
  return rec;
}
function hfDownloads() {
  return { downloads: [...downloads.values()].sort((a, b) => String(b.startedAt).localeCompare(a.startedAt)) };
}

// ── Voice lane (2026-09-11): one-click voice pack + weights ────────────────
// Goal: a bare PC opens OPC-1 and can TALK and HEAR — no Python, no terminal.
// Two ingredients, both installed from this panel with progress:
//   1. voice PACK  — PyInstaller onedir (abuz8-voice.exe, ~125 MB, zip ~55 MB)
//      lands at <OPC1_ROOT>\runtime\voice\dist\abuz8-voice\ — electron-main's
//      voiceRuntime() already prefers it automatically.
//   2. voice WEIGHTS — Kokoro TTS (ONNX, ~350 MB) + Parakeet ASR (int8, ~670 MB),
//      each under 1 GB, straight from public Hugging Face repos into MODELS_ROOT.
// The pack zip comes from (first hit wins): POST body.localPath, a zip already
// sitting in MODELS_ROOT or the user's Downloads folder, voice-pack.json next to
// this file ({"url": ...}), or OPC1_VOICE_PACK_URL. If none exists the lane says
// so HONESTLY instead of pretending.
const VOICE_DIR = path.join(OPC1_ROOT, 'runtime', 'voice');
const VOICE_PACK_EXE = path.join(VOICE_DIR, 'dist', 'abuz8-voice', 'abuz8-voice.exe');
const VOICE_PORT = Number(process.env.OPC1_VOICE_PORT || 8094);
const KOKORO_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const PARAKEET_REPO = 'istupakov/parakeet-tdt-0.6b-v3-onnx';
const PARAKEET_FILES = ['config.json', 'vocab.txt', 'nemo128.onnx', 'encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx'];

function dirBytes(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      try { if (e.isFile()) total += fs.statSync(path.join(e.parentPath || e.path || dir, e.name)).size; } catch {}
    }
  } catch {}
  return total;
}

function voicePackUrl() {
  if (process.env.OPC1_VOICE_PACK_URL) return process.env.OPC1_VOICE_PACK_URL;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'voice-pack.json'), 'utf8'));
    if (j && j.url) return j.url;
  } catch {}
  return null;
}

function findLocalVoicePackZip() {
  const cands = [];
  try { for (const f of fs.readdirSync(MODELS_ROOT)) if (/^abuz8-voice-pack.*\.zip$/i.test(f)) cands.push(path.join(MODELS_ROOT, f)); } catch {}
  try { const dl = path.join(os.homedir(), 'Downloads'); for (const f of fs.readdirSync(dl)) if (/^abuz8-voice-pack.*\.zip$/i.test(f)) cands.push(path.join(dl, f)); } catch {}
  return cands[0] || null;
}

function voiceLaneActive() {
  return [...downloads.values()].some((d) => d.lane === 'voice' && (d.status === 'downloading' || d.status === 'extracting' || d.status === 'queued'));
}

async function voiceState() {
  const kokoroDir = path.join(MODELS_ROOT, 'Kokoro');
  const parakeetDir = path.join(MODELS_ROOT, 'parakeet-tdt-0.6b-v3');
  let kokoroVoices = 0;
  try { kokoroVoices = fs.readdirSync(path.join(kokoroDir, 'voices')).filter((f) => f.endsWith('.bin')).length; } catch {}
  const health = await getJson(`http://127.0.0.1:${VOICE_PORT}/health`, 1500);
  return {
    pack: { installed: fs.existsSync(VOICE_PACK_EXE), path: VOICE_PACK_EXE, mb: fs.existsSync(VOICE_PACK_EXE) ? Math.round(dirBytes(path.dirname(VOICE_PACK_EXE)) / 1048576) : 0, sourceUrl: voicePackUrl(), localZip: findLocalVoicePackZip() },
    kokoro: { installed: fs.existsSync(path.join(kokoroDir, 'onnx', 'model.onnx')) && kokoroVoices > 0, dir: kokoroDir, voices: kokoroVoices, mb: Math.round(dirBytes(kokoroDir) / 1048576), repo: KOKORO_REPO },
    parakeet: { installed: PARAKEET_FILES.every((f) => fs.existsSync(path.join(parakeetDir, f))), dir: parakeetDir, mb: Math.round(dirBytes(parakeetDir) / 1048576), repo: PARAKEET_REPO, files: PARAKEET_FILES },
    server: { up: !!(health && health.status === 200), health: health && health.json ? health.json : null, port: VOICE_PORT },
    busy: voiceLaneActive(),
    downloads: [...downloads.values()].filter((d) => d.lane === 'voice').sort((a, b) => String(b.startedAt).localeCompare(a.startedAt)),
  };
}

// Generic resumable URL → file download with a progress record (same shape as
// hfDownload so the panel renders one list). Subdirs in dest are created.
function urlDownload({ key, url, dest, lane }) {
  const existing = downloads.get(key);
  if (existing && (existing.status === 'downloading' || existing.status === 'queued')) return existing;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let offset = 0;
  try { offset = fs.existsSync(dest) ? fs.statSync(dest).size : 0; } catch {}
  const rec = { key, url, path: dest, lane: lane || 'hf', total: 0, done: offset, status: 'downloading', error: null, startedAt: new Date().toISOString(), finishedAt: null };
  downloads.set(key, rec);
  hfStream(url, offset, 5, (err, res) => {
    if (err) { rec.status = 'error'; rec.error = err.message; rec.finishedAt = new Date().toISOString(); return; }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      rec.status = 'error'; rec.error = 'HTTP ' + res.statusCode; rec.finishedAt = new Date().toISOString();
      res.resume(); return;
    }
    if (res.statusCode === 200 && offset > 0) { try { fs.truncateSync(dest, 0); } catch {} offset = 0; rec.done = 0; }
    const len = Number(res.headers['content-length'] || 0);
    rec.total = offset + len;
    const out = fs.createWriteStream(dest, { flags: offset > 0 ? 'a' : 'w' });
    res.on('data', (d) => { rec.done += d.length; });
    res.on('error', (e) => { rec.status = 'error'; rec.error = e.message; rec.finishedAt = new Date().toISOString(); out.destroy(); });
    out.on('error', (e) => { rec.status = 'error'; rec.error = e.message; rec.finishedAt = new Date().toISOString(); });
    out.on('finish', () => { if (rec.status === 'downloading') { rec.status = 'done'; rec.finishedAt = new Date().toISOString(); } });
    res.pipe(out);
  });
  return rec;
}

function extractVoicePack(zipPath, rec, onDone) {
  const dest = path.join(VOICE_DIR, 'dist');
  fs.mkdirSync(dest, { recursive: true });
  rec.status = 'extracting';
  const finish = (ok, err) => {
    if (ok && fs.existsSync(VOICE_PACK_EXE)) {
      rec.status = 'done'; rec.finishedAt = new Date().toISOString();
      try { fs.unlinkSync(zipPath); } catch {}
      onDone && onDone(null);
    } else {
      rec.status = 'error'; rec.error = err || 'extraction finished but abuz8-voice.exe is missing'; rec.finishedAt = new Date().toISOString();
      onDone && onDone(new Error(rec.error));
    }
  };
  // Windows 10+ ships bsdtar as C:\Windows\System32\tar.exe — handles zip fine.
  // PowerShell Expand-Archive is the fallback. Resolve BOTH by absolute path
  // first: a child process does not always inherit a usable PATH (proven:
  // spawn tar.exe → ENOENT from a Git Bash-launched panel, 2026-09-11).
  const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const esc = (s) => s.replace(/'/g, "''");
  const psExe = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const candidates = [
    { cmd: path.join(SYS32, 'tar.exe'), args: ['-xf', zipPath, '-C', dest] },
    { cmd: 'tar.exe', args: ['-xf', zipPath, '-C', dest] },
    { cmd: psExe, args: ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${esc(zipPath)}' -DestinationPath '${esc(dest)}' -Force`] },
    { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${esc(zipPath)}' -DestinationPath '${esc(dest)}' -Force`] },
  ];
  const errors = [];
  const attempt = (i) => {
    if (i >= candidates.length) return finish(false, 'no extractor worked: ' + errors.join(' | '));
    const cnd = candidates[i];
    if (cnd.cmd.includes('\\') && !fs.existsSync(cnd.cmd)) { errors.push(cnd.cmd + ' missing'); return attempt(i + 1); }
    let settled = false;
    let c;
    try { c = spawn(cnd.cmd, cnd.args, { windowsHide: true, stdio: 'ignore' }); }
    catch (e) { errors.push(cnd.cmd + ' ' + e.message); return attempt(i + 1); }
    c.on('error', (e) => { if (settled) return; settled = true; errors.push(cnd.cmd + ' ' + e.message); attempt(i + 1); });
    c.on('exit', (code) => { if (settled) return; settled = true; if (code === 0) finish(true); else { errors.push(cnd.cmd + ' exit ' + code); attempt(i + 1); } });
  };
  attempt(0);
}

// Sequentially download a list of {repo, file, dest} — one at a time, resumable.
function queueWeightFiles(list, lane, onAllDone) {
  const step = (i) => {
    if (i >= list.length) return onAllDone && onAllDone(null);
    const it = list[i];
    const rec = urlDownload({ key: `${lane}:${it.repo}/${it.file}`, url: `https://huggingface.co/${it.repo}/resolve/main/${it.file.split('/').map(encodeURIComponent).join('/')}`, dest: it.dest, lane });
    if (rec.status === 'done') return step(i + 1);
    const poll = setInterval(() => {
      if (rec.status === 'done') { clearInterval(poll); step(i + 1); }
      else if (rec.status === 'error') { clearInterval(poll); onAllDone && onAllDone(new Error(`${it.file}: ${rec.error}`)); }
    }, 1000);
  };
  step(0);
}

async function voiceInstall({ what = 'all', url, localPath } = {}, { onVoiceInstalled } = {}) {
  if (!['pack', 'kokoro', 'parakeet', 'all'].includes(what)) throw new Error('bad voice install target: ' + what);
  if (voiceLaneActive()) return { started: false, reason: 'a voice install is already running', state: await voiceState() };
  const jobs = what === 'all' ? ['pack', 'kokoro', 'parakeet'] : [what];

  if (jobs.includes('pack')) {
    const src = localPath || findLocalVoicePackZip();
    const remote = url || voicePackUrl();
    if (!src && !remote) {
      throw new Error('no voice pack source: drop abuz8-voice-pack-*.zip into ' + MODELS_ROOT + ' (or your Downloads folder), pass {url} or {localPath}, set OPC1_VOICE_PACK_URL, or pin resources\\app\\voice-pack.json');
    }
    const rec = { key: 'voice:pack', url: remote || src, path: VOICE_PACK_EXE, lane: 'voice', total: 0, done: 0, status: 'queued', error: null, startedAt: new Date().toISOString(), finishedAt: null };
    downloads.set(rec.key, rec);
    const zipDest = path.join(VOICE_DIR, 'dist', 'abuz8-voice-pack-download.zip');
    if (src) {
      rec.status = 'extracting';
      try { fs.mkdirSync(path.dirname(zipDest), { recursive: true }); fs.copyFileSync(src, zipDest); } catch (e) { rec.status = 'error'; rec.error = e.message; throw e; }
      extractVoicePack(zipDest, rec, (err) => { if (!err && onVoiceInstalled) onVoiceInstalled(); });
    } else {
      const dl = urlDownload({ key: 'voice:pack-zip', url: remote, dest: zipDest, lane: 'voice' });
      rec.status = 'downloading';
      const poll = setInterval(() => {
        rec.done = dl.done; rec.total = dl.total;
        if (dl.status === 'done') { clearInterval(poll); extractVoicePack(zipDest, rec, (err) => { if (!err && onVoiceInstalled) onVoiceInstalled(); }); }
        else if (dl.status === 'error') { clearInterval(poll); rec.status = 'error'; rec.error = dl.error; rec.finishedAt = new Date().toISOString(); }
      }, 1000);
    }
  }

  if (jobs.includes('kokoro')) {
    const dir = path.join(MODELS_ROOT, 'Kokoro');
    const t = await hfGetJson(`https://huggingface.co/api/models/${KOKORO_REPO}/tree/main?recursive=true`);
    const names = (Array.isArray(t.json) ? t.json : []).map((n) => n.path).filter((p) =>
      p === 'config.json' || p === 'tokenizer.json' || p === 'tokenizer_config.json' || p === 'onnx/model.onnx' || /^voices\/[\w.-]+\.bin$/.test(p));
    if (!names.length) throw new Error('could not list ' + KOKORO_REPO + ' files (network?)');
    queueWeightFiles(names.map((f) => ({ repo: KOKORO_REPO, file: f, dest: path.join(dir, f) })), 'voice');
  }

  if (jobs.includes('parakeet')) {
    const dir = path.join(MODELS_ROOT, 'parakeet-tdt-0.6b-v3');
    queueWeightFiles(PARAKEET_FILES.map((f) => ({ repo: PARAKEET_REPO, file: f, dest: path.join(dir, f) })), 'voice');
  }

  return { started: true, jobs, state: await voiceState() };
}

// ── Benchmark RUN lane (2026-09-10 installer) ───────────────────────────────
// Measures real tok/s against the RUNNING model server (fixed 128-token
// completion) and appends the run to home\kernel\model_benchmarks.json under
// a `runs` array, preserving whatever shape is already there.
function benchPost(port, body, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/completions', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout }, (res) => {
      let b = '';
      res.on('data', (d) => { if (b.length < 500000) b += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { reject(new Error('bad json from model server (status ' + res.statusCode + ')')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('model server timeout')); });
    req.end(JSON.stringify(body));
  });
}
async function benchmarkRun({ alias } = {}) {
  alias = String(alias || '').trim();
  if (!alias) throw new Error('alias required');
  const disk = scanDisk();
  const m = (disk.models || []).find((x) => x.alias === alias);
  if (!m) throw new Error('model not on disk: ' + alias);
  if (!(await portOpen(m.port))) { const e = new Error('start the model first'); e.statusCode = 409; throw e; }
  const t0 = Date.now();
  const r = await benchPost(m.port, { model: m.alias, prompt: 'Write a short story about a robot learning to paint. '.repeat(8), max_tokens: 128, temperature: 0 });
  const ms = Date.now() - t0;
  if (!r.json || r.status !== 200) throw new Error('completion failed (status ' + r.status + ')');
  const usage = r.json.usage || {};
  const completionTokens = Number(usage.completion_tokens || 0);
  const tokPerS = completionTokens > 0 ? Math.round((completionTokens / (ms / 1000)) * 100) / 100 : null;
  const row = { ts: new Date().toISOString(), alias, tok_per_s: tokPerS, prompt_tokens: usage.prompt_tokens ?? null, completion_tokens: completionTokens || null, ms };
  fs.mkdirSync(path.dirname(BENCHMARK_PATH), { recursive: true });
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(BENCHMARK_PATH, 'utf8')); } catch {}
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    existing.runs = Array.isArray(existing.runs) ? existing.runs : [];
    existing.runs.push(row);
    existing.runs = existing.runs.slice(-200);
    fs.writeFileSync(BENCHMARK_PATH, JSON.stringify(existing, null, 2));
  } else {
    fs.writeFileSync(BENCHMARK_PATH, JSON.stringify({ runs: [row] }, null, 2));
  }
  return row;
}

// ── Media-health lane (2026-09-10 installer) ────────────────────────────────
// All probes loopback-only, 1.5s each. GPU failure is reported HONESTLY
// (nvidia-smi error text), never silently treated as zero VRAM.
async function mediaHealth() {
  const probe = async (port, p) => {
    const r = await getJson(`http://127.0.0.1:${port}${p}`, 1500);
    return { ok: !!(r && r.status === 200), status: r ? r.status : null };
  };
  const ffmpeg = await new Promise((resolve) => {
    let out = '';
    let c;
    try { c = spawn('ffmpeg', ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { return resolve({ found: false, error: e.message }); }
    const to = setTimeout(() => { try { c.kill(); } catch {} resolve({ found: false, error: 'timeout' }); }, 5000);
    c.stdout.on('data', (d) => { if (out.length < 4000) out += d; });
    c.on('error', (e) => { clearTimeout(to); resolve({ found: false, error: e.message }); });
    c.on('exit', (code) => {
      clearTimeout(to);
      if (code !== 0) return resolve({ found: false, error: 'exit ' + code });
      const mm = /ffmpeg version (\S+)/i.exec(out);
      resolve({ found: true, version: mm ? mm[1] : 'unknown' });
    });
  });
  const [comfy, vision, voice, hands, gpu] = await Promise.all([
    probe(8188, '/system_stats'), probe(8012, '/v1/models'), probe(VOICE_PORT, '/health'), probe(8790, '/health'), vramSnapshot(),
  ]);
  return {
    at: new Date().toISOString(),
    comfy, vision, voice, hands, ffmpeg,
    gpu: gpu.ok ? { ok: true, gpus: gpu.gpus } : { ok: false, error: gpu.error || 'nvidia-smi unavailable' },
  };
}

// ── HTTP server (loopback only) ──────────────────────────────────────────────
function send(res, code, obj, type = 'application/json') {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function startPanelServer({ onRestartGateway, onDiscover, onStudio, onVoiceInstalled, onOnboardingComplete } = {}) {
  const htmlPath = path.join(__dirname, 'abuz8-models.html');
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
        try { send(res, 200, fs.readFileSync(htmlPath, 'utf8'), 'text/html; charset=utf-8'); }
        catch { send(res, 500, { error: 'panel html missing' }); }
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/state') { send(res, 200, await state()); return; }
      if (req.method === 'GET' && u.pathname === '/api/vram') { send(res, 200, await vramSnapshot()); return; }
      if (req.method === 'GET' && u.pathname === '/api/logs') { send(res, 200, { logs: listLogs() }); return; }
      if (req.method === 'GET' && u.pathname === '/api/update/state') { send(res, 200, updateState()); return; }
      if (req.method === 'GET' && u.pathname === '/api/benchmark') { send(res, 200, benchmarkCatalog()); return; }
      if (req.method === 'GET' && u.pathname === '/api/hf/search') {
        try { send(res, 200, await hfSearch({ q: u.searchParams.get('q') })); }
        catch (e) { send(res, 502, { error: e.message }); }
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/hf/files') {
        try { send(res, 200, await hfFiles({ repo: u.searchParams.get('repo') })); }
        catch (e) { send(res, 400, { error: e.message }); }
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/hf/downloads') { send(res, 200, hfDownloads()); return; }
      if (req.method === 'GET' && u.pathname === '/api/voice/state') { send(res, 200, await voiceState()); return; }
      if (req.method === 'GET' && u.pathname === '/api/health/media') { send(res, 200, await mediaHealth()); return; }
      if (req.method === 'GET' && u.pathname === '/api/log') {
        try { send(res, 200, { file: u.searchParams.get('file'), tail: tailLog(u.searchParams.get('file'), Number(u.searchParams.get('n')) || 60) }); }
        catch (e) { send(res, 400, { error: e.message }); }
        return;
      }
      if (req.method === 'POST' && ['/api/start', '/api/stop', '/api/primary', '/api/ensure', '/api/restart-gateway', '/api/discover', '/api/studio/free', '/api/studio/restore', '/api/swarm', '/api/collective', '/api/provider', '/api/huggingface/defaults', '/api/update/snapshot', '/api/update/rollback', '/api/update/apply', '/api/fleet', '/api/folders', '/api/folders/remove', '/api/hf/download', '/api/benchmark/run', '/api/voice/install', '/api/voice/start', '/api/prefs', '/api/onboarding/complete'].includes(u.pathname)) {
        let b = '';
        req.on('data', (d) => { if (b.length < 20000) b += d; });
        req.on('end', async () => {
          let body = {};
          try { body = b ? JSON.parse(b) : {}; } catch { send(res, 400, { error: 'bad json' }); return; }
          try {
            if (u.pathname === '/api/start') send(res, 200, await startModel(body));
            else if (u.pathname === '/api/stop') send(res, 200, await stopModel(body));
            else if (u.pathname === '/api/ensure') send(res, 200, { key: ensureProvider(body.alias, Number(body.port), body.kind) });
            else if (u.pathname === '/api/primary') { send(res, 200, setPrimary(body)); }
            else if (u.pathname === '/api/restart-gateway') { onRestartGateway && onRestartGateway(); send(res, 200, { restarting: true }); }
            else if (u.pathname === '/api/discover') { onDiscover && onDiscover(); send(res, 200, { rescanning: true }); }
            else if (u.pathname === '/api/studio/free') { onStudio && onStudio('free', body); send(res, 200, { freeing: true, deep: !!body.deep }); }
            else if (u.pathname === '/api/studio/restore') { onStudio && onStudio('restore', body); send(res, 200, { restoring: true }); }
            else if (u.pathname === '/api/swarm') { send(res, 200, await runSwarm(body)); }
            else if (u.pathname === '/api/fleet') { send(res, 200, await runFleet(body)); }
            else if (u.pathname === '/api/collective') { send(res, 200, ensureCompanyBrain(body)); }
            else if (u.pathname === '/api/provider') { send(res, 200, ensureCloudProvider(body)); }
            else if (u.pathname === '/api/huggingface/defaults') { send(res, 200, ensureHuggingFaceModels(body)); }
            else if (u.pathname === '/api/update/snapshot') { send(res, 200, snapshotUpdate(body)); }
            else if (u.pathname === '/api/update/rollback') { send(res, 200, rollbackUpdate(body)); }
            else if (u.pathname === '/api/update/apply') { send(res, 200, applyUpdate(body)); }
            else if (u.pathname === '/api/hf/download') { send(res, 200, hfDownload(body)); }
            else if (u.pathname === '/api/benchmark/run') { send(res, 200, await benchmarkRun(body)); }
            else if (u.pathname === '/api/folders') { send(res, 200, addFolder(body.folder)); }
            else if (u.pathname === '/api/folders/remove') { send(res, 200, removeFolder(body.folder)); }
            else if (u.pathname === '/api/voice/install') { send(res, 200, await voiceInstall(body, { onVoiceInstalled })); }
            else if (u.pathname === '/api/voice/start') { onVoiceInstalled && onVoiceInstalled(); send(res, 200, { starting: true }); }
            else if (u.pathname === '/api/prefs') { send(res, 200, writePanelPrefs({ lowRam: !!body.lowRam })); }
            else if (u.pathname === '/api/onboarding/complete') { const prefs = writePanelPrefs({ onboardingComplete: true }); onOnboardingComplete && onOnboardingComplete(); send(res, 200, prefs); }
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

// ── Swarm (Ahmad 2026-09-07): N local brains, one chair answer. ─────────────
// Calls home/kernel/swarm.py (council | debate | swarm, up to 10 brains).
async function runSwarm({ task, mode, brains } = {}) {
  const SWARM = path.join(OPC1_ROOT, 'home', 'kernel', 'swarm.py');
  const PY = 'C:/Program Files/Python311/python.exe';
  if (!require('node:fs').existsSync(SWARM)) return { ok: false, error: 'swarm.py missing: ' + SWARM };
  const args = [SWARM, task || 'State of OPC-1?', '--mode', mode || 'council'];
  if (brains) args.push('--brains', String(brains));
  return new Promise((resolve) => {
    const c = spawn(PY, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', (e) => resolve({ ok: false, error: e.message }));
    c.on('exit', (code) => resolve({ ok: code === 0, answer: out.trim(), voices: err.trim().slice(-600) }));
  });
}

function stopManaged() {
  for (const [, c] of children) { try { c.kill(); } catch {} }
  children.clear();
}

// ── Fleet (Phase 2): preset-based start/stop of switchable chat brains ──────
// VRAM truth comes from nvidia-smi (2x RTX 5090 32GB here). Fleet models all
// target GPU0; fixed/reserved roles (thinker/vision/embed/voice) are sacred —
// never selected, never stopped.
const FLEET_VRAM_CAP = 0.85;       // never plan past 85% of the target GPU
const FLEET_VRAM_OVERHEAD = 1.15;  // file GiB -> VRAM MiB headroom (ctx, kv-cache, cuda)
const FLEET_PRESETS = ['min-chat', 'max-chat', 'one-big', 'off'];

function vramSnapshot() {
  return new Promise((resolve) => {
    let out = '';
    let c;
    try {
      c = spawn('nvidia-smi', ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { return resolve({ ok: false, error: e.message, gpus: [] }); }
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', (e) => resolve({ ok: false, error: e.message, gpus: [] }));
    c.on('exit', (code) => {
      if (code !== 0) return resolve({ ok: false, error: 'nvidia-smi exit ' + code, gpus: [] });
      const gpus = out.trim().split(/\r?\n/).map((line, i) => {
        const [total, used] = line.split(',').map((x) => Number(x.trim()));
        return { index: i, total, used, free: total - used };
      }).filter((g) => Number.isFinite(g.total) && Number.isFinite(g.used));
      resolve({ ok: gpus.length > 0, gpus, at: new Date().toISOString() });
    });
  });
}

async function waitPort(port, ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function runFleet({ preset } = {}) {
  preset = String(preset || '');
  if (!FLEET_PRESETS.includes(preset)) throw new Error('unknown fleet preset: ' + preset);

  // off: stop ONLY what the fleet started — role-fixed brains stay untouched.
  if (preset === 'off') {
    const stopped = [], skipped = [];
    for (const port of [...fleetStarted]) {
      try { await stopModel({ port }); stopped.push(port); fleetStarted.delete(port); }
      catch (e) { skipped.push({ alias: ':' + port, reason: e.message }); }
    }
    return { ok: true, preset, started: [], stopped, skipped, vram: await vramSnapshot() };
  }

  const disk = scanDisk();
  const models = disk.models || [];
  // candidates: chat-kind only, not fixed/reserved, not already running
  const cands = [];
  for (const m of models) {
    if (m.kind !== 'chat') continue;
    if (m.fixed) continue; // thinker/vision/embed/voice are sacred
    if (await portOpen(m.port)) continue;
    cands.push(m);
  }
  cands.sort((a, b) => a.gb - b.gb); // smallest-first

  let pick;
  if (preset === 'min-chat') pick = cands.slice(0, 4);
  else if (preset === 'max-chat') pick = cands;
  else pick = cands.slice().reverse(); // one-big: largest-first, first fit wins

  const started = [], skipped = [];
  let vram = await vramSnapshot();
  const gpu0 = vram.ok && vram.gpus.length ? vram.gpus[0] : null;
  const budget = gpu0 ? Math.floor(gpu0.total * FLEET_VRAM_CAP) : Infinity;

  for (const m of pick) {
    const needMiB = Math.ceil(m.gb * 1024 * FLEET_VRAM_OVERHEAD);
    if (gpu0) {
      vram = await vramSnapshot(); // re-read: the previous model may still be allocating
      const g0 = vram.ok && vram.gpus[0] ? vram.gpus[0] : gpu0;
      if (g0.used + needMiB > budget) {
        skipped.push({ alias: m.alias, reason: `would exceed 85% VRAM on GPU0 (needs ~${needMiB} MiB, ${g0.free} MiB free)` });
        continue;
      }
    }
    try {
      await startModel({ alias: m.alias, gpu: '0' });
      fleetStarted.add(m.port);
      const up = await waitPort(m.port, 120000);
      if (!up) { skipped.push({ alias: m.alias, reason: `port :${m.port} did not answer within 120s` }); continue; }
      started.push({ alias: m.alias, port: m.port, gb: m.gb });
      if (preset === 'one-big') break;
    } catch (e) {
      fleetStarted.delete(m.port);
      skipped.push({ alias: m.alias, reason: e.message });
    }
  }
  return { ok: true, preset, started, skipped, vram: await vramSnapshot() };
}

module.exports = {
  startPanelServer,
  stopManaged,
  scanDisk,
  state,
  startModel,
  stopModel,
  setPrimary,
  ensureProvider,
  benchmarkCatalog,
  ensureCompanyBrain,
  ensureCloudProvider,
  ensureHuggingFaceModels,
  snapshotUpdate,
  rollbackUpdate,
  applyUpdate,
  updateState,
  runFleet,
  vramSnapshot,
  voiceInstall,
  voiceState,
};
