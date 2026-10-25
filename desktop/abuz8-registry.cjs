'use strict';

// abuz8-registry.cjs — Harness Stage 2, kind: brain (PRD_PLUGGABLE_HARNESS.md §4).
//
// Everything that answers "what models exist and what is running": disk scan,
// role binding, start/stop of llama-server processes, the fleet preset
// scheduler, and swarm dispatch. Extracted from the old 1,492-line
// abuz8-models.cjs so the model registry can be read, tested, and reasoned
// about without the HTTP server, the updater bridge, or the HF/benchmark
// ledger in the same file.
//
// Owns the one piece of live mutable state that matters for safety: `children`,
// the map of ports this process itself spawned. stopManaged() — called on
// app quit — only kills what is in that map, never an adopted process. That
// invariant is why this file, not the HTTP surface, is the right owner of it.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const cfgmod = require('./abuz8-config.cjs');
const { OPC1_ROOT, RESOURCES, STATE_DIR, firstExisting, readConfig, writeConfig, ensureAllow, providerKeyFor, findAgentModel, readBrains, portOpen, getJson, listProviderModels, classifyUse, scoreModel, COMPANY_BRAIN_PLUGIN_ID } = cfgmod;
const resolver = require('./abuz8-resolver.cjs');

let ModelReg = null;
try { ModelReg = require('./models-registry.cjs'); } catch (e) { console.error('[registry] model registry module failed to load:', e && e.message); }

// Default model cache lives under the CURRENT USER'S profile. Extra folders
// (user-selected in the panel) persist in <STATE>\model-folders.json.
const E_MODELS = 'E:\\ABU\\MODELS\\llm';
const MODELS_ROOT = process.env.OPC1_MODELS || path.join(OPC1_ROOT, 'models');
try { fs.mkdirSync(MODELS_ROOT, { recursive: true }); } catch {}
const MODEL_FOLDERS_JSON = path.join(OPC1_ROOT, 'home', 'model-folders.json');

function readModelFolders() {
  try { const j = JSON.parse(fs.readFileSync(MODEL_FOLDERS_JSON, 'utf8')); return Array.isArray(j.folders) ? j.folders.filter((f) => typeof f === 'string' && f.trim()) : []; }
  catch { return []; }
}
function writeModelFolders(folders) {
  try { fs.mkdirSync(path.dirname(MODEL_FOLDERS_JSON), { recursive: true }); fs.writeFileSync(MODEL_FOLDERS_JSON, JSON.stringify({ folders }, null, 2)); } catch {}
}
function modelsRoots() {
  const roots = [MODELS_ROOT];
  for (const f of readModelFolders()) { const r = f.trim(); if (!roots.includes(r)) roots.push(r); }
  try { if (fs.existsSync(E_MODELS) && !roots.includes(E_MODELS)) roots.push(E_MODELS); } catch {}
  return roots;
}
function addModelFolder({ folder } = {}) {
  folder = String(folder || '').trim();
  if (!folder) throw new Error('folder required');
  if (!fs.existsSync(folder)) throw new Error('folder does not exist: ' + folder);
  const folders = readModelFolders();
  if (!folders.includes(folder)) { folders.push(folder); writeModelFolders(folders); }
  return { folders };
}
function removeModelFolder({ folder } = {}) {
  folder = String(folder || '').trim();
  const folders = readModelFolders().filter((f) => f !== folder);
  writeModelFolders(folders);
  return { folders };
}

// Bundled engine first; sovereign-root and E: runtimes are optional-if-exists.
const RUNTIME = firstExisting([
  path.join(RESOURCES, 'engine', 'llama-server.exe'),
  path.join(OPC1_ROOT, 'runtime', 'llama', 'llama-server.exe'),
  'E:\\ABU\\MODELS\\runtime\\llama-b10566-cuda13\\llama-server.exe',
]);

// Role bindings for today's settled stack live in models.registry.json as
// candidates DATA (editable in panel via /api/roles/bind, never code). The
// table below is only the migration seed: filenames the scanner recognizes as
// "this file prefers this alias/port until the registry says otherwise".
// NOTHING here is the-one-and-only — any GGUF can take any role of its kind.
const POOL_FALLBACK = [8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010, 8013, 8014, 8015, 8020, 8000, 8022, 8023, 8024, 8025, 8026, 8027];

const children = new Map(); // port -> ChildProcess (only servers THIS process started)
const fleetStarted = new Set(); // ports the FLEET started — preset "off" touches only these, never role-fixed brains

function loadReg() {
  if (!ModelReg) return { roles: {}, folders: [MODELS_ROOT], pool: [], overrides: {} };
  return ModelReg.loadRegistry(OPC1_ROOT, RESOURCES);
}

// 2026-09-30: role ports are DATA (models.registry.json), never literals. The 9/30
// port move (8011/8012/8021 -> 8111/8112/8121) left health/media/studio probing
// the old numbers, so the panel reported three live brains DOWN. Every caller that
// needs "where is the thinker" asks here; `fallback` is used only if the registry
// has no such role (a broken registry degrades to the caller's old behavior).
function rolePort(role, fallback) {
  try {
    const r = loadReg().roles && loadReg().roles[role];
    const p = r && Number(r.port);
    if (p > 0) return p;
  } catch {}
  return fallback;
}

function scanDisk() {
  // UNIVERSAL scan: registry folders + panel-added folders, any GGUF in any of
  // them, kind detected from files (mmproj = vision, embed-name = embed). Role
  // bindings resolve from the registry — the model that fills a role takes the
  // role's port; everything else takes the first free pool port.
  const reg = loadReg();
  const folders = [...reg.folders];
  for (const f of readModelFolders()) { const t = f.trim(); if (t && !folders.includes(t)) folders.push(t); }
  if (!ModelReg) return { models: [], roots: folders, scanErrors: ['registry module missing'] };
  const { models: out, roots, scanErrors } = ModelReg.scanModels(folders, []);
  const pool = (reg.pool && reg.pool.length ? reg.pool : POOL_FALLBACK);
  // Reverse role map: which model currently fills each role (for display).
  const roleFill = {};
  for (const r of Object.keys(reg.roles || {})) {
    const hit = ModelReg.resolveRole(reg, r, out);
    if (hit) roleFill[r] = hit.model;
  }
  const rolePorts = new Set(Object.values(reg.roles || {}).map((r) => r.port));
  const used = new Set();
  for (const m of out) {
    m.alias = m.alias; // slug set by scanner (disambiguated)
    const roleName = Object.keys(roleFill).find((r) => roleFill[r] === m);
    const ov = (reg.overrides || {})[m.alias] || (reg.overrides || {})[m.file] || {};
    if (roleName) {
      m.role = roleName;
      m.port = reg.roles[roleName].port;
      m.ctx = ov.ctx || reg.roles[roleName].ctx || reg.genericChatCtx || 32768;
      m.fixed = roleName; // legacy display key (panel HTML sorts roles first)
      m.starter = 'role:' + roleName;
    } else {
      m.role = null;
      m.fixed = null;
      m.starter = null;
      m.port = ov.port && !used.has(ov.port) && !rolePorts.has(ov.port) ? ov.port : (pool.find((p) => !used.has(p) && !rolePorts.has(p)) || 8020);
      m.ctx = ov.ctx || reg.genericChatCtx || 32768;
    }
    used.add(m.port);
  }
  out.sort((a, b) => (a.role ? -1 : b.role ? 1 : 0) || a.port - b.port);
  return { models: out, roots, scanErrors };
}

async function liveMap(models) {
  // 2026-09-15 Step 2: TCP-first status (busy /v1/models is enrichment only).
  const ports = [...new Set(models.map((m) => m.port))];
  const out = {};
  await Promise.all(ports.map(async (p) => {
    const up = await portOpen(p);
    if (!up) { out[p] = { up: false, ids: [], via: 'tcp' }; return; }
    const r = await getJson(`http://127.0.0.1:${p}/v1/models`);
    if (r && r.status === 200 && r.json) {
      const ids = Array.isArray(r.json.data) ? r.json.data.map((m) => m.id).filter(Boolean) : [];
      out[p] = { up: true, ids, via: 'tcp+http' };
    } else {
      out[p] = { up: true, ids: [], via: 'tcp', note: 'port open, /v1/models not answering yet (still loading?)' };
    }
  }));
  return out;
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
  // 2026-09-15 Step 2: studio UP flags are TCP; HTTP details stay in media-health.
  const visionPort = rolePort('vision', 8112);
  const thinkerPort = rolePort('thinker', 8111);
  await Promise.all([8188, visionPort, 8094, thinkerPort, 8790].map(async (p) => {
    side[p] = await portOpen(p);
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
    resolver: resolver.snapshot(),
    studio: { comfy: side[8188], vision: side[visionPort], voice: side[8094], thinker: side[thinkerPort], hands: side[8790] },
    modelFolders: readModelFolders(),
    roots: disk.roots || [MODELS_ROOT],
    scanErrors: disk.scanErrors || null,
    cfgError, scannedAt: new Date().toISOString(),
    brainsScannedAt: brains ? brains.scannedAt : null,
  };
}

function logPath(alias) { return path.join(STATE_DIR, `model-${alias}.log`); }

// ── Load history (2026-09-30): the body LEARNS which models actually load ───
// Every start is watched: ready -> ok row with ms-to-ready, exit-before-ready ->
// failure row with the exit code. The fleet's council picker reads this so it
// stops re-trying models that have never loaded on this engine (the PRD's
// DFlash/Bonsai-class quants) and prefers ones with a proven start.
const LOAD_LOG = path.join(STATE_DIR, 'kernel', 'model_loads.jsonl');
function recordLoad(row) {
  try { fs.mkdirSync(path.dirname(LOAD_LOG), { recursive: true }); fs.appendFileSync(LOAD_LOG, JSON.stringify(row) + '\n'); } catch {}
}
function loadHistory() {
  const h = {};
  let txt = '';
  try { txt = fs.readFileSync(LOAD_LOG, 'utf8'); } catch { return h; }
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const e = h[r.alias] = h[r.alias] || { ok: 0, fail: 0, lastOk: null, lastFail: null, readyMs: [] };
    if (r.ok) { e.ok++; e.lastOk = r.ts; if (r.ms) e.readyMs.push(r.ms); } else { e.fail++; e.lastFail = r.ts; e.lastReason = r.reason; }
  }
  for (const e of Object.values(h)) { e.avgReadyMs = e.readyMs.length ? Math.round(e.readyMs.reduce((a, b) => a + b, 0) / e.readyMs.length) : null; delete e.readyMs; }
  return h;
}
function familyOf(alias) { const m = /^[a-z]+/i.exec(String(alias)); return m ? m[0].toLowerCase() : String(alias).toLowerCase(); }
function watchLoad(m, port, child, t0) {
  let done = false;
  const finish = (row) => { if (done) return; done = true; recordLoad({ ts: new Date().toISOString(), alias: m.alias, family: familyOf(m.alias), gb: m.gb, port, ...row }); };
  child.on('exit', (code) => finish({ ok: false, code, reason: 'exited before ready' }));
  (async () => {
    while (!done && Date.now() - t0 < 180000) {
      if (await portOpen(port)) { finish({ ok: true, ms: Date.now() - t0 }); return; }
      await new Promise((r) => setTimeout(r, 1500));
    }
    finish({ ok: false, reason: 'not ready in 180s' });
  })();
}

async function startModel({ alias, port, ctx, gpu, lora }) {
  const disk = scanDisk();
  const m = (disk.models || []).find((x) => x.alias === alias);
  if (!m) throw new Error('model not on disk: ' + alias);
  port = Number(port || m.port);
  if (await portOpen(port)) throw new Error(`port ${port} already busy — that model is already running`);
  const EXE = RUNTIME; // bundled resources\engine first, optional fallbacks resolved at load
  if (!fs.existsSync(EXE)) throw new Error('llama runtime missing: ' + EXE);
  // LoRA stacking (Unsloth-style combine at runtime): base GGUF + adapter files.
  // Adapters must match the base family; resolved against the model folder first,
  // then any scanned folder. Passed to llama-server as repeated --lora flags.
  const loraFiles = [];
  for (const l of (Array.isArray(lora) ? lora : (lora ? [lora] : []))) {
    const t = String(l).trim();
    if (!t) continue;
    let found = null;
    if (fs.existsSync(t)) found = t;
    else {
      const cands = [path.join(m.root, m.dir, t), path.join(m.root, t)];
      for (const r of (disk.models || [])) { cands.push(path.join(r.root, r.dir, t)); }
      found = cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || null;
    }
    if (!found) throw new Error('lora not on disk: ' + t);
    loraFiles.push(found);
  }

  // Role-bound models launch with the ROLE's canonical flags from the registry
  // (data, editable) — whatever model fills the role gets the role's treatment.
  // Everything else launches with the generic pool flags. One code path.
  const reg = loadReg();
  let args, gpuName;
  if (m.role && reg.roles[m.role]) {
    const built = ModelReg.roleArgs(reg, m.role, m, STATE_DIR);
    args = built.args;
    gpuName = built.gpu;
    port = Number(built.port);
    if (await portOpen(port)) throw new Error(`port ${port} already busy — that model is already running`);
    if (m.role === 'executor') { try { fs.mkdirSync(path.join(STATE_DIR, 'logs', 'kv-slots-nemotron'), { recursive: true }); } catch {} }
  } else {
    // Use the same registry profile as every other launcher. The previous
    // hardcoded branch silently ignored genericChatArgs and forced two slots.
    const built = ModelReg.poolArgs(reg, m, port, Number(ctx) || m.ctx, STATE_DIR);
    args = built.args;
    const ov = (reg.overrides || {})[m.alias] || (reg.overrides || {})[m.file] || {};
    gpuName = ov.gpu !== undefined ? String(ov.gpu) : (gpu === '1' ? '1' : gpu === 'both' ? 'both' : '0');
  }
  if (!m.role) {
    const snapshot = await vramSnapshot();
    if (!snapshot.ok) throw new Error('Cannot load a pool model until GPU memory can be probed');
    const selected = gpuName === 'both' ? snapshot.gpus : snapshot.gpus.filter((g) => String(g.index) === gpuName);
    if (!selected.length) throw new Error('Selected GPU is unavailable: ' + gpuName);
    const free = selected.reduce((sum, g) => sum + g.free, 0);
    const estimate = Math.ceil(m.gb * 1024 * 1.18 + 512);
    if (free < estimate) throw new Error(`Not enough free VRAM: ${free} MiB free, estimated minimum ${estimate} MiB for ${m.alias}; unload a model first`);
  }
  for (const l of loraFiles) { args.push('--lora', l); }
  const logf = logPath(m.alias);
  const fd = fs.openSync(logf, 'a');
  fs.appendFileSync(logf, `\n[registry] start ${m.alias} :${port}${m.role ? ' role=' + m.role : ''}${loraFiles.length ? ' lora=' + loraFiles.join(',') : ''} at ${new Date().toISOString()}\n`);
  const env = { ...process.env };
  delete env.LLAMA_API_KEY; // local servers stay keyless (Meta cloud key must not lock them)
  // Switchables default to GPU 0; role models use the role's GPU from the registry.
  if (gpuName === 'both') delete env.CUDA_VISIBLE_DEVICES;
  else env.CUDA_VISIBLE_DEVICES = gpuName || '0';
  const c = spawn(EXE, args, { windowsHide: true, detached: false, stdio: ['ignore', fd, fd], env });
  children.set(port, c);
  watchLoad(m, port, c, Date.now());
  c.on('error', (e) => { try { fs.appendFileSync(logPath(m.alias), `[registry] spawn error: ${e.message}\n`); } catch {} });
  c.on('exit', (code) => {
    children.delete(port);
    try { fs.appendFileSync(logPath(m.alias), `[registry] exited code=${code}\n`); } catch {}
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
    spawn('pwsh.exe', ['-NoProfile', '-Command',
      `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; 'killed:' + $c.OwningProcess } else { 'nobody' }`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
}

function ensureProvider(alias, port, kind, ctxOverride) {
  const { cfg, error } = readConfig();
  if (error) throw new Error('openclaw.json unreadable: ' + error);
  cfg.models = cfg.models || {}; cfg.models.providers = cfg.models.providers || {};
  const key = providerKeyFor(alias);
  const isVision = kind === 'vision';
  const isEmbed = kind === 'embed';
  const ctx = Number(ctxOverride) || (isEmbed ? 2048 : 32768);
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
    if (Number(ctxOverride)) existingModel.contextWindow = Number(ctxOverride);
  } else {
    cfg.models.providers[key] = {
      api: 'openai-completions',
      apiKey: 'local',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      models: [{
        id: alias,
        name: `${alias} (local :${port})`,
        contextWindow: ctx,
        maxTokens: isEmbed ? 512 : 8192,
        input: isVision ? ['text', 'image'] : isEmbed ? ['text'] : ['text'],
      }],
    };
  }
  ensureAllow(cfg, `${key}/${alias}`);
  writeConfig(cfg);
  return key;
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
  // Note: as of 2026-09-20 the HuggingFace INFERENCE provider was removed from
  // openclaw.json (its apiKey was env:HUGGINGFACE_API_KEY, set nowhere — every
  // call would 401). This function still works and this route is still wired
  // for the day a real key is added; it is simply unused right now. The
  // catalogue (search/browse/download, no key needed) lives in abuz8-ledger.cjs
  // and is unaffected.
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
  // keep fallbacks sane: any LOCAL provider's ref stays a fallback candidate
  // (loopback baseUrl or local/auto key — never matched by model name).
  const fb = cfg.agents.defaults.model.fallbacks || [];
  if (!fb.includes(ref) && role !== 'image') {
    const [pk] = ref.split('/');
    const pent = (cfg.models && cfg.models.providers && cfg.models.providers[pk]) || {};
    const local = /127\.0\.0\.1|localhost/i.test(pent.baseUrl || '') || /^(local-|auto-)/i.test(pk) || (pent.apiKey === 'local');
    if (local) { fb.push(ref); cfg.agents.defaults.model.fallbacks = fb.slice(-12); }
  }
  writeConfig(cfg);
  return { role, ref };
}

// ── UNIVERSAL role binding ────────────────────────────────────────────────
// Bind ANY scanned model to ANY role of its kind: persists the choice as the
// role's first candidate in <home>\models.registry.json (data — survives
// restarts, needs no code change), binds the gateway provider, and for the
// thinker/vision roles also moves the gateway primary/image so Zait actually
// USES the newly bound brain.
function homeRegistryPath() { return path.join(STATE_DIR, 'models.registry.json'); }
function readHomeRegistry() {
  try { return JSON.parse(fs.readFileSync(homeRegistryPath(), 'utf8')); }
  catch { return {}; }
}
async function rolesState() {
  const reg = loadReg();
  const disk = scanDisk();
  const live = await liveMap(disk.models);
  const out = {};
  for (const [name, role] of Object.entries(reg.roles || {})) {
    const hit = ModelReg ? ModelReg.resolveRole(reg, name, disk.models) : null;
    const st = live[role.port];
    out[name] = {
      kind: role.kind, port: role.port, gpu: role.gpu, ctx: role.ctx, auto: role.auto !== false,
      file: hit ? hit.model.file : null, alias: hit ? hit.model.alias : null,
      path: hit ? hit.model.path : null, via: hit ? hit.via : null,
      candidates: role.candidates || [],
      up: !!(st && st.up), ids: (st && st.ids) || [],
    };
  }
  return { roles: out, folders: disk.roots, scanned: disk.models.length, scanErrors: disk.scanErrors };
}
function bindRole({ role, file } = {}) {
  const reg = loadReg();
  const r = reg.roles[role];
  if (!r) throw new Error('unknown role: ' + role + ' (roles: ' + Object.keys(reg.roles || {}).join(', ') + ')');
  const disk = scanDisk();
  const m = (disk.models || []).find((x) => x.file === file || x.alias === file || x.path === file);
  if (!m) throw new Error('model not on disk: ' + file);
  const fits = ModelReg ? ModelReg.roleFits(r.kind, m) : (m.kind === r.kind);
  if (!fits) throw new Error(`kind mismatch: ${m.file} is ${m.kind}, role ${role} needs ${r.kind}`);
  const home = readHomeRegistry();
  home.roles = home.roles || {};
  const prev = ((home.roles[role] && home.roles[role].candidates) || r.candidates || []).filter((c) => c !== m.file);
  home.roles[role] = { ...(home.roles[role] || {}), candidates: [m.file, ...prev] };
  if (!home.roles[role].candidates.includes('*')) home.roles[role].candidates.push('*');
  fs.writeFileSync(homeRegistryPath(), JSON.stringify(home, null, 2));
  const key = ensureProvider(m.alias, r.port, r.kind === 'vision' ? 'vision' : m.kind, r.ctx);
  const ref = `${key}/${m.alias}`;
  // Move the gateway onto the newly bound brain (validated, backed-up write).
  if (role === 'thinker') setPrimary({ role: 'default', ref });
  else if (role === 'vision') setPrimary({ role: 'image', ref });
  return { role, file: m.file, alias: m.alias, port: r.port, ref, note: 'restart the role (tray or /api/stop+/api/start) to run it' };
}

function stopManaged() {
  for (const [, c] of children) { try { c.kill(); } catch {} }
  children.clear();
}

// ── Swarm (Ahmad 2026-09-07): N local brains, one chair answer. ─────────────
// Calls home/kernel/swarm.py (council | debate | swarm, up to 10 brains).
async function runSwarm({ task, mode, brains, autoload, unload } = {}) {
  const SWARM = path.join(OPC1_ROOT, 'home', 'kernel', 'swarm.py');
  const PY = 'C:/Program Files/Python311/python.exe';
  if (!fs.existsSync(SWARM)) return { ok: false, error: 'swarm.py missing: ' + SWARM };
  const args = [SWARM, task || 'State of OPC-1?', '--mode', mode || 'council'];
  if (brains) args.push('--brains', String(brains));
  if (autoload) args.push('--autoload', String(autoload));
  if (unload) args.push('--unload');
  return new Promise((resolve) => {
    const c = spawn(PY, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', (e) => resolve({ ok: false, error: e.message }));
    c.on('exit', (code) => resolve({ ok: code === 0, answer: out.trim(), voices: err.trim().slice(-900) }));
  });
}

// ── Fleet (Phase 2): preset-based start/stop of switchable chat brains ──────
// VRAM truth comes from nvidia-smi (2x RTX 5090 32GB here). Fleet models all
// target GPU0; fixed/reserved roles (thinker/vision/embed/voice) are sacred —
// never selected, never stopped.
const FLEET_VRAM_CAP = 0.85;       // never plan past 85% of the target GPU
const FLEET_VRAM_OVERHEAD = 1.15;  // file GiB -> VRAM MiB headroom (ctx, kv-cache, cuda)
const FLEET_PRESETS = ['min-chat', 'max-chat', 'one-big', 'council', 'off'];

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

// council: a DIVERSE, proven-loadable set — one brain per model family so the
// chair is not merging three copies of the same opinion. Ranking: models that
// failed twice and never loaded are dropped; proven ones first; then closest to
// a 4 GB sweet spot (real chat quality, cheap VRAM); one per family.
function councilPick(cands, hist, n) {
  const ranked = cands
    .filter((m) => { const e = hist[m.alias]; return !(e && e.fail >= 2 && e.ok === 0); })
    .map((m) => { const e = hist[m.alias] || { ok: 0, fail: 0 }; return { m, proven: e.ok > 0 ? 1 : 0, fail: e.fail, dist: Math.abs((m.gb || 0) - 4) }; })
    .sort((a, b) => b.proven - a.proven || a.fail - b.fail || a.dist - b.dist);
  const seen = new Set(), pick = [];
  for (const r of ranked) {
    const fam = familyOf(r.m.alias);
    if (seen.has(fam)) continue;
    seen.add(fam); pick.push(r.m);
    if (pick.length >= n) break;
  }
  return pick;
}

// ── GPU map (2026-09-30): who actually holds VRAM ───────────────────────────
// nvidia-smi reports [N/A] per process on Windows/WDDM, so per-process numbers
// come from the OS "GPU Process Memory" counters. Those OVER-count system
// processes (dwm.exe showed 16.9 GB on a GPU with 12.5 GB really used), so the
// adapter totals from nvidia-smi are the truth and unreliable rows are flagged.
let _gpuCache = { at: 0, val: null };
function gpuMap() {
  if (_gpuCache.val && Date.now() - _gpuCache.at < 4000) return Promise.resolve(_gpuCache.val);
  return new Promise((resolve) => {
    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$proc=@{}; Get-CimInstance Win32_Process | ForEach-Object { $proc[[int]$_.ProcessId]=@{n=$_.Name;c=$_.CommandLine} }",
      "$rows=@(); (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage').CounterSamples | ForEach-Object { if($_.InstanceName -match 'pid_(\\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)' -and $_.CookedValue -gt 150MB){ $p=[int]$Matches[1]; $rows+=[pscustomobject]@{pid=$p;luid=$Matches[2];mb=[math]::Round($_.CookedValue/1MB);name=$proc[$p].n;cmd=$(if($proc[$p].c){$proc[$p].c.Substring(0,[math]::Min(400,$proc[$p].c.Length))})} } }",
      "$ad=@(); (Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples | ForEach-Object { if($_.InstanceName -match 'luid_(0x[0-9a-f]+_0x[0-9a-f]+)' -and $_.CookedValue -gt 100MB){ $ad+=[pscustomobject]@{luid=$Matches[1];mb=[math]::Round($_.CookedValue/1MB)} } }",
      "[pscustomobject]@{rows=$rows;adapters=$ad} | ConvertTo-Json -Depth 4 -Compress",
    ].join('; ');
    let out = '';
    let c;
    try { c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const to = setTimeout(() => { try { c.kill(); } catch {} resolve({ ok: false, error: 'counter query timed out' }); }, 15000);
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', (e) => { clearTimeout(to); resolve({ ok: false, error: e.message }); });
    c.on('exit', async () => {
      clearTimeout(to);
      let j = null; try { j = JSON.parse(out); } catch {}
      const snap = await vramSnapshot();
      if (!j || !snap.ok) return resolve({ ok: false, error: 'no counter data', gpus: snap.gpus || [] });
      const asArr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
      const adapters = asArr(j.adapters), rows = asArr(j.rows);
      // LUID -> GPU index: pair by nearest adapter usage to nvidia-smi used (greedy, unique).
      const luidIdx = {}; const taken = new Set();
      for (const g of snap.gpus) {
        let best = null;
        for (const a of adapters) { if (taken.has(a.luid)) continue; const d = Math.abs(a.mb - g.used); if (!best || d < best.d) best = { luid: a.luid, d }; }
        if (best && best.d < 2048) { luidIdx[best.luid] = g.index; taken.add(best.luid); }
      }
      const byPort = {};
      try { for (const m of (scanDisk().models || [])) byPort[m.port] = m.alias; } catch {}
      const holders = rows.map((r) => {
        const cmd = r.cmd || '';
        const portM = /--port\s+(\d+)/.exec(cmd);
        const aliasM = /--alias\s+(\S+)/.exec(cmd);
        const isLlama = /llama-server/i.test(r.name || '');
        return {
          pid: r.pid, name: r.name, mb: r.mb, gpu: luidIdx[r.luid] ?? null,
          kind: isLlama ? 'llama-server' : (/python|comfy/i.test(r.name || '') ? 'python' : /dwm|explorer|shellhost|searchhost|startmenu/i.test(r.name || '') ? 'system' : 'other'),
          port: portM ? Number(portM[1]) : null,
          alias: aliasM ? aliasM[1] : (portM ? byPort[Number(portM[1])] || null : null),
          managed: portM ? children.has(Number(portM[1])) : false,
          unreliable: /dwm\.exe/i.test(r.name || ''),
        };
      }).sort((a, b) => b.mb - a.mb);
      const val = {
        ok: true, at: new Date().toISOString(),
        gpus: snap.gpus.map((g) => ({ ...g, holders: holders.filter((h) => h.gpu === g.index && !h.unreliable) })),
        unmapped: holders.filter((h) => h.gpu === null),
        note: 'adapter totals (used/free) are truth; per-process MB comes from OS counters and can over-count system processes (dwm.exe flagged unreliable)',
      };
      _gpuCache = { at: Date.now(), val };
      resolve(val);
    });
  });
}

async function runFleet({ preset, n } = {}) {
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
  else if (preset === 'council') pick = councilPick(cands, loadHistory(), Math.max(2, Math.min(6, Number(n) || 3)));
  else pick = cands.slice().reverse(); // one-big: largest-first, first fit wins

  const started = [], skipped = [];
  let vram = await vramSnapshot();
  if (!vram.ok) return { ok: false, preset, started: [], skipped: [], error: 'GPU memory probe failed; no models were loaded' };
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
  MODELS_ROOT, RUNTIME,
  loadReg, rolePort, scanDisk, liveMap, state,
  readModelFolders, writeModelFolders, modelsRoots, addModelFolder, removeModelFolder,
  startModel, stopModel, killPortOwner, logPath,
  ensureProvider, ensureCloudProvider, ensureHuggingFaceModels, setPrimary,
  homeRegistryPath, readHomeRegistry, rolesState, bindRole,
  stopManaged, runSwarm, runFleet, vramSnapshot, gpuMap, loadHistory, councilPick,
  resolveModel: resolver.resolve, resolveModels: resolver.list, resolverSnapshot: resolver.snapshot,
};
