'use strict';

// abuz8-config.cjs — Harness Stage 2 (PRD_PLUGGABLE_HARNESS.md §4).
//
// Shared foundation for the panel split: path roots, openclaw.json read/write,
// and the handful of pure network/scoring helpers every other module needs
// (portOpen, getJson, listProviderModels/classifyUse/scoreModel). Putting
// these here — rather than in whichever module happened to need them first —
// is what lets abuz8-registry.cjs (kind: brain) and abuz8-ledger.cjs
// (kind: ledger) both depend on this file without depending on EACH OTHER.
// No circular requires, no duplicated logic.
//
// This file owns no process, no port, no mutable runtime state. Everything in
// it is either a path constant or a pure/idempotent function. That is the
// whole point of extracting it: the riskiest code in the old abuz8-models.cjs
// (spawn, kill, child tracking) never has to be touched to reuse a path
// constant, and a bug in one panel surface cannot corrupt another's state.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const OPC1_ROOT = process.env.OPC1_HOME || path.join(os.homedir(), '.openclaw-OPC-1');
const RESOURCES = path.join(__dirname, '..'); // resources\app -> resources
function firstExisting(candidates) { return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || candidates[0]; }

const STATE_DIR = path.join(OPC1_ROOT, 'home');
const OPENCLAW_JSON = path.join(STATE_DIR, 'openclaw.json');
const BRAINS_JSON = path.join(OPC1_ROOT, 'body', 'brains.json');
const BRAINS_MIRROR = 'E:\\ABU\\ops\\brains.json';
const PRODUCT_ROOT = process.env.OPC1_PRODUCT_ROOT || firstExisting(['C:\\ABUZ8-Agents\\ABUZ8-OPC-1', path.join(RESOURCES, '..')]);
const COMPANY_BRAIN_PLUGIN_ID = 'memos-local-openclaw-plugin';

// ---------------------------------------------------------------- config IO

function readConfig() {
  try { return { cfg: JSON.parse(fs.readFileSync(OPENCLAW_JSON, 'utf8')), error: null }; }
  catch (e) { return { cfg: null, error: e.message }; }
}

function writeConfig(cfg) {
  // No gateway failures from bad writes: validate the JSON round-trips, keep
  // the last 3 timestamped backups, then write. A crash mid-write never loses
  // the last good config.
  const text = JSON.stringify(cfg, null, 2);
  JSON.parse(text);
  try {
    const dir = path.join(STATE_DIR, 'config-backups');
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(OPENCLAW_JSON)) {
      fs.copyFileSync(OPENCLAW_JSON, path.join(dir, `openclaw-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
      const olds = fs.readdirSync(dir).filter((f) => f.startsWith('openclaw-')).sort();
      while (olds.length > 3) { try { fs.unlinkSync(path.join(dir, olds.shift())); } catch {} }
    }
  } catch {}
  fs.writeFileSync(OPENCLAW_JSON, text);
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

function findAgentModel(cfg, id) {
  // 2026.9.1 canonical: agents.entries.<id>.model.
  const entries = cfg?.agents?.entries;
  if (entries && entries[id] && entries[id].model) return entries[id].model;
  return null;
}

function readBrains() {
  try { return JSON.parse(fs.readFileSync(BRAINS_JSON, 'utf8')); }
  catch {
    try { return JSON.parse(fs.readFileSync(BRAINS_MIRROR, 'utf8')); }
    catch { return null; }
  }
}

// -------------------------------------------------------------- net probes

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

// -------------------------------------------------------- provider scoring
//
// Pure functions over a provider model entry — no I/O, no config writes.
// Shared because state() (registry) and benchmarkCatalog() (ledger) both need
// the exact same "what is this model good for" answer; duplicating it would
// let the two views drift apart silently.

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

module.exports = {
  OPC1_ROOT, RESOURCES, STATE_DIR, OPENCLAW_JSON, BRAINS_JSON, BRAINS_MIRROR, PRODUCT_ROOT, COMPANY_BRAIN_PLUGIN_ID,
  firstExisting,
  readConfig, writeConfig, ensureAllow, providerKeyFor, findAgentModel, readBrains,
  portOpen, getJson,
  listProviderModels, classifyUse, scoreModel,
};
