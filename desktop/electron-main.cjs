'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Zait's body.
//
// This is the Electron main process for OPC-1. It was MISSING — the shell had
// no main of its own, so Electron fell through to resources/app.asar, which
// held an unrelated product (ABUZ8 OS). That is why the OpenClaw app opened
// ABUZ8 OS. This file is the real body.
//
// It does not create a second OpenClaw. It owns the ONE original daemon:
//   home  : C:\Users\wirec\.openclaw-OPC-1\home   (sovereign root, live state)
//   cold backup (never read): C:\Users\wirec\.openclaw
//   node  : f059875c-570d-4e6c-a859-b96b6c80553b
//   port  : 18789
//
// The gateway runs as a child of this app (abuz8-daemon-worker.cjs, which was
// already written for exactly this and never wired up). If it dies, this file
// brings it back. Closing the window hides to tray; the daemon keeps running.
// No shell, ever.
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } = require('electron');
const { fork, spawn, execFile } = require('node:child_process');
const execFileAsync = require('node:util').promisify(execFile);
const path = require('node:path');
const net = require('node:net');

// 2026-09-20 harness Stage 1 (PRD_PLUGGABLE_HARNESS.md): sidecar ports resolve
// through the kernel/manifests instead of being literals in this file. Every
// manifest's range today is a single value equal to the historical port, so
// this changes nothing about what actually starts — it changes what has to be
// edited to make it start somewhere else: a manifest, not this file. If the
// kernel module is ever missing, callers fall back to the literal passed in,
// so a bad kernel state degrades to "exactly what this file always did."
let kernel = null;
try { kernel = require('./abuz8-kernel.cjs'); } catch (e) { console.error('[body] kernel unavailable, sidecar ports stay hard-coded:', e && e.message); }
function kernelPort(id, fallback) { try { return (kernel && kernel.resolvePort(id, fallback)) ?? fallback; } catch { return fallback; } }
function kernelMount(id, info) { try { kernel && kernel.recordMount(id, info); } catch {} }
function kernelUnmount(id, reason) { try { kernel && kernel.recordUnmount(id, reason); } catch {} }

// 2026-09-14 freeze fix: this box's GPU compositor locks the Electron renderer.
// Dashboard is plain web content; software rendering is the stable path.
// 2026-09-26 OPTIMIZATION: GPU acceleration for RTX 5090 — hardware rendering
// is Electron's DEFAULT, so we simply do NOT call disableHardwareAcceleration.
// (There is no enableHardwareAcceleration API — calling it throws and kills
// the boot. The 2026-09-14 freeze-fix line stays removed; the flags below do
// the real GPU work.)

// GPU compositor: on by default (Electron's native behavior, like Claude Desktop).
// Set OPC1_SOFT_RENDER=1 in .env to force software rendering if panels freeze.
// History: Sep-14 disabled (freeze), Sep-26 Vulkan experiment (worse), Sep-28 reverted.
// 2026-10-04: re-enable default D3D11 compositor (not Vulkan). Dashboard is web
// content — the GPU compositor is what makes Electron fast like Claude Desktop.
if (process.env.OPC1_SOFT_RENDER === '1') {
  app.disableHardwareAcceleration();
}
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// OPENCLAW_HOME is the USER home — OpenClaw appends ".openclaw" itself.
// 2026-09-04 (permanent home): state lives in the sovereign root's home\ room.
// 2026-09-10 (installer): OPC1 root resolves from OPC1_HOME env, else the OS
// user home — never a hardcoded machine path. E: mirrors stay OPTIONAL extras.
const os = require('node:os');
const OPC1_ROOT = process.env.OPC1_HOME || path.join(os.homedir(), '.openclaw-OPC-1');
const USER_HOME = path.dirname(OPC1_ROOT);
const STATE_DIR = path.join(OPC1_ROOT, 'home');
const ELECTRON_USER_DATA = path.join(OPC1_ROOT, 'electron-user-data');
const ICON_PATH = path.join(STATE_DIR, 'media', 'claw.ico');
// 2026-09-19: the blue claw. Window titlebar + tray both load this asset via
// loadWindowIcon() below. The old tray used a hardcoded 16x16 blue square
// (#5CA5C8) with no glyph — replaced by the real little super blue claw.
const PORT = Number(process.env.OPC1_GATEWAY_PORT || 18789);
const URL = `http://127.0.0.1:${PORT}/`;
const WORKER = path.join(__dirname, 'abuz8-daemon-worker.cjs');
// SOVEREIGN DOWNFORK (Ahmad 2026-09-14): our tree survives upstream disappearing.
// Upstream resolves its sqlite-staging cache as XDG_CACHE_HOME first — ours lives
// under our own root, never the shared %LOCALAPPDATA%\openclaw. Set for this
// process and every child (worker, panel, discover) before anything boots.
const OPC1_CACHE = path.join(OPC1_ROOT, 'cache');
if (!process.env.XDG_CACHE_HOME) process.env.XDG_CACHE_HOME = OPC1_CACHE;
// All HuggingFace weights live on E: (weights-only rule) — one shared hub cache
// for every sidecar (NeMo, Kokoro deps, Qwen, CLIP). Never the C: user profile.
const OPC1_HF_CACHE = 'E:/ABU/MODELS/.hf_cache/hub';
if (!process.env.HF_HUB_CACHE) process.env.HF_HUB_CACHE = OPC1_HF_CACHE;

app.setName('Zait OPC-1');
app.setPath('userData', ELECTRON_USER_DATA);
app.setAppUserModelId('electron.app.ZaitOPC1');

// Auto-login. The control UI reads its gateway token from the URL hash
// (`#token=…`) — that is how `openclaw dashboard` signs itself in. The body
// owns the config, so it reads gateway.auth.token and hands it over. Ahmad
// never types a token into his own app.
function dashboardUrl() {
  try {
    const cfg = JSON.parse(require('node:fs').readFileSync(path.join(STATE_DIR, 'openclaw.json'), 'utf8'));
    const token = cfg?.gateway?.auth?.token;
    if (token) return `${URL}#token=${encodeURIComponent(token)}`;
  } catch (e) {
    console.error('[body] could not read gateway token:', e && e.message);
  }
  return URL;
}

// Electron ships Node 20; OpenClaw needs >=22.22.3. Prefer the runtime bundled
// with the installer (resources\runtime), fall back to the sovereign-root one.
const fs = require('node:fs');
const RESOURCES = (function () {
  try { if (process.resourcesPath && fs.existsSync(process.resourcesPath)) return process.resourcesPath; } catch {}
  return path.join(__dirname, '..');
})();
function firstExisting(candidates) { return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || candidates[0]; }
const NODE = firstExisting([
  path.join(RESOURCES, 'runtime', 'node', 'node.exe'),
  path.join(OPC1_ROOT, 'runtime', 'node', 'node.exe'),
]);

// ── UNIVERSAL model roles ───────────────────────────────────────────────────
// 2026-09-14: code knows KINDS + PORTS only. Every model name, path, and flag
// set lives in models.registry.json (shipped default in resources\, override in
// <home>\models.registry.json). Any GGUF in any listed folder can fill any role
// of its kind. Role binding changes = data edit or panel click, never code.
const BRAIN_PORT = 8001; // executor role port (manual tray fallback only)
const PREFS = path.join(STATE_DIR, 'body-prefs.json');
// Bundled llama engine first; sovereign-root copy is the compat fallback.
const LLAMA_EXE = firstExisting([
  path.join(RESOURCES, 'engine', 'llama-server.exe'),
  path.join(OPC1_ROOT, 'runtime', 'llama', 'llama-server.exe'),
]);
const EMBED_EXE = LLAMA_EXE; // legacy alias (engine is one binary)
let ModelReg = null;
try { ModelReg = require('./models-registry.cjs'); } catch (e) { console.error('[body] model registry failed to load:', e && e.message); }
function loadReg() {
  if (!ModelReg) return { roles: {}, folders: [], pool: [], overrides: {} };
  return ModelReg.loadRegistry(OPC1_ROOT, RESOURCES);
}
// Panel-added folders live here too — registry folders + these merge at scan.
function readExtraFolders() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'model-folders.json'), 'utf8'));
    return Array.isArray(j.folders) ? j.folders.filter((f) => typeof f === 'string' && f.trim()) : [];
  } catch { return []; }
}
// 2026-09-10 (installer): a sidecar whose engine/weights are missing on this
// machine is marked "unavailable" after a bounded number of tries instead of
// crash-looping forever (gap 9). The 20s watchdog respects the marker.
const sidecarFails = {};
const sidecarDead = {};
function sidecarUnavailable(name, reason) {
  if (!sidecarDead[name]) { sidecarDead[name] = reason; console.error(`[body] sidecar ${name} unavailable: ${reason}`); }
}
function sidecarRetry(name, fn, ms) {
  sidecarFails[name] = (sidecarFails[name] || 0) + 1;
  if (sidecarFails[name] >= 5) return sidecarUnavailable(name, 'gave up after 5 failed starts');
  const epoch = sidecarStartEpoch.get(name) || 0;
  setTimeout(() => {
    if (quitting || epoch !== (sidecarStartEpoch.get(name) || 0)) return;
    if (studioHold && ['voice', 'qwen', 'vision', 'thinker', 'comfy'].includes(name)) return;
    fn();
  }, ms);
}
const ROLE_LOG = { thinker: 'brain_ornith.log', executor: 'brain_nemotron.log', vision: 'vision.log', embedder: 'embedder.log' };
const roleProcs = {}; // role -> ChildProcess (only servers THIS body started)
const parkedRoles = new Set(); // panel-parked roles: body stands down, no respawn (GPU swap room)
// Park a role (unload its brain, hold the port closed) or restore it. Parking
// is how you switch brains or free VRAM: park → port frees → start anything.
function parkRole(roleName, on) {
  if (on) {
    parkedRoles.add(roleName);
    stopRole(roleName);
    const reg = loadReg();
    if (reg.roles[roleName]) killPortOwner(reg.roles[roleName].port);
  } else {
    parkedRoles.delete(roleName);
    sidecarDead[roleName] = undefined; delete sidecarDead[roleName];
    sidecarFails[roleName] = 0;
    startRole(roleName);
  }
  return { role: roleName, parked: parkedRoles.has(roleName) };
}
function startRole(roleName, opts) {
  return startSidecarOnce(roleName, (isCurrent) => startRoleNow(roleName, opts, isCurrent));
}
async function startRoleNow(roleName, opts, isCurrent) {
  opts = opts || {};
  if (roleProcs[roleName] || quitting) return;
  if (sidecarDead[roleName]) return;
  if (parkedRoles.has(roleName)) return; // panel-parked: body stands down
  if (studioHold && ['thinker', 'vision'].includes(roleName)) return;
  const reg = loadReg();
  const role = reg.roles[roleName];
  if (!role) return;
  if (await portOpen(600, role.port)) return; // already up (any owner) — adopt, never double
  if (!isCurrent() || roleProcs[roleName] || parkedRoles.has(roleName)) return;
  if (role.auto === false && !opts.manual) return; // manual-only role (executor)
  const scanned = ModelReg.scanModels(reg.folders, readExtraFolders()).models;
  const hit = ModelReg.resolveRole(reg, roleName, scanned);
  if (!hit) return sidecarUnavailable(roleName, `no ${role.kind} model in any folder (${reg.folders.join(', ')})`);
  if (!fs.existsSync(LLAMA_EXE)) return sidecarUnavailable(roleName, 'llama engine missing');
  const built = ModelReg.roleArgs(reg, roleName, hit.model, STATE_DIR);
  try { fs.mkdirSync(path.join(STATE_DIR, 'logs'), { recursive: true }); } catch {}
  const logPath = path.join(STATE_DIR, 'logs', ROLE_LOG[roleName] || `${roleName}.log`);
  const logFd = fs.openSync(logPath, 'a');
  fs.appendFileSync(logPath, `[body] role ${roleName} -> ${hit.model.file} (via ${hit.via}) :${role.port} at ${new Date().toISOString()}\n`);
  // Local servers stay keyless: the dotenv boot-load may carry LLAMA_API_KEY
  // (Meta cloud key) — llama-server would enforce it and break every local
  // caller that sends 'local'/'llamacpp'. Strip it for engine spawns only.
  // Keep the registry's physical GPU identity intact.  The thinker is pinned
  // to physical GPU1 and must therefore see the original 0,1 device map so
  // llama.cpp's --main-gpu 1 is a real device index.  Other roles stay
  // isolated to their configured single device.
  const roleEnv = { ...process.env, CUDA_VISIBLE_DEVICES: roleName === 'thinker' ? '0,1' : built.gpu };
  delete roleEnv.LLAMA_API_KEY;
  const c = roleProcs[roleName] = spawn(LLAMA_EXE, built.args,
    { windowsHide: true, detached: false, stdio: ['ignore', logFd, logFd], env: roleEnv });
  c.on('error', (e) => { fs.appendFileSync(logPath, `[body] role ${roleName} spawn error: ${e && e.message}\n`); });
  c.once('close', (code) => {
    if (roleProcs[roleName] !== c) return;
    roleProcs[roleName] = null;
    fs.appendFileSync(logPath, `[body] role ${roleName} exited code=${code}\n`);
    if (!quitting && !studioHold && role.auto !== false) sidecarRetry(roleName, () => startRole(roleName), 15000);
  });
  return { role: roleName, file: hit.model.file, port: role.port, pid: c.pid };
}
function stopRole(roleName) {
  cancelSidecarStart(roleName);
  const c = roleProcs[roleName];
  if (!c) return false;
  if (roleProcs[roleName] === c) roleProcs[roleName] = null;
  try { c.kill(); } catch {}
  return true;
}
// Legacy names (tray + studio mode call these — roles underneath, unchanged).
function startEmbedder() { return startRole('embedder'); }
function stopEmbedder() { if (!stopRole('embedder')) return; }
function startVision() { return startRole('vision'); }
function stopVision() { if (!stopRole('vision')) return; }
function startThinker() { return startRole('thinker'); }
function stopThinker() { if (stopRole('thinker')) return; const reg = loadReg(); if (reg.roles.thinker) killPortOwner(reg.roles.thinker.port); }
function startBrain() { return startRole('executor', { manual: true }); } // retired lane, tray only
// Mouth + ears (Ahmad 2026-09-02 "full voice"): Kokoro TTS + Parakeet ASR, OpenAI-compatible on :8094.
// 2026-09-10 (installer): the script ships BUNDLED in resources\voice (sovereign
// root copy is a compat fallback). Python resolves by chain: OPC1_VOICE_PYTHON
// env -> `py -3` launcher -> `python` on PATH -> C:\Program Files\Python311
// (legacy compat) -> honest "unavailable". Voice status is written to
// <STATE>\sidecar-status.json so the panel can report exactly what's missing.
const VOICE_SCRIPT = firstExisting([
  path.join(RESOURCES, 'voice', 'voice_server.py'),
  path.join(OPC1_ROOT, 'runtime', 'voice', 'voice_server.py'),
]);
const VOICE_PORT = kernelPort('speech-kokoro', 8094);
const VOICE_LOG = path.join(STATE_DIR, 'voice.log');
const SIDECAR_STATUS = path.join(STATE_DIR, 'sidecar-status.json');
let voice = null;
let voicePy = null; // { cmd, pre, label } once resolved
function recordSidecarStatus(name, entry) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(SIDECAR_STATUS, 'utf8')); } catch {}
  j[name] = { ...entry, at: new Date().toISOString() };
  try { fs.writeFileSync(SIDECAR_STATUS, JSON.stringify(j, null, 2)); } catch {}
}
const pythonProbes = require('./abuz8-python-probes.cjs').createPythonProbes(path.join(STATE_DIR, 'cache', 'python-probes.json'));
const pendingSidecarStarts = new Map();
const sidecarStartEpoch = new Map();
function cancelSidecarStart(name) {
  sidecarStartEpoch.set(name, (sidecarStartEpoch.get(name) || 0) + 1);
  // Allow an immediate resume while the old probe drains. Its epoch cannot spawn.
  pendingSidecarStarts.delete(name);
}
function startSidecarOnce(name, fn) {
  if (pendingSidecarStarts.has(name)) return pendingSidecarStarts.get(name);
  const epoch = sidecarStartEpoch.get(name) || 0;
  const isCurrent = () => !quitting && epoch === (sidecarStartEpoch.get(name) || 0);
  const job = Promise.resolve().then(() => isCurrent() ? fn(isCurrent) : undefined)
    .catch((e) => console.error(`[body] ${name} start failed:`, e && e.message))
    .finally(() => { if (pendingSidecarStarts.get(name) === job) pendingSidecarStarts.delete(name); });
  pendingSidecarStarts.set(name, job);
  return job;
}
function probeVoicePython() {
  const cands = [];
  if (process.env.OPC1_VOICE_PYTHON) cands.push({ cmd: process.env.OPC1_VOICE_PYTHON, pre: [], label: 'OPC1_VOICE_PYTHON' });
  // 2026-10-13: Python311 is the stable ML interpreter on this Windows box.
  // The Comfy uv venv has the same packages but its Windows redirector leaves
  // a child interpreter behind, which makes supervisor ownership ambiguous.
  // Keep Comfy as a fallback for installations where Python311 lacks voice.
  cands.push({ cmd: 'C:/Program Files/Python311/python.exe', pre: [], label: 'Python311 ML voice' });
  cands.push({ cmd: 'E:/ABU/ComfyUI/.venv/Scripts/python.exe', pre: [], label: 'Comfy ML venv' });
  cands.push({ cmd: 'py', pre: ['-3'], label: 'py -3' });
  cands.push({ cmd: 'python', pre: [], label: 'python (PATH)' });
  cands.push({ cmd: 'C:/Program Files/Python311/python.exe', pre: [], label: 'Python311 (legacy)' });
  return pythonProbes.probe(cands, ['kokoro', 'onnxruntime']);
}
// Hands prober: SEPARATE chain from voice. Hands needs desktop libs
// (pyautogui/mss/pygetwindow — system python), never the ML venv (no desktop
// libs there; probing it first crash-looped hands 2026-09-14).
function probeHandsPython() {
  const cands = [];
  if (process.env.OPC1_HANDS_PYTHON) cands.push({ cmd: process.env.OPC1_HANDS_PYTHON, pre: [], label: 'OPC1_HANDS_PYTHON' });
  cands.push({ cmd: 'py', pre: ['-3'], label: 'py -3' });
  cands.push({ cmd: 'python', pre: [], label: 'python (PATH)' });
  cands.push({ cmd: 'C:/Program Files/Python311/python.exe', pre: [], label: 'Python311 (legacy)' });
  return pythonProbes.probe(cands, ['pyautogui', 'mss']);
}
function startVoice() { return startSidecarOnce('voice', startVoiceNow); }
async function startVoiceNow(isCurrent) {
  if (voice || quitting || studioHold) return;
  if (sidecarDead.voice) { return; }
  if (await portOpen(600, VOICE_PORT)) { recordSidecarStatus('voice', { state: 'adopted', port: VOICE_PORT }); kernelMount('speech-kokoro', { port: VOICE_PORT, adopted: true }); return; }
  if (!fs.existsSync(VOICE_SCRIPT)) {
    recordSidecarStatus('voice', { state: 'unavailable', missing: 'script', reason: 'voice server script missing: ' + VOICE_SCRIPT });
    return sidecarUnavailable('voice', 'script missing');
  }
  if (!voicePy) voicePy = await probeVoicePython();
  if (!isCurrent() || voice || await portOpen(600, VOICE_PORT) || !isCurrent()) { return; }
  if (!voicePy) {
    recordSidecarStatus('voice', { state: 'unavailable', missing: 'python', reason: 'no python interpreter found (tried OPC1_VOICE_PYTHON, py -3, python on PATH, C:\\Program Files\\Python311)' });
    return sidecarUnavailable('voice', 'no python interpreter found');
  }
  const fd = require('node:fs').openSync(VOICE_LOG, 'a');
  voice = spawn(voicePy.cmd, [...voicePy.pre, VOICE_SCRIPT], { windowsHide: true, detached: false, stdio: ['ignore', fd, fd], env: { ...process.env, VOICE_PORT: String(VOICE_PORT), PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
  recordSidecarStatus('voice', { state: 'started', python: voicePy.label, script: VOICE_SCRIPT });
  kernelMount('speech-kokoro', { port: VOICE_PORT, pid: voice.pid, script: VOICE_SCRIPT });
  voice.on('error', (e) => { require('node:fs').appendFileSync(VOICE_LOG, `[body] voice spawn error: ${e && e.message}
`); });
  const voiceChild = voice;
  voiceChild.once('close', (code) => { if (voice !== voiceChild) return; voice = null; kernelUnmount('speech-kokoro', `exit code=${code}`); require('node:fs').appendFileSync(VOICE_LOG, `[body] voice exited code=${code}
`); if (!quitting && !studioHold) sidecarRetry('voice', startVoice, 15000); });
}
function stopVoice() { cancelSidecarStart('voice'); if (!voice) return; const v = voice; voice = null; try { v.kill(); } catch {} }
// SUBSCRIPTION BRIDGE (Ahmad 2026-09-15 "subscriptions in the router"): the CLI
// Brains shim (:8780) serves Claude Max + ChatGPT + Grok subscription CLIs as an
// OpenAI-compatible endpoint. Adopted from a worktree orphan into the bundle —
// body-owned now (was a hand-started cmd that died silently). Bound loopback.
const CLIBRAINS_SCRIPT = firstExisting([
  path.join(RESOURCES, 'subscription', 'server.py'),
  'E:/ABU/.claude/worktrees/clever-dewdney-63366a/.shared/cli_brains/server.py',
]);
const CLIBRAINS_PORT = kernelPort('brain-clibrains', 8780);
const CLIBRAINS_LOG = path.join(STATE_DIR, 'clibrains.log');
let clibrains = null;
let clibrainsPy = null;
function startClibrains() { return startSidecarOnce('clibrains', startClibrainsNow); }
async function startClibrainsNow(isCurrent) {
  if (clibrains || quitting) return;
  if (sidecarDead.clibrains) return;
  if (await portOpen(600, CLIBRAINS_PORT)) { recordSidecarStatus('clibrains', { state: 'adopted', port: CLIBRAINS_PORT }); kernelMount('brain-clibrains', { port: CLIBRAINS_PORT, adopted: true }); return; }
  if (!fs.existsSync(CLIBRAINS_SCRIPT)) {
    recordSidecarStatus('clibrains', { state: 'unavailable', missing: 'script', reason: 'cli-brains server missing' });
    return sidecarUnavailable('clibrains', 'script missing');
  }
  if (!clibrainsPy) clibrainsPy = await probeHandsPython();
  if (!isCurrent() || clibrains || await portOpen(600, CLIBRAINS_PORT) || !isCurrent()) return;
  if (!clibrainsPy) {
    recordSidecarStatus('clibrains', { state: 'unavailable', missing: 'python', reason: 'no system python found' });
    return sidecarUnavailable('clibrains', 'no system python found');
  }
  const fd = fs.openSync(CLIBRAINS_LOG, 'a');
  const cliPath = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), 'AppData', 'Roaming', 'npm'), path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links')].join(';') + ';' + process.env.PATH;
  // Subscription bridge must use CLI-native OAuth only: a dead/placeholder
  // ANTHROPIC_API_KEY from the dotenv boot-load makes cli-brains disable its
  // claude.ai connector (502). Strip API-key hijackers for the bridge only.
  const cliEnv = { ...process.env, PATH: cliPath, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', CLI_BRAINS_HOST: '127.0.0.1', CLI_BRAINS_PORT: String(CLIBRAINS_PORT), CLI_BRAINS_TIMEOUT: '300' };
  delete cliEnv.ANTHROPIC_API_KEY;
  clibrains = spawn(clibrainsPy.cmd, [...clibrainsPy.pre, CLIBRAINS_SCRIPT], { windowsHide: true, detached: false, stdio: ['ignore', fd, fd], env: cliEnv });
  recordSidecarStatus('clibrains', { state: 'started', python: clibrainsPy.label });
  kernelMount('brain-clibrains', { port: CLIBRAINS_PORT, pid: clibrains.pid });
  clibrains.on('error', (e) => { fs.appendFileSync(CLIBRAINS_LOG, `[body] clibrains spawn error: ${e && e.message}\n`); });
  const clibrainsChild = clibrains;
  clibrainsChild.once('close', (code) => { if (clibrains !== clibrainsChild) return; clibrains = null; kernelUnmount('brain-clibrains', `exit code=${code}`); fs.appendFileSync(CLIBRAINS_LOG, `[body] clibrains exited code=${code}\n`); if (!quitting) sidecarRetry('clibrains', startClibrains, 15000); });
}
function stopClibrains() { cancelSidecarStart('clibrains'); if (!clibrains) return; const c = clibrains; clibrains = null; kernelUnmount('brain-clibrains', 'stopClibrains()'); try { c.kill(); } catch {} }
// PREMIUM MOUTH (Ahmad 2026-09-14 "instant human voice"): Qwen3-TTS-12Hz-1.7B on
// :8095. Prefer the validated speech.cpp GGUF lane when its exact model and
// binary are present; retain the Python Transformers lane as a guarded fallback.
// :8094 proxies qwen-* voices here. Same watchdog rules; parked for studio like
// every other GPU mouth.
const QWEN_SCRIPT = firstExisting([
  path.join(RESOURCES, 'voice', 'qwen_tts_server.py'),
  path.join(OPC1_ROOT, 'runtime', 'voice', 'qwen_tts_server.py'),
]);
const QWEN_SPEECH_EXE = firstExisting([
  'E:/ABU/MODELS/TTS/speech.cpp/0.8.4/speech.exe',
  path.join(OPC1_ROOT, 'runtime', 'voice', 'speech.exe'),
]);
const QWEN_SPEECH_MODEL = firstExisting([
  'E:/ABU/MODELS/TTS/qwen3-tts-customvoice-17b-gguf/Qwen3-TTS-12Hz-1.7B-CustomVoice-Q4_K.gguf',
]);
const QWEN_PORT = kernelPort('speech-qwen-tts', 8095);
const QWEN_LOG = path.join(STATE_DIR, 'qwen-tts.log');
let qwen = null;
let qwenPy = null;
function startQwen() { return startSidecarOnce('qwen', startQwenNow); }
async function startQwenNow(isCurrent) {
  if (qwen || quitting || studioHold) return;
  if (sidecarDead.qwen) return;
  if (await portOpen(600, QWEN_PORT)) { recordSidecarStatus('qwen', { state: 'adopted', port: QWEN_PORT }); kernelMount('speech-qwen-tts', { port: QWEN_PORT, adopted: true }); return; }
  if (!isCurrent()) return;
  const fd = fs.openSync(QWEN_LOG, 'a');
  const useSpeechCpp = fs.existsSync(QWEN_SPEECH_EXE) && fs.existsSync(QWEN_SPEECH_MODEL);
  if (useSpeechCpp) {
    qwen = spawn(QWEN_SPEECH_EXE, ['serve', QWEN_SPEECH_MODEL, '--host', '127.0.0.1', '--port', String(QWEN_PORT)], {
      windowsHide: true, detached: false, cwd: path.dirname(QWEN_SPEECH_EXE), stdio: ['ignore', fd, fd], env: { ...process.env },
    });
    recordSidecarStatus('qwen', { state: 'started', runtime: 'speech.cpp', executable: QWEN_SPEECH_EXE, model: QWEN_SPEECH_MODEL });
    kernelMount('speech-qwen-tts', { port: QWEN_PORT, pid: qwen.pid, runtime: 'speech.cpp', model: QWEN_SPEECH_MODEL });
  } else {
    if (!fs.existsSync(QWEN_SCRIPT)) {
      recordSidecarStatus('qwen', { state: 'unavailable', missing: 'script', reason: 'qwen server script missing' });
      try { fs.closeSync(fd); } catch {}
      return sidecarUnavailable('qwen', 'script missing');
    }
    if (!qwenPy) qwenPy = await probeHandsPython(); // system python with full libs
    if (!isCurrent() || qwen || await portOpen(600, QWEN_PORT) || !isCurrent()) { try { fs.closeSync(fd); } catch {} return; }
    if (!qwenPy) {
      recordSidecarStatus('qwen', { state: 'unavailable', missing: 'python', reason: 'no system python found' });
      try { fs.closeSync(fd); } catch {}
      return sidecarUnavailable('qwen', 'no system python found');
    }
    qwen = spawn(qwenPy.cmd, [...qwenPy.pre, QWEN_SCRIPT], { windowsHide: true, detached: false, stdio: ['ignore', fd, fd], env: { ...process.env, QWEN_PORT: String(QWEN_PORT), PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
    recordSidecarStatus('qwen', { state: 'started', python: qwenPy.label, script: QWEN_SCRIPT });
    kernelMount('speech-qwen-tts', { port: QWEN_PORT, pid: qwen.pid, script: QWEN_SCRIPT });
  }
  qwen.on('error', (e) => { fs.appendFileSync(QWEN_LOG, `[body] qwen spawn error: ${e && e.message}\n`); });
  const qwenChild = qwen;
  qwenChild.once('close', (code) => { if (qwen !== qwenChild) return; qwen = null; kernelUnmount('speech-qwen-tts', `exit code=${code}`); fs.appendFileSync(QWEN_LOG, `[body] qwen exited code=${code}\n`); if (!quitting && !studioHold) sidecarRetry('qwen', startQwen, 15000); });
}
function stopQwen() { cancelSidecarStart('qwen'); if (!qwen) return; const q = qwen; qwen = null; try { q.kill(); } catch {} }
// HANDS (Ahmad 2026-09-07 "fuse the desktop system"): the desktop-control server
// (:8790, 36 tools: desktop_* + chrome_*).
// 2026-09-14 COMPILED: the script ships BUNDLED in resources\hands (E: copy is
// the compat fallback). Python resolves via the shared probe (OPC1_VOICE_PYTHON
// env -> `py -3` -> `python` on PATH -> legacy Python311) — no hardcoded-only
// interpreter. Same rules: only start if nothing answers on :8790.
const DESKTOP_SCRIPT = firstExisting([
  path.join(RESOURCES, 'hands', 'server.py'),
  'E:/ABU/DESKTOP_CONTROL/python/server.py',
]);
const DESKTOP_PORT = kernelPort('motion-desktop-control', 8790);
const DESKTOP_LOG = path.join(STATE_DIR, 'desktop-control.log');
let desktop = null;
let handsPy = null; // { cmd, pre, label } once resolved
// Bearer token lives in the existing secret stores (E: desktop-control .env,
// then home .env) — read at spawn and passed via env. Never copied into the
// bundle. server.py setdefaults from its own .env, so a pre-set env wins.
function readHandsToken() {
  const files = ['E:/ABU/DESKTOP_CONTROL/.env', path.join(STATE_DIR, '.env')];
  for (const f of files) {
    try {
      const txt = fs.readFileSync(f, 'utf8');
      const m = txt.match(/^DESKTOP_CONTROL_TOKEN\s*=\s*(.+?)\s*$/m);
      if (m) return m[1].trim();
    } catch {}
  }
  return null;
}
function startDesktop() { return startSidecarOnce('desktop', startDesktopNow); }
async function startDesktopNow(isCurrent) {
  if (desktop || quitting) return;
  if (sidecarDead.desktop) return;
  if (await portOpen(600, DESKTOP_PORT)) return;  // already up (any owner) — adopt, never double
  if (!fs.existsSync(DESKTOP_SCRIPT)) return sidecarUnavailable('desktop', 'script missing');
  if (!handsPy) handsPy = await probeHandsPython();
  if (!isCurrent() || desktop || await portOpen(600, DESKTOP_PORT) || !isCurrent()) return;
  if (!handsPy) return sidecarUnavailable('desktop', 'no python interpreter found');
  const handsToken = readHandsToken();
  if (!handsToken) return sidecarUnavailable('desktop', 'DESKTOP_CONTROL_TOKEN not found (E:/ABU/DESKTOP_CONTROL/.env, home/.env)');
  const fd = fs.openSync(DESKTOP_LOG, 'a');
  desktop = spawn(handsPy.cmd, [...handsPy.pre, DESKTOP_SCRIPT], { windowsHide: true, detached: false, stdio: ['ignore', fd, fd], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', DESKTOP_CONTROL_TOKEN: handsToken } });
  kernelMount('motion-desktop-control', { port: DESKTOP_PORT, pid: desktop.pid, script: DESKTOP_SCRIPT });
  desktop.on('error', (e) => { require('node:fs').appendFileSync(DESKTOP_LOG, `[body] desktop spawn error: ${e && e.message}\n`); });
  const desktopChild = desktop;
  desktopChild.once('close', (code) => { if (desktop !== desktopChild) return; desktop = null; kernelUnmount('motion-desktop-control', `exit code=${code}`); require('node:fs').appendFileSync(DESKTOP_LOG, `[body] desktop exited code=${code}\n`); if (!quitting && !studioHold) sidecarRetry('desktop', startDesktop, 15000); });
}
function stopDesktop() { cancelSidecarStart('desktop'); if (!desktop) return; const d = desktop; desktop = null; kernelUnmount('motion-desktop-control', 'stopDesktop()'); try { d.kill(); } catch {} killPortOwner(DESKTOP_PORT); }
// Studio (Ahmad 2026-09-03 "image/video native"): ComfyUI on GPU0 :8188, owned by
// this body like every other sidecar. Reads models from E:/ABU/MODELS via its
// extra_model_paths.yaml — nothing downloaded, nothing in a terminal.
// 2026-09-04: ComfyUI engine stays on E: (multi-GB studio stack, relocating it buys
// nothing — studio is DEGRADED-if-E-dies by design, never fatal). See FORK.md.
const COMFY_PY = 'E:/ABU/ComfyUI/.venv/Scripts/python.exe';
const COMFY_DIR = 'E:/ABU/ComfyUI';
const COMFY_PORT = kernelPort('media-comfyui', 8188);
const COMFY_LOG = path.join(STATE_DIR, 'comfy.log');
let comfy = null;
function startComfy() { return startSidecarOnce('comfy', startComfyNow); }
async function startComfyNow(isCurrent) {
  if (comfy || quitting) return;
  if (sidecarDead.comfy) { return; }
  if (await portOpen(600, COMFY_PORT)) return;
  if (!isCurrent() || comfy) return;
  if (!fs.existsSync(COMFY_PY) || !fs.existsSync(path.join(COMFY_DIR, 'main.py'))) { return sidecarUnavailable('comfy', 'ComfyUI venv or main.py missing'); }
  const fd = require('node:fs').openSync(COMFY_LOG, 'a');
  comfy = spawn(COMFY_PY, ['main.py', '--listen', '127.0.0.1', '--port', String(COMFY_PORT)],
    { windowsHide: true, detached: false, cwd: COMFY_DIR, stdio: ['ignore', fd, fd], env: { ...process.env, CUDA_VISIBLE_DEVICES: '0' } });
  kernelMount('media-comfyui', { port: COMFY_PORT, pid: comfy.pid });
  comfy.on('error', (e) => { require('node:fs').appendFileSync(COMFY_LOG, `[body] comfy spawn error: ${e && e.message}\n`); });
  const comfyChild = comfy;
  comfyChild.once('close', (code) => { if (comfy !== comfyChild) return; comfy = null; kernelUnmount('media-comfyui', `exit code=${code}`); require('node:fs').appendFileSync(COMFY_LOG, `[body] comfy exited code=${code}\n`); if (!quitting && !studioHold) sidecarRetry('comfy', startComfy, 15000); });
}
function stopComfy() { cancelSidecarStart('comfy'); if (!comfy) return; const c = comfy; comfy = null; try { c.kill(); } catch {} }
// 2026-09-08: the old startDeskControl/stopDeskControl pair was REMOVED. It
// spawned the SAME :8790 server as startDesktop — boot fired both before either
// bound, so every cold start dueled for the port (EADDRINUSE crash loops in
// desktop-control.log, 2026-09-08 05:32). startDesktop + the 20s watchdog own
// :8790 now; the tray restart goes through stopDesktop/startDesktop too.
// Studio mode: image/video jobs need GBs of GPU0 headroom, so the body parks its
// GPU0 residents (vision+voice, deep: +thinker) and brings them back after.
// This is the ONLY way sidecars stop — killing them by hand just respawns them.
async function studioFree(deep) {
  studioHold = true;
  stopVision(); stopVoice(); stopQwen();
  if (deep) stopThinker();
}
async function studioRestore() {
  studioHold = false;
  startVision(); startVoice(); startQwen(); startThinker();
}
// Model-role sidecars boot from the registry (startRole above) — no per-model
// code lives here anymore. studioFree/studioRestore park them the same way.
const DISCOVER = path.join(__dirname, 'brain-discover.cjs');
// Local Model Control (Ahmad 2026-09-03): pick/choose GGUFs on disk, start/stop
// headless, bind into openclaw.json — all inside this app, never a terminal.
let ModelsPanel = null;
try { ModelsPanel = require('./abuz8-models.cjs'); } catch (e) { console.error('[body] models panel failed to load:', e && e.message); }
let panelPort = null;
let modelsWin = null;
function readPrefs() { try { return JSON.parse(require('node:fs').readFileSync(PREFS, 'utf8')); } catch { return null; } }
function setLogin(on) {
  try { app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: [] }); } catch (e) { console.error('[body] login item:', e && e.message); }
  try { require('node:fs').writeFileSync(PREFS, JSON.stringify({ openAtLogin: !!on, updatedAt: new Date().toISOString() }, null, 2)); } catch {}
}
function loginEnabled() { try { return !!app.getLoginItemSettings().openAtLogin; } catch { return false; } }
// Find every brain on this machine (local engines + cloud keys) and bind both bodies to them.
function discoverBrains() {
  try {
    const c = spawn(NODE, [DISCOVER], { windowsHide: true, stdio: 'ignore', detached: false });
    c.on('exit', (code) => { if (code) console.error('[body] brain discovery exit', code); });
  } catch (e) { console.error('[body] discovery failed:', e && e.message); }
}

let win = null;
let tray = null;
let worker = null;
let quitting = false;
let studioHold = false; // Studio mode: parked sidecars stay parked until restore
let gatewayBootReady = false;
let restarts = 0;
let brainRestarts = 0;
let restartTimer = null;
let brainTimer = null;
let crashAt = [];   // timestamps of recent gateway deaths (crash-loop guard)
let crashLoop = false;

// ── one instance only. Two bodies would fight over :18789. ──────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on('second-instance', () => showWindow());

// ── the daemon ──────────────────────────────────────────────────────────────
// 2026-10-04: spawn() NON-DETACHED — child is owned by the parent process,
// dies when the parent dies, killed cleanly with worker.kill(). This is the
// Claude Desktop model: Electron owns the gateway as a supervised child.
// fork() crashes on this box (0xC0000142 DLL init — Electron Node v20 vs
// vendored v24 V8 mismatch on the IPC channel). spawn() without detached
// gives us parent-child ownership without the IPC DLL conflict.
function workerNodeOptions() {
  const inherited = String(process.env.NODE_OPTIONS || '').trim();
  // Preserve an explicit caller-selected heap; otherwise bound the gateway
  // worker to the 4 GiB lane so plugin growth cannot starve Electron.
  if (/(^|\s)--max-old-space-size(?:=|\s)/.test(inherited)) return inherited;
  return [inherited, '--max-old-space-size=4096'].filter(Boolean).join(' ');
}
function startWorker() {
  if (worker || quitting) return;

  try { fs.mkdirSync(path.join(STATE_DIR, 'logs'), { recursive: true }); } catch {}
  worker = spawn(NODE, [WORKER, 'gateway'], {
    cwd: STATE_DIR,
    windowsHide: true,
    stdio: ['ignore',
      fs.openSync(path.join(STATE_DIR, 'logs', 'gateway-worker.out.log'), 'a'),
      fs.openSync(path.join(STATE_DIR, 'logs', 'gateway-worker.err.log'), 'a')],
    env: {
      ...process.env,
      // OPENCLAW_HOME → sovereign root. Upstream appends ".openclaw" itself,
      // so any writes land at .openclaw-OPC-1/.openclaw/ (inside our root),
      // NOT at C:\Users\wirec\.openclaw\ (the shared upstream folder).
      OPENCLAW_HOME: OPC1_ROOT,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_GATEWAY_PORT: String(PORT),
      OPENCLAW_CONFIG_PATH: path.join(STATE_DIR, 'openclaw.json'),
      // SOVEREIGN DOWNFORK: Hermes-style — the update CHECK runs (notify with
      // exact version), but APPLY is structurally dead (config auto.enabled=
      // false + checkOnStart only gates the check). No OPENCLAW_NO_AUTO_UPDATE
      // env: that flag would also silence the check, and Ahmad wants to SEE
      // updates with diffs. Manual panel update is the ONLY apply path.
      XDG_CACHE_HOME: OPC1_CACHE,
      HF_HUB_CACHE: OPC1_HF_CACHE,
      NODE_OPTIONS: workerNodeOptions(),
    },
  });

  worker.on('exit', (code, signal) => {
    worker = null;
    if (quitting) return;
    // Crash-loop guard (no recursive failures): 5 deaths inside 5 minutes means
    // the config/state is poisoned, not the process — stop respawning, say so
    // honestly in the tray, keep window + panel alive for repair. Tray restart
    // clears the guard and tries again.
    const now = Date.now();
    crashAt.push(now);
    while (crashAt.length && now - crashAt[0] > 5 * 60 * 1000) crashAt.shift();
    if (crashAt.length >= 5) {
      crashLoop = true;
      console.error('[body] gateway died 5x in 5min — crash-loop guard engaged, NOT respawning. Repair config, then tray → Restart gateway.');
      updateTray('gateway crash-loop — repair config, then restart');
      try { fs.appendFileSync(path.join(STATE_DIR, 'logs', 'gateway.err'), `[body] crash-loop guard engaged at ${new Date().toISOString()} (code=${code} signal=${signal})\n`); } catch {}
      return;
    }
    // Back off so a config error does not spin the CPU: 2s, 4s, 8s … capped at 30s.
    const wait = Math.min(2000 * Math.pow(2, Math.min(restarts, 4)), 30000);
    restarts += 1;
    console.error(`[body] gateway exited (code=${code} signal=${signal}); restarting in ${wait}ms`);
    updateTray(`restarting in ${Math.round(wait / 1000)}s`);
    restartTimer = setTimeout(startWorker, wait);
  });
}

function stopWorker() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (!worker) return;
  const w = worker;
  worker = null;
  // Non-detached child: worker.kill() sends SIGTERM (Windows: TerminateProcess).
  // No taskkill needed — OS reaps the child tree when the parent owns it.
  try { w.kill(); } catch {}
}

// ── retired executor role ───────────────────────────────────────────────────
// Manual tray fallback only (startBrain above = startRole('executor')). Stopping
// kills our child if we started it, else the port owner. Same path, every role.
function stopBrain() {
  if (brainTimer) { clearTimeout(brainTimer); brainTimer = null; }
  if (!stopRole('executor')) killPortOwner(BRAIN_PORT);
}

// A port number alone is not ownership. Recheck the exact executable and, for
// hands, the exact script before stopping the observed PID. No foreign tree kills.
function killPortOwner(port) {
  const roles = Object.values(loadReg().roles || {});
  const expected = roles.some((r) => Number(r.port) === Number(port)) || Number(port) === BRAIN_PORT
    ? { port: Number(port), executable: LLAMA_EXE, script: null }
    : Number(port) === DESKTOP_PORT
      ? { port: Number(port), executable: handsPy && handsPy.cmd, script: DESKTOP_SCRIPT } : null;
  if (!expected || !expected.executable) return Promise.resolve(false);
  const encoded = Buffer.from(JSON.stringify(expected)).toString('base64');
  try {
    return execFileAsync('pwsh.exe', ['-NoProfile', '-Command',
      `$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; $c = Get-NetTCPConnection -LocalPort $spec.port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; if ($proc -and $proc.ExecutablePath.Replace('/','\\') -eq $spec.executable.Replace('/','\\') -and (!$spec.script -or $proc.CommandLine.Replace('/','\\').Contains($spec.script.Replace('/','\\')))) { Stop-Process -Id $proc.ProcessId -Force; 'killed-owned' } else { 'adopted-foreign' } } else { 'nobody' }`],
      { windowsHide: true, encoding: 'utf8', timeout: 8000 })
      .then(({ stdout }) => { console.error(`[body] port :${port} stop: ${stdout.trim()}`); return stdout.includes('killed-owned'); })
      .catch((e) => { console.error(`[body] port :${port} stop failed: ${e.message}`); return false; });
  } catch { return Promise.resolve(false); }
}

// ── the watchdog: the body keeps its own ports alive. ───────────────────────
// Role entries come from the REGISTRY (ports follow your bindings, not code).
// Every 20s: a closed owned port restarts unless parked for studio mode.
// The gateway has its own crash-loop guard above — the watchdog never fights it.
let WATCH = [
  { port: 8094, start: () => startVoice(),          parked: true  },
  { port: 8095, start: () => startQwen(),           parked: true  },
  { port: 8188, start: () => startComfy(),          parked: true  },
  { port: 8790, start: () => startDesktop(),        parked: false }, // hands: desktop-control
  { port: 8780, start: () => startClibrains(),       parked: false }, // subscription CLI bridge
  { port: PORT, start: () => startWorker(),         parked: false },
];
function buildRoleWatch() {
  try {
    const reg = loadReg();
    for (const [name, role] of Object.entries(reg.roles || {})) {
      if (WATCH.some((w) => w.port === role.port)) continue;
      WATCH.push({ port: role.port, role: name, parked: ['thinker', 'vision'].includes(name), start: () => startRole(name) });
    }
  } catch (e) { console.error('[body] role watch build failed:', e && e.message); }
}
let watchTimer = null;
function watchTick() {
  if (quitting) return;
  Promise.all(WATCH.map(async (w) => {
    if (!gatewayBootReady && w.port !== PORT && !['thinker', 'embedder'].includes(w.role)) return;
    if (await portOpen(600, w.port)) { if (w.port === BRAIN_PORT) brainRestarts = 0; if (w.port === PORT) restarts = 0; return; }
    if (w.parked && studioHold) return;
    if (w.port === PORT && crashLoop) return; // crash-loop guard owns the gateway
    if (w.role && parkedRoles.has(w.role)) return; // panel-parked role: hold the port closed
    await w.start();
  })).catch((e) => console.error('[body] watchdog failed:', e && e.message))
    .finally(() => { if (!quitting) watchTimer = setTimeout(watchTick, 30000); });
}

// ── wait for a port to actually bind before showing the UI ──────────────────
function portOpen(ms = 800, port = PORT) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: ms });
    s.on('connect', () => { try { s.destroy(); } catch {} resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { try { s.destroy(); } catch {} resolve(false); });
  });
}

async function waitForGateway(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Listening is not readiness: the gateway binds before plugin startup ends.
    const ready = await new Promise((resolve) => {
      const req = require('node:http').get(`${URL}startup`, { timeout: 1500 }, (res) => {
        let body = '';
        res.on('data', (chunk) => { if (body.length < 4096) body += chunk; });
        res.on('end', () => { try { const state = JSON.parse(body); resolve(res.statusCode === 200 && state.ok === true && state.status === 'started'); } catch { resolve(false); } });
        res.on('error', () => resolve(false));
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
    if (ready) { restarts = 0; return true; }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

// ── window icon ─────────────────────────────────────────────────────────────
// 2026-09-19: load the blue claw asset once and hand Electron a native image.
// Returns null if the file is missing so the window/tray still boot (never
// crash the body over an icon).
function loadWindowIcon() {
  try {
    if (!fs.existsSync(ICON_PATH)) { console.error('[body] window icon missing:', ICON_PATH); return null; }
    return nativeImage.createFromPath(ICON_PATH);
  } catch (e) {
    console.error('[body] could not load window icon:', e && e.message); return null;
  }
}

// ── window ──────────────────────────────────────────────────────────────────
// 2026-09-30 window lifecycle.
//  * The window exists from t=0 and shows a boot splash with live progress, then
//    navigates to the dashboard when the gateway answers. Before this, nothing
//    appeared for 38-83 s, which reads as "broken".
//  * A window that stays hidden (tray-resident) releases its renderer: the body
//    keeps every daemon alive without a ~345 MB Chromium renderer (plus audio and
//    video-capture utility processes) painting a UI nobody is looking at.
//    Showing it again recreates the window; all state lives in the gateway, and
//    the token hash signs it straight back in.
const SPLASH = path.join(__dirname, 'abuz8-splash.html');
const RELEASE_HIDDEN_MS = Number(process.env.OPC1_RELEASE_HIDDEN_MS || 120000);
let releaseTimer = null;
let bootTimer = null;
let bootStart = Date.now();

function makeWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 320,
    minHeight: 200,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0E1B2E',
    title: 'Zait Desktop',
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });

  // 2026-09-19: the little super blue claw, not the default Electron "E".
  const wicon = loadWindowIcon();
  if (wicon) win.setIcon(wicon);

  win.once('ready-to-show', () => win.show());

  // Zait Desktop branding: the dashboard page sets its own <title>; keep the app title fixed.
  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle('Zait Desktop'); });

  // External links open in the real browser, not inside Zait.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  // Closing the window must NOT kill the daemon — that is the whole point.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  // Hidden long enough -> give the renderer back. destroy() bypasses the close
  // handler above; `closed` nulls `win`, and showWindow() recreates on demand.
  win.on('hide', () => {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isVisible() && !quitting) {
        console.error('[body] window hidden ' + Math.round(RELEASE_HIDDEN_MS / 1000) + 's: releasing renderer');
        try { win.destroy(); } catch {}
      }
    }, RELEASE_HIDDEN_MS);
  });
  win.on('show', () => { clearTimeout(releaseTimer); });

  win.on('closed', () => { clearTimeout(releaseTimer); win = null; });
  return win;
}

// The boot checklist is what the splash renders. Ports come from the same
// sources the watchdog uses (kernel manifests + the registry), never literals.
function bootChecklist() {
  let roles = {};
  try { roles = (loadReg().roles) || {}; } catch {}
  const rp = (n, d) => Number((roles[n] && roles[n].port) || d);
  return [
    { id: 'panel', label: 'Model control panel', port: panelPort },
    { id: 'thinker', label: 'Thinking brain', port: rp('thinker', 8111) },
    { id: 'vision', label: 'Vision', port: rp('vision', 8112) },
    { id: 'embed', label: 'Memory embedder', port: rp('embedder', 8121) },
    { id: 'voice', label: 'Voice', port: VOICE_PORT },
    { id: 'hands', label: 'Desktop control', port: DESKTOP_PORT },
    { id: 'studio', label: 'Studio (images/video)', port: COMFY_PORT },
    { id: 'gateway', label: 'Gateway (the interface)', port: PORT },
    { id: 'memos', label: 'Long-term memory', port: Number(process.env.OPC1_MEMOS_PORT || 18799) },
  ];
}

async function pushBootStatus(extra = {}) {
  if (!win || win.isDestroyed()) return;
  try {
    const items = await Promise.all(bootChecklist().map(async (it) => ({ ...it, up: it.port ? await portOpen(400, it.port) : false })));
    const status = { elapsed: (Date.now() - bootStart) / 1000, items, ...extra };
    await win.webContents.executeJavaScript('window.__boot && window.__boot(' + JSON.stringify(status) + ')', true);
  } catch {}
}

async function showSplash() {
  bootStart = Date.now();
  makeWindow();
  await win.loadFile(SPLASH).catch((e) => console.error('[body] splash failed:', e && e.message));
  if (win && !win.isDestroyed()) win.show();
  clearInterval(bootTimer);
  bootTimer = setInterval(() => { pushBootStatus(); }, 700);
}

function endSplash() { clearInterval(bootTimer); bootTimer = null; }

// Gateway is up: the window (still the splash) becomes the dashboard. A window
// the user already hid stays hidden; a released one is not resurrected.
function createWindow() {
  endSplash();
  if (!win || win.isDestroyed()) { makeWindow(); }
  win.loadURL(dashboardUrl());
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ── Local Models panel (inside this app — no browser, no terminal) ──────────
function panelUrl() { return panelPort ? `http://127.0.0.1:${panelPort}/` : null; }
function showModels() {
  const url = panelUrl();
  if (!url) { dialog.showErrorBox('Local Models', 'The models panel is still starting. Try again in a few seconds.'); return; }
  if (modelsWin && !modelsWin.isDestroyed()) {
    if (modelsWin.isMinimized()) modelsWin.restore();
    modelsWin.show(); modelsWin.focus(); return;
  }
  modelsWin = new BrowserWindow({
    width: 1180, height: 860, minWidth: 860, minHeight: 600,
    show: false, autoHideMenuBar: true, backgroundColor: '#0E1B2E',
    title: 'Zait — Local Models',
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });
  modelsWin.once('ready-to-show', () => modelsWin.show());
  modelsWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (panelPort && u.startsWith(`http://127.0.0.1:${panelPort}`)) return { action: 'allow' };
    shell.openExternal(u); return { action: 'deny' };
  });
  modelsWin.on('closed', () => { modelsWin = null; });
  modelsWin.loadURL(url);
}

// ── tray: the body stays alive here ─────────────────────────────────────────
// The doctor is visible from the tray so the body can be asked what is wrong
// with it without a terminal, and so a bad skeleton announces itself instead of
// waiting to surface as a broken first message.
function doctorLabel() {
  if (!doctorReport) return 'Run self-check (doctor)';
  if (!doctorReport.healthy) return `Self-check: PROBLEM (${doctorReport.fatal.join(', ')}) — run again`;
  return doctorReport.repaired.length
    ? `Self-check: repaired ${doctorReport.repaired.length} — run again`
    : 'Self-check: body intact — run again';
}

function showDoctor(r) {
  if (!r) return;
  const lines = r.checks.map((c) => `${c.ok ? '[ ok ]' : c.severity === 'fatal' ? '[FAIL]' : '[warn]'} ${c.id}\n    ${c.detail}`);
  const body =
    `app:  ${r.appDir}\nhome: ${r.home}\n\n` + lines.join('\n') +
    (r.repaired.length ? `\n\nrepaired:\n  - ${r.repaired.join('\n  - ')}` : '') +
    `\n\nfull report: ${require('./abuz8-doctor.cjs').REPORT_PATH}`;
  if (r.healthy) dialog.showMessageBox({ type: 'info', title: 'Zait self-check — healthy', message: 'The body checked itself and is intact.', detail: body });
  else dialog.showErrorBox('Zait self-check — problem found', body);
}

function updateTray(status) {
  if (!tray) return;
  tray.setToolTip(`Zait — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Zait · :${PORT}`, enabled: false },
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'Open Zait (UI + Terminal)', click: showWindow },
    { label: 'Open Terminal inside Zait', click: () => { showWindow(); setTimeout(() => shell.openExternal(dashboardUrl()), 300); } },
    { label: 'Local Models… (pick your brains)', click: showModels },
    { label: 'Studio (ComfyUI :8188)', click: () => shell.openExternal('http://127.0.0.1:8188/') },
    { label: 'Desktop Control ( :8790 )', click: () => shell.openExternal('http://127.0.0.1:8790/health') },
    { label: 'Restart desktop control ( :8790 )', click: () => { stopDesktop(); setTimeout(startDesktop, 800); } },
    { label: 'Open dashboard in browser', click: () => shell.openExternal(dashboardUrl()) },
    { label: 'Open real-time avatar', click: () => shell.openExternal('http://127.0.0.1:18790/avatar') },
    { type: 'separator' },
    { label: 'Restart gateway', click: () => { crashAt = []; crashLoop = false; stopWorker(); setTimeout(startWorker, 800); } },
    { label: 'Restart thinker role', click: () => { stopThinker(); setTimeout(startThinker, 1500); } },
    { label: 'Start retired executor role manually', click: async () => { if (!(await portOpen(600, BRAIN_PORT))) startBrain(); } },
    { label: 'Rescan brains (local + cloud)', click: discoverBrains },
    { label: doctorLabel(), click: () => { const r = runDoctor(); updateTray(status); showDoctor(r); } },
    { label: 'Launch at login', type: 'checkbox', checked: loginEnabled(), click: (mi) => setLogin(mi.checked) },
    { label: 'Open home folder', click: () => shell.openPath(STATE_DIR) },
    { type: 'separator' },
    { label: 'Quit Zait', click: () => { quitting = true; stopWorker(); stopBrain(); stopThinker(); stopEmbedder(); stopVision(); stopVoice(); stopQwen(); stopClibrains(); stopComfy(); stopDesktop(); try { ModelsPanel && ModelsPanel.stopManaged(); } catch {} app.quit(); } },
  ]));
}

// 2026-09-19: tray uses the little super blue claw, scaled to a crisp 16px
// (the tray never renders the full-size window icon). Falls back to a 16x16
// solid blue square if the asset is missing, so the tray always boots.
function loadTrayIcon() {
  try {
    const big = nativeImage.createFromPath(ICON_PATH);
    if (big && big.width > 0) return big.resize({ width: 16, height: 16 });
  } catch (e) { console.error('[body] tray icon load failed:', e && e.message); }
  const px = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    px[i * 4 + 0] = 0x2C; px[i * 4 + 1] = 0x78; px[i * 4 + 2] = 0xFF; px[i * 4 + 3] = 0xFF; // BGRA electric blue
  }
  return nativeImage.createFromBuffer(px, { width: 16, height: 16 });
}

function createTray() {
  tray = new Tray(loadTrayIcon());
  tray.on('click', showWindow);
  updateTray('starting…');
}

// ── first-run bootstrap ─────────────────────────────────────────────────────
// 2026-09-10 (installer): on a fresh per-user install the state home does not
// exist yet. Create it BEFORE any log open (sidecar logs open with 'a' under
// STATE_DIR), and seed a minimal schema-valid openclaw.json with a FRESH random
// gateway token — never copied from any existing machine. The gateway then
// boots (--allow-unconfigured) and fills in the rest itself.
async function bootstrapState() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) { console.error('[body] could not create state home:', e && e.message); }
  try { fs.mkdirSync(path.join(STATE_DIR, 'logs'), { recursive: true }); } catch {}
  try { fs.mkdirSync(OPC1_CACHE, { recursive: true }); } catch {} // sovereign staging (never shared %LOCALAPPDATA%\openclaw)
  // Owner keys: home\.env feeds every child (worker, voice) that reads
  // process env. Missing-only — never overrides real environment.
  try {
    const envPath = path.join(STATE_DIR, '.env');
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch {}
  // TEMP GC (2026-09-22): upstream writes scratch trees into %TEMP% on every
  // load/update and NEVER removes them. Two families were found, both unbounded:
  //   openclaw-plugin-build-*   1,044 dirs /  82 GB  (~117 dirs, ~21 GB per boot)
  //   openclaw-model-catalog-*     25 dirs /  65 GB  (~3.5 GB EACH)
  // Together they had filled C: to 0 bytes free of 930 GB, which silently breaks
  // sqlite writes ("disk I/O error", doctor "persisted database readiness could
  // not be verified") and is the most likely cause of the flaky boots, slow
  // starts and ws timeouts that were being chased as separate bugs. Clearing both
  // recovered ~137 GB.
  //
  // Cutoff is 1 HOUR, not a day: one boot alone can add ~21 GB, so a day-long
  // window still lets a few restarts refill the disk. This runs before the gateway
  // forks and stages anything, so everything present belongs to an already-dead
  // run; the hour is pure margin against a concurrent sibling install sharing
  // %TEMP% (the home-ownership guard already makes that near-impossible).
  //
  // Prefix-matched deliberately, not a glob on "openclaw-*": only these two are
  // known-disposable. A new leaking family must be added here on purpose, after
  // confirming it is scratch — never guessed at.
  try {
    const tmp = await fs.promises.realpath(os.tmpdir());
    const cutoff = Date.now() - 3600000;
    const DISPOSABLE = ['openclaw-plugin-build-', 'openclaw-model-catalog-'];
    for (const name of await fs.promises.readdir(tmp)) {
      if (!DISPOSABLE.some((prefix) => name.startsWith(prefix))) continue;
      const p = path.join(tmp, name);
      try {
        const real = await fs.promises.realpath(p);
        if (path.dirname(real).toLowerCase() !== tmp.toLowerCase()) continue;
        if ((await fs.promises.stat(p)).mtimeMs < cutoff) await fs.promises.rm(p, { recursive: true, force: true });
      } catch { /* in use by a live run, or already gone — skip */ }
    }
  } catch { /* GC is best-effort; never block boot on it */ }
  // ORPHAN REAPER (2026-09-30). A role model started by a previous body run
  // SURVIVES that run: startRole spawns with detached:false, so when the body
  // dies the llama-server is re-parented to init and keeps holding its VRAM.
  //
  // Why this matters more than it looks: the watchdog only checks whether the
  // role's port is LISTENING (portOpen), never whether the listener is OURS.
  // A survivor from a dead run therefore satisfies the watchdog forever, and
  // the body happily reports the role "up" while serving a model it never
  // started and never configured. Measured on this box 2026-09-30: an orphan
  // left :8011 running with a pre-9/26 profile (ctx 524288, --parallel 2,
  // --cache-type q8_0) after the registry had already moved to 256000/1/q4_0.
  // Its KV demand was ~96 GB against ~12 GB for the intended profile, and it
  // drove GPU1 to 92 MiB free of 32 GB — which is what made every brain
  // sluggish and every fresh load fail. The registry "fix" from 9/26 never took
  // effect for exactly this reason: nothing ever replaced the survivor.
  //
  // Scope: ONLY the role ports declared in the registry, and ONLY when the
  // listener is a llama-server we can attribute to this install. A foreign
  // product's model on our port number is left alone and logged, never killed
  // (Law of the Folder: OPC-1 does not reach into Qadir/DIST/Buraq/Malki).
  try {
    const reg = loadReg();
    const rolePorts = Object.values(reg.roles || {}).map((role) => Number(role.port)).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
    const probe = await execFileAsync('pwsh.exe', ['-NoProfile', '-Command',
      `$rolePorts = @(${rolePorts.join(',')}); @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $rolePorts -contains $_.LocalPort } | ForEach-Object { $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($proc) { [pscustomobject]@{port=$_.LocalPort;name=$proc.ProcessName;executable=$proc.Path} } }) | ConvertTo-Json -Compress`],
      { windowsHide: true, encoding: 'utf8', timeout: 8000 });
    const rows = JSON.parse(probe.stdout.trim() || '[]');
    const listeners = Array.isArray(rows) ? rows : [rows];
    for (const [name, role] of Object.entries(reg.roles || {})) {
      const port = Number(role.port);
      if (!port) continue;
      const listener = listeners.find((row) => Number(row.port) === port);
      if (!listener) continue;
      const procName = listener.name, exePath = listener.executable;
      if (!/llama-server/i.test(procName || '')) continue;
      // Ours only if the binary lives in this install's engine dir. Otherwise
      // it is another product sharing the port - report, do not touch.
      const ours = exePath && path.resolve(exePath).toLowerCase() === path.resolve(LLAMA_EXE).toLowerCase();
      if (!ours) {
        console.error(`[body] port ${port} (role ${name}) held by a FOREIGN llama-server (${exePath}) - left alone`);
        continue;
      }
      console.error(`[body] reaping orphan role model on :${port} (${name}) left by a previous body run`);
      await killPortOwner(port);
    }
  } catch (e) { console.error('[body] orphan reaper skipped:', e && e.message); }
  // First-run seed below (same function): minimal schema-valid openclaw.json.
  const cfgPath = path.join(STATE_DIR, 'openclaw.json');
  if (fs.existsSync(cfgPath)) return;
  const seed = {
    gateway: { port: PORT, auth: { token: require('node:crypto').randomBytes(24).toString('hex') } },
    agents: { entries: { zait: { name: 'Zait' } } },
  };
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(seed, null, 2));
    console.error('[body] seeded fresh openclaw.json (new random gateway token)');
  } catch (e) { console.error('[body] could not seed openclaw.json:', e && e.message); }
}

// ── self-repair preflight ───────────────────────────────────────────────────
// 2026-09-16: the body checks its own skeleton every launch and restores what
// is missing (workspace templates from the sealed vault, a corrupt openclaw.json
// from its newest good backup) BEFORE the gateway starts. This is what turned
// the 09-15 template scrub from a dead first message into a self-healed boot.
// It can never block the boot: any doctor failure is logged and we carry on.
// 2026-09-16: anchor the working directory to the install before anything
// resolves a path. Windows Run-key autostart hands us cwd=C:\WINDOWS\system32,
// and a script that did `cd` somewhere first hands us whatever it was in. Both
// template lookup and sidecar script lookup consult cwd, so an unanchored body
// can quietly read another tree's files. Cheap, and it ends that whole class.
const INSTALL_ROOT = path.resolve(__dirname, '..', '..');
function anchorCwd() {
  try {
    const before = process.cwd();
    if (path.resolve(before).toLowerCase() !== INSTALL_ROOT.toLowerCase()) {
      process.chdir(INSTALL_ROOT);
      console.error(`[body] cwd anchored: ${before} → ${INSTALL_ROOT}`);
    }
  } catch (e) { console.error('[body] could not anchor cwd:', e && e.message); }
}

let doctorReport = null;
function runDoctor() {
  try {
    doctorReport = require('./abuz8-doctor.cjs').run({ repair: true });
    for (const r of doctorReport.repaired) console.error('[doctor] repaired: ' + r);
    if (!doctorReport.healthy) {
      for (const id of doctorReport.fatal) {
        const c = doctorReport.checks.find((x) => x.id === id);
        console.error('[doctor] FATAL ' + id + ': ' + (c && c.detail));
      }
    } else if (!doctorReport.repaired.length) {
      console.error('[doctor] body intact');
    }
  } catch (e) {
    console.error('[doctor] preflight itself failed (boot continues):', e && e.message);
  }
  return doctorReport;
}

// ── boot ────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  anchorCwd();      // FIRST: never resolve a path from someone else's directory
  await showSplash(); // Paint before synchronous bootstrap and doctor work.
  await bootstrapState(); // THEN: state home must exist before any log open
  runDoctor();      // THEN: repair the skeleton before anything reads it

  // A body that does not own this home does not get to start. On 2026-09-16 the
  // leftover C:\Temp smoke copy was launched with no OPC1_HOME, adopted the real
  // Zait's home, and ran temp-tree code against it for eight hours. Booting on
  // was the damage; stopping here is the fix.
  if (doctorReport && doctorReport.homeHijack) {
    const c = doctorReport.checks.find((x) => x.id === 'home-ownership') || {};
    console.error('[body] REFUSING TO START — ' + c.detail);
    updateTray('stopped: this home belongs to another install');
    dialog.showErrorBox(
      'Zait stopped — wrong home',
      `This copy of Zait is running from:\n  ${INSTALL_ROOT}\n\n` +
      `but the home it was about to use belongs to:\n  ${c.ownedBy}\n\n` +
      `Starting would have overwritten the real Zait's config, state and sidecar ports.\n\n` +
      `If this copy is meant to run side by side, give it its own home with OPC1_HOME.\n` +
      `If you really mean to take this home over, set OPC1_ADOPT_HOME=1.`
    );
    app.quit();
    return;
  }
  // Start with Windows like Claude Desktop — but it is a toggle (tray → Launch at login).
  const prefs = readPrefs();
  setLogin(prefs ? !!prefs.openAtLogin : true);

  createTray();
  buildRoleWatch();   // registry role ports join the watchdog (ports follow bindings)
  if (ModelsPanel) {
    try {
      const { port } = await ModelsPanel.startPanelServer({
        onRestartGateway: () => { crashAt = []; crashLoop = false; stopWorker(); setTimeout(startWorker, 800); },
        onDiscover: () => discoverBrains(),
        onStudio: (action, body) => {
          if (action === 'free') studioFree(body && body.deep);
          else studioRestore();
        },
        onPark: (role, on) => parkRole(role, on),
      });
      panelPort = port;
      if (port) console.error(`[body] local-models panel on 127.0.0.1:${port}`);
      // isnad ledger: incremental sync (takes the ledger write lock, anchors off-volume).
      // First run after the boot storm settles, then every 15 min. Never throws.
      const runIsnad = () => {
        Promise.resolve(ModelsPanel.isnadSync && ModelsPanel.isnadSync()).then((r) => {
          if (r && r.ok) console.error(`[isnad] sync ok: +${r.new_chunks || 0} memories, +${r.new_lessons || 0} lessons, ${r.regraded || 0} regraded, ${r.ms}ms`);
          else console.error('[isnad] sync problem: ' + JSON.stringify(r).slice(0, 300));
        }).catch((e) => console.error('[isnad] sync failed:', e && e.message));
      };
      // the directory (skills/mcp/http/connectors/services catalogs) rebuilds on the same cadence
      const runDirectory = () => {
        Promise.resolve(ModelsPanel.directoryBuild && ModelsPanel.directoryBuild()).then((r) => {
          if (r && r.ok) console.error(`[directory] rebuilt: ${r.entries} entries (${Object.entries(r.domains || {}).map(([k, v]) => k + ':' + v).join(' ')}) ${r.ms}ms`);
          else console.error('[directory] build problem: ' + JSON.stringify(r).slice(0, 300));
        }).catch((e) => console.error('[directory] build failed:', e && e.message));
      };
      setTimeout(() => { runIsnad(); runDirectory(); }, 90 * 1000);
      setInterval(() => { runIsnad(); runDirectory(); }, 60 * 60 * 1000);
    } catch (e) { console.error('[body] models panel failed:', e && e.message); }
  }
  // Defer brain discovery 30s so sidecars settle before we probe 50+ ports.
  setTimeout(() => { discoverBrains(); setInterval(discoverBrains, 30 * 60 * 1000); }, 30000);
  // Gateway-first boot avoids allocating every CUDA consumer at once. Each
  // phase is independent and the existing watchdog retries failed lanes.
  const scheduleBootPhase = (label, delayMs, fn) => setTimeout(() => {
    if (quitting) return;
    try {
      Promise.resolve(fn()).catch((e) => console.error(`[body] boot phase ${label} failed:`, e && e.message));
    } catch (e) {
      console.error(`[body] boot phase ${label} failed:`, e && e.message);
    }
  }, delayMs);
  startWorker();
  startThinker(); startEmbedder();
  watchTick();          // 30s port watchdog: the body keeps every owned port alive

  const up = await waitForGateway();
  if (!up) {
    endSplash();
    await pushBootStatus({ failed: 'The gateway did not become ready within 180 seconds. It keeps retrying in the background; use the tray icon to restart it.' });
    updateTray('gateway did not start');
    dialog.showErrorBox(
      'Zait could not start',
      `The gateway did not become ready on 127.0.0.1:${PORT} within 180 seconds.\n\n` +
      `Home: ${STATE_DIR}\n\n` +
      `It will keep retrying in the background. Use the tray icon to restart it.`
    );
    return;
  }

  updateTray('running');
  gatewayBootReady = true;
  scheduleBootPhase('voice', 0, () => Promise.all([startVoice(), startQwen()]));
  scheduleBootPhase('studio', 250, () => Promise.all([startComfy(), startDesktop()]));
  scheduleBootPhase('subscriptions', 500, () => startClibrains());
  scheduleBootPhase('vision', 750, () => startVision());
  createWindow();
});

app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('activate', showWindow);
app.on('before-quit', () => {
  quitting = true;
  stopWorker(); stopBrain(); stopThinker(); stopEmbedder(); stopVision(); stopVoice(); stopQwen(); stopClibrains(); stopComfy(); stopDesktop();
  try { ModelsPanel && ModelsPanel.stopManaged(); } catch {}
});
