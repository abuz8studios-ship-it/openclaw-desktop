'use strict';

// abuz8-ledger.cjs — Harness Stage 2, kind: ledger (PRD_PLUGGABLE_HARNESS.md §4).
//
// Everything that answers "what do we know about our models and our machine",
// as opposed to abuz8-registry.cjs's "what models exist and what is running":
// benchmark scoring, the collective-brain selection built on that scoring,
// live media/GPU health, the HuggingFace GGUF catalogue (search/browse/
// download — no key needed, distinct from the HF *inference provider* which
// abuz8-registry.cjs still carries but which is unused since 2026-09-20), log
// browsing, and the voice-runtime installer.
//
// This file writes to disk in three places only: BENCHMARK_PATH,
// COMPANY_BRAIN_PATH, and openclaw.json (via abuz8-config.cjs's writeConfig,
// which backs up before writing). It starts no long-lived process of its own —
// ffmpeg/nvidia-smi probes in mediaHealth() are one-shot and self-timeout.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');

const { STATE_DIR, RESOURCES, OPC1_ROOT, firstExisting, readConfig, writeConfig, ensureAllow, listProviderModels, classifyUse, scoreModel, getJson, COMPANY_BRAIN_PLUGIN_ID } = require('./abuz8-config.cjs');
const registry = require('./abuz8-registry.cjs'); // scanDisk + portOpen(via config) for benchmarkRun/mediaHealth; vramSnapshot for GPU reporting

const BENCHMARK_PATH = path.join(STATE_DIR, 'kernel', 'model_benchmarks.json');
const COMPANY_BRAIN_PATH = path.join(STATE_DIR, 'kernel', 'company_brain.json');

// -------------------------------------------------------------- benchmarks

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
  const disk = registry.scanDisk();
  const m = (disk.models || []).find((x) => x.alias === alias);
  if (!m) throw new Error('model not on disk: ' + alias);
  const { portOpen } = require('./abuz8-config.cjs');
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

// ------------------------------------------------------------- media health

function readSidecarStatus() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'sidecar-status.json'), 'utf8')); } catch { return {}; }
}

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
  const [comfy, vision, voiceProbe, hands, gpu] = await Promise.all([
    probe(8188, '/system_stats'), probe(registry.rolePort('vision', 8012), '/v1/models'), probe(8094, '/health'), probe(8790, '/health'), registry.vramSnapshot(),
  ]);
  // Voice honesty: if :8094 answers, say WHO owns it (started by us vs adopted);
  // if not, surface the exact missing piece the body recorded.
  const ssVoice = readSidecarStatus().voice || {};
  const voice = voiceProbe.ok
    ? { ok: true, mode: ssVoice.state === 'started' ? 'started' : 'adopted-existing:8094' }
    : { ok: false, status: voiceProbe.status, unavailable: ssVoice.reason || 'not running', missing: ssVoice.missing || null };
  return {
    at: new Date().toISOString(),
    comfy, vision, voice, hands, ffmpeg,
    gpu: gpu.ok ? { ok: true, gpus: gpu.gpus } : { ok: false, error: gpu.error || 'nvidia-smi unavailable' },
  };
}

// ── HuggingFace GGUF catalogue + download (2026-09-10 installer lane) ───────
// Search HF, list a repo's .gguf files with sizes, and download one into
// MODELS_ROOT with resume (Range header). Public repos need no token; a token
// is honored when present via env. Downloaded files land in a per-repo subdir
// so the registry's scanDisk picks them up automatically.
// 2026-09-20: this is the capability that survives the HF-provider removal —
// it never needed a key.
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
  const r = await hfGetJson(`https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&direction=-1&limit=20`);
  const rows = (Array.isArray(r.json) ? r.json : []).map((m) => ({ repo: m.id, downloads: m.downloads || 0, likes: m.likes || 0, lastModified: m.lastModified || null }));
  return { results: rows };
}
async function hfFiles({ repo } = {}) {
  repo = String(repo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('bad repo: ' + repo);
  const r = await hfGetJson(`https://huggingface.co/api/models/${repo}`);
  if (!r.json) throw new Error('repo lookup failed (status ' + r.status + ')');
  const files = (r.json.siblings || []).map((s) => s.rfilename).filter((f) => /\.gguf$/i.test(f) || /mmproj/i.test(f));
  let sizes = {};
  try {
    const t = await hfGetJson(`https://huggingface.co/api/models/${repo}/tree/main`);
    if (Array.isArray(t.json)) for (const n of t.json) if (n.path && n.size) sizes[n.path] = n.size;
  } catch {}
  const kind = (f) => (/mmproj/i.test(f) ? 'mmproj' : 'weights');
  return { repo, files: files.map((f) => ({ file: f, kind: kind(f), size: sizes[f] || null, mb: sizes[f] ? Math.round(sizes[f] / 1048576) : null })) };
}

const downloads = new Map(); // "repo/file" -> progress record (in-memory)
function hfStream(url, offset, redirectsLeft, cb) {
  const headers = hfHeaders(offset > 0 ? { Range: `bytes=${offset}-` } : {});
  const req = https.get(url, { headers }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
      res.resume();
      return hfStream(res.headers.location, offset, redirectsLeft - 1, cb);
    }
    cb(null, res);
  });
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
  const dir = path.join(registry.MODELS_ROOT, repo.replace(/[^\w.-]+/g, '_'));
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
  return { downloads: [...downloads.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))) };
}

// ── 2026-09-28 catalogue upgrade (Unsloth/LM Studio/Ollama verdicts) ────────
// One resolver for every way Ahmad names a model:
//   "unsloth/Qwen3-8B-GGUF" + quant "Q4_K_M"
//   "unsloth/Qwen3-8B-GGUF:Q4_K_M"            (repo:quant shorthand)
//   full "https://huggingface.co/<repo>/resolve/main/<file>.gguf" URL
// Vision weights also report their sibling mmproj so the caller can fetch it
// alongside (llama-server --mmproj needs both files on disk).
const normQ = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function hfResolve({ repo, quant, file } = {}) {
  let r = String(repo || '').trim();
  const rq = /^([\w.-]+\/[\w.-]+):([^:]+)$/.exec(r);
  if (rq && !quant) { r = rq[1]; quant = rq[2]; }
  let urlFile = file ? String(file).trim() : null;
  const u = /huggingface\.co\/([\w.-]+\/[\w.-]+)\/(?:resolve\/[^/]+\/|blob\/[^/]+\/)?([^\/?#]+\.gguf)/i.exec(r);
  if (u) { r = u[1]; urlFile = urlFile || u[2]; }
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('bad repo (want org/name, org/name:QUANT, or full huggingface.co URL)');
  const { files } = await hfFiles({ repo: r });
  if (urlFile) {
    const hit = files.find((f) => f.file.toLowerCase() === String(urlFile).toLowerCase());
    if (!hit) throw new Error('file not in repo: ' + urlFile);
    return { repo: r, file: hit.file, size: hit.size, mb: hit.mb, via: 'url' };
  }
  const q = normQ(quant);
  if (!q) return { repo: r, files, hint: 'pass quant (e.g. Q4_K_M, UD-Q4_K_XL) or file' };
  const weights = files.filter((f) => f.kind === 'weights');
  const hit = weights.find((f) => normQ(f.file) === q || normQ(f.file).endsWith(q))
    || weights.find((f) => normQ(f.file).includes(q));
  if (!hit) throw new Error('no weights file matching quant ' + quant + ' in ' + r);
  const mm = files.find((f) => f.kind === 'mmproj');
  return { repo: r, file: hit.file, size: hit.size, mb: hit.mb, mmproj: mm ? mm.file : null, via: 'quant' };
}

// LM Studio-style fetch: resolve then queue the download (plus mmproj for
// vision when asked). registry.scanDisk picks finished files up automatically.
async function hfFetch({ repo, file, quant, url, withMmproj } = {}) {
  const r = await hfResolve({ repo: url || repo, quant, file });
  const main = hfDownload({ repo: r.repo, file: r.file });
  let mm = null;
  if ((withMmproj === true || withMmproj === '1') && r.mmproj) mm = hfDownload({ repo: r.repo, file: r.mmproj });
  else if (withMmproj && r.mmproj && String(withMmproj).toLowerCase() !== 'false' && r.via === 'quant') mm = hfDownload({ repo: r.repo, file: r.mmproj });
  return { resolved: r, main, mmproj: mm };
}

// -------------------------------------------------------------------- logs

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

// ---------------------------------------------------------- voice runtime
// Python resolution chain: OPC1_VOICE_PYTHON -> py -3 -> python on PATH ->
// C:\Program Files\Python311 (legacy compat) -> honest null.
function resolvePython() {
  const cands = [];
  if (process.env.OPC1_VOICE_PYTHON) cands.push({ cmd: process.env.OPC1_VOICE_PYTHON, pre: [], label: 'OPC1_VOICE_PYTHON' });
  cands.push({ cmd: 'py', pre: ['-3'], label: 'py -3' });
  cands.push({ cmd: 'python', pre: [], label: 'python (PATH)' });
  cands.push({ cmd: 'C:/Program Files/Python311/python.exe', pre: [], label: 'Python311 (legacy)' });
  for (const c of cands) {
    try {
      const r = spawnSync(c.cmd, [...c.pre, '--version'], { windowsHide: true, timeout: 8000, encoding: 'utf8' });
      if (r.status === 0) return { ...c, version: String(r.stdout || r.stderr || '').trim() };
    } catch {}
  }
  return null;
}
function voiceScriptPath() {
  return firstExisting([
    path.join(RESOURCES, 'voice', 'voice_server.py'),
    path.join(OPC1_ROOT, 'runtime', 'voice', 'voice_server.py'),
  ]);
}
function voiceReqsPath() {
  return firstExisting([
    path.join(RESOURCES, 'voice', 'requirements.txt'),
    path.join(OPC1_ROOT, 'runtime', 'voice', 'requirements.txt'),
  ]);
}
function voiceInstall() {
  const script = voiceScriptPath();
  if (!fs.existsSync(script)) return { ok: false, error: 'voice server script missing (expected bundled resources\\voice\\voice_server.py)', missing: 'script' };
  const reqs = voiceReqsPath();
  if (!fs.existsSync(reqs)) return { ok: false, error: 'requirements.txt missing next to voice_server.py — nothing to install', missing: 'requirements' };
  const py = resolvePython();
  if (!py) return { ok: false, error: 'no python interpreter found (tried OPC1_VOICE_PYTHON, py -3, python on PATH, C:\\Program Files\\Python311)', missing: 'python' };
  const r = spawnSync(py.cmd, [...py.pre, '-m', 'pip', 'install', '-r', reqs], { windowsHide: true, timeout: 600000, encoding: 'utf8' });
  const tail = String((r.stdout || '') + '\n' + (r.stderr || '')).split(/\r?\n/).slice(-40).join('\n');
  if (r.error) return { ok: false, python: py.label, error: r.error.message, tail };
  if (r.status !== 0) return { ok: false, python: py.label, error: 'pip exited ' + r.status, tail };
  return { ok: true, python: py.label, version: py.version, tail };
}

module.exports = {
  BENCHMARK_PATH, COMPANY_BRAIN_PATH,
  benchmarkCatalog, benchmarkRun, ensureCompanyBrain,
  mediaHealth, readSidecarStatus,
  hfSearch, hfFiles, hfDownload, hfDownloads, hfResolve, hfFetch,
  listLogs, tailLog,
  voiceInstall,
};
