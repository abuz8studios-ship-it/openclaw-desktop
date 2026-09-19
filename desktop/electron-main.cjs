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
const { fork, spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

// OPENCLAW_HOME is the USER home — OpenClaw appends ".openclaw" itself.
// 2026-09-04 (permanent home): state lives in the sovereign root's home\ room.
// 2026-09-10 (installer): OPC1 root resolves from OPC1_HOME env, else the OS
// user home — never a hardcoded machine path. E: mirrors stay OPTIONAL extras.
const os = require('node:os');
const OPC1_ROOT = process.env.OPC1_HOME || path.join(os.homedir(), '.openclaw-OPC-1');
const USER_HOME = path.dirname(OPC1_ROOT);
const STATE_DIR = path.join(OPC1_ROOT, 'home');
const ELECTRON_USER_DATA = path.join(OPC1_ROOT, 'electron-user-data');
const PORT = Number(process.env.OPC1_GATEWAY_PORT || 18789);
const URL = `http://127.0.0.1:${PORT}/`;
const WORKER = path.join(__dirname, 'abuz8-daemon-worker.cjs');

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

// Retired executor lane. Kept only for manual fallback; the body does not
// auto-start :8001. Ornith :8011 is the primary brain.
const BRAIN_CMD = path.join(OPC1_ROOT, 'body', 'ops', 'start_brain_nemotron.ps1');
const BRAIN_PORT = 8001;
const PREFS = path.join(STATE_DIR, 'body-prefs.json');
// The one NEEDED sidecar (Ahmad 2026-09-02): a shared embedder for memory search.
// nomic-embed on the C:-vendored llama-server binary, GPU0, ~300 MB. Weights stay on E: (weights-only rule).
const EMBED_EXE = firstExisting([
  path.join(RESOURCES, 'engine', 'llama-server.exe'),
  path.join(OPC1_ROOT, 'runtime', 'llama', 'llama-server.exe'),
]);
const EMBED_MODEL = firstExisting([
  'E:/ABU/MODELS/llm/nomic-embed/nomic-embed-text-v1.5.f16.gguf',
]);
const EMBED_PORT = 8021;
const EMBED_LOG = path.join(STATE_DIR, 'embedder.log');
let embed = null;
// 2026-09-10 (installer): a sidecar whose engine/weights are missing on this
// machine is marked "unavailable" after a bounded number of tries instead of
// crash-looping forever (gap 9). The 20s watchdog respects the marker.
const sidecarFails = {};
const sidecarDead = {};
function sidecarUnavailable(name, reason) {
  if (!sidecarDead[name]) { sidecarDead[name] = reason; console.error(`[body] sidecar ${name} unavailable: ${reason}`); }
  recordSidecar(name, 'unavailable', reason);
}
// 2026-09-11: honest sidecar status for the model panel. The panel reads
// home\sidecars.json and shows "not installed — why" instead of a bare red dot.
const SIDECARS_JSON = path.join(STATE_DIR, 'sidecars.json');
function recordSidecar(name, state, reason) {
  try {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(SIDECARS_JSON, 'utf8')); } catch {}
    j[name] = { state, reason: reason || null, at: new Date().toISOString() };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SIDECARS_JSON, JSON.stringify(j, null, 2));
  } catch {}
}
function sidecarRetry(name, fn, ms) {
  sidecarFails[name] = (sidecarFails[name] || 0) + 1;
  if (sidecarFails[name] >= 5) return sidecarUnavailable(name, 'gave up after 5 failed starts');
  setTimeout(fn, ms);
}
async function startEmbedder() {
  if (embed || quitting) return;
  if (sidecarDead.embedder) return;
  if (await portOpen(600, EMBED_PORT)) return;  // already up (any owner) — never a second copy
  if (!fs.existsSync(EMBED_EXE) || !fs.existsSync(EMBED_MODEL)) return sidecarUnavailable('embedder', 'engine or weights missing');
  const logFd = require('node:fs').openSync(EMBED_LOG, 'a');
  embed = spawn(EMBED_EXE, ['-m', EMBED_MODEL, '--host', '127.0.0.1', '--port', String(EMBED_PORT), '--embeddings', '--pooling', 'mean',
    '-c', '2048', '-ngl', '999', '--parallel', '2', '--threads', '4', '--alias', 'nomic-embed-text-v1.5'],
    { windowsHide: true, detached: false, stdio: ['ignore', logFd, logFd], env: { ...process.env, CUDA_VISIBLE_DEVICES: '0' } });
  embed.on('error', (e) => { require('node:fs').appendFileSync(EMBED_LOG, `[body] embedder spawn error: ${e && e.message}
`); });
  embed.on('exit', (code) => { embed = null; require('node:fs').appendFileSync(EMBED_LOG, `[body] embedder exited code=${code}
`); if (!quitting && !studioHold) sidecarRetry('embedder', startEmbedder, 15000); });
}
function stopEmbedder() { if (!embed) return; const e = embed; embed = null; try { e.kill(); } catch {} }
// Eyes (Ahmad 2026-09-02 "full vision"): gemma-4-E4B + mmproj on GPU0 :8012. Nemotron is text-only,
// so both agents send images here. Same rule: only start it if nothing answers on :8012.
const VISION_MODEL = firstExisting(['E:/ABU/MODELS/llm/gemma-4-E4B/gemma-4-E4B-it-Q4_K_M.gguf']);
const VISION_MMPROJ = 'E:/ABU/MODELS/llm/gemma-4-E4B/mmproj-F16.gguf';
const VISION_PORT = 8012;
const VISION_LOG = path.join(STATE_DIR, 'vision.log');
let vision = null;
async function startVision() {
  if (vision || quitting) return;
  if (sidecarDead.vision) return;
  if (await portOpen(600, VISION_PORT)) return;
  if (!fs.existsSync(EMBED_EXE) || !fs.existsSync(VISION_MODEL) || !fs.existsSync(VISION_MMPROJ)) return sidecarUnavailable('vision', 'engine or weights missing');
  const fd = require('node:fs').openSync(VISION_LOG, 'a');
  vision = spawn(EMBED_EXE, ['-m', VISION_MODEL, '--mmproj', VISION_MMPROJ, '--host', '127.0.0.1', '--port', String(VISION_PORT),
    '-c', '16384', '-ngl', '999', '--parallel', '2', '--alias', 'gemma-4-e4b-vision', '--jinja', '--reasoning-budget', '0'],
    { windowsHide: true, detached: false, stdio: ['ignore', fd, fd], env: { ...process.env, CUDA_VISIBLE_DEVICES: '0' } });
  vision.on('error', (e) => { require('node:fs').appendFileSync(VISION_LOG, `[body] vision spawn error: ${e && e.message}
`); });
  vision.on('exit', (code) => { vision = null; require('node:fs').appendFileSync(VISION_LOG, `[body] vision exited code=${code}
`); if (!quitting && !studioHold) sidecarRetry('vision', startVision, 15000); });
}
function stopVision() { if (!vision) return; const v = vision; vision = null; try { v.kill(); } catch {} }
// Mouth + ears (Ahmad 2026-09-02 "full voice"): Kokoro TTS + Parakeet ASR, OpenAI-compatible on :8094.
// 2026-09-11 (installer): resolution chain — voice is NEVER a hard requirement:
//   1. PyInstaller voice pack  <OPC1_ROOT>\runtime\voice\dist\abuz8-voice\abuz8-voice.exe
//   2. Provisioned script      <OPC1_ROOT>\runtime\voice\voice_server.py + Python 3.11
// The script half self-seeds from the vendored copy (resources\app\vendor\voice)
// on first boot. Whatever is missing is reported HONESTLY in home\sidecars.json
// (the model panel renders reason + fix) — the body keeps booting; voice is
// degraded, never fatal, never a crash loop.
const VOICE_BUNDLE = path.join(OPC1_ROOT, 'runtime', 'voice', 'dist', 'abuz8-voice', 'abuz8-voice.exe');
const VOICE_SCRIPT = path.join(OPC1_ROOT, 'runtime', 'voice', 'voice_server.py');
const VOICE_VENDOR_SCRIPT = path.join(__dirname, 'vendor', 'voice', 'voice_server.py');
const VOICE_PY_CANDIDATES = [process.env.OPC1_PYTHON, 'C:/Program Files/Python311/python.exe', 'C:/Python311/python.exe'].filter(Boolean);
const VOICE_PORT = Number(process.env.OPC1_VOICE_PORT || 8094);
const VOICE_LOG = path.join(STATE_DIR, 'voice.log');
let voice = null;
function seedVoiceScript() {
  try {
    if (!fs.existsSync(VOICE_SCRIPT) && fs.existsSync(VOICE_VENDOR_SCRIPT)) {
      fs.mkdirSync(path.dirname(VOICE_SCRIPT), { recursive: true });
      fs.copyFileSync(VOICE_VENDOR_SCRIPT, VOICE_SCRIPT);
      console.log('[body] seeded voice script from vendor ->', VOICE_SCRIPT);
    }
  } catch (e) { console.error('[body] voice seed failed:', e && e.message); }
}
function voiceRuntime() {
  if (fs.existsSync(VOICE_BUNDLE)) return { cmd: VOICE_BUNDLE, args: [], via: 'voice pack bundle' };
  const py = VOICE_PY_CANDIDATES.find((p) => fs.existsSync(p));
  if (py && fs.existsSync(VOICE_SCRIPT)) return { cmd: py, args: [VOICE_SCRIPT], via: py };
  return null;
}
async function startVoice() {
  if (voice || quitting) return;
  if (sidecarDead.voice) return;
  if (await portOpen(600, VOICE_PORT)) return;
  seedVoiceScript();
  const rt = voiceRuntime();
  if (!rt) return sidecarUnavailable('voice', 'voice pack not installed (no abuz8-voice.exe, no Python 3.11 + voice_server.py)');
  const fd = require('node:fs').openSync(VOICE_LOG, 'a');
  voice = spawn(rt.cmd, rt.args, { windowsHide: true, detached: false, stdio: ['ignore', fd, fd], env: { ...process.env, VOICE_PORT: String(VOICE_PORT), PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
  recordSidecar('voice', 'running', 'spawned via ' + rt.via);
  voice.on('error', (e) => { require('node:fs').appendFileSync(VOICE_LOG, `[body] voice spawn error: ${e && e.message}
`); });
  voice.on('exit', (code) => { voice = null; require('node:fs').appendFileSync(VOICE_LOG, `[body] voice exited code=${code}
`); recordSidecar('voice', 'down', 'exited code=' + code); if (!quitting && !studioHold) sidecarRetry('voice', startVoice, 15000); });
}
function stopVoice() { if (!voice) return; const v = voice; voice = null; try { v.kill(); } catch {} }
// 2026-09-11: the panel's one-click voice lane calls this when the voice pack
// finishes installing (or the user hits "Start voice"). A sidecar marked
// unavailable at boot (no pack, no Python) must get a second chance WITHOUT an
// app restart — clear the dead marker and let startVoice re-resolve.
function voiceInstalled() {
  delete sidecarDead.voice;
  sidecarFails.voice = 0;
  recordSidecar('voice', 'starting', 'voice pack installed from panel — starting');
  startVoice();
}
// HANDS (Ahmad 2026-09-07 "fuse the desktop system"): the desktop-control server
// (:8790, E:\ABU\DESKTOP_CONTROL\python\server.py) is the OS-level hands for Zait
// (36 tools: desktop_* + chrome_*). It used to be a manual orphan started by hand —
// now the body owns it like every other sidecar: start at boot, watchdog keeps it
// alive, quit stops it. Same rules: only start if nothing answers on :8790.
const DESKTOP_PY = 'C:/Program Files/Python311/python.exe';
const DESKTOP_SCRIPT = 'E:/ABU/DESKTOP_CONTROL/python/server.py';
const DESKTOP_PORT = 8790;
const DESKTOP_LOG = path.join(STATE_DIR, 'desktop-control.log');
let desktop = null;
async function startDesktop() {
  if (desktop || quitting) return;
  if (sidecarDead.desktop) return;
  if (await portOpen(600, DESKTOP_PORT)) return;  // already up (any owner) — adopt, never double
  if (!fs.existsSync(DESKTOP_PY) || !fs.existsSync(DESKTOP_SCRIPT)) return sidecarUnavailable('desktop', 'python or script missing');
  const fd = require('node:fs').openSync(DESKTOP_LOG, 'a');
  desktop = spawn(DESKTOP_PY, [DESKTOP_SCRIPT], { windowsHide: true, detached: false, stdio: ['ignore', fd, fd], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
  desktop.on('error', (e) => { require('node:fs').appendFileSync(DESKTOP_LOG, `[body] desktop spawn error: ${e && e.message}\n`); });
  desktop.on('exit', (code) => { desktop = null; require('node:fs').appendFileSync(DESKTOP_LOG, `[body] desktop exited code=${code}\n`); if (!quitting && !studioHold) sidecarRetry('desktop', startDesktop, 15000); });
}
function stopDesktop() { if (!desktop) return; const d = desktop; desktop = null; try { d.kill(); } catch {} killPortOwner(DESKTOP_PORT); }
// Studio (Ahmad 2026-09-03 "image/video native"): ComfyUI on GPU0 :8188, owned by
// this body like every other sidecar. Reads models from E:/ABU/MODELS via its
// extra_model_paths.yaml — nothing downloaded, nothing in a terminal.
// 2026-09-04: ComfyUI engine stays on E: (multi-GB studio stack, relocating it buys
// nothing — studio is DEGRADED-if-E-dies by design, never fatal). See FORK.md.
const COMFY_PY = 'E:/ABU/ComfyUI/.venv/Scripts/python.exe';
const COMFY_DIR = 'E:/ABU/ComfyUI';
const COMFY_PORT = 8188;
const COMFY_LOG = path.join(STATE_DIR, 'comfy.log');
let comfy = null;
async function startComfy() {
  if (comfy || quitting) return;
  if (sidecarDead.comfy) return;
  if (await portOpen(600, COMFY_PORT)) return;
  if (!fs.existsSync(COMFY_PY) || !fs.existsSync(path.join(COMFY_DIR, 'main.py'))) return sidecarUnavailable('comfy', 'ComfyUI venv or main.py missing');
  const fd = require('node:fs').openSync(COMFY_LOG, 'a');
  comfy = spawn(COMFY_PY, ['main.py', '--listen', '127.0.0.1', '--port', String(COMFY_PORT)],
    { windowsHide: true, detached: false, cwd: COMFY_DIR, stdio: ['ignore', fd, fd], env: { ...process.env, CUDA_VISIBLE_DEVICES: '0' } });
  comfy.on('error', (e) => { require('node:fs').appendFileSync(COMFY_LOG, `[body] comfy spawn error: ${e && e.message}\n`); });
  comfy.on('exit', (code) => { comfy = null; require('node:fs').appendFileSync(COMFY_LOG, `[body] comfy exited code=${code}\n`); if (!quitting && !studioHold) sidecarRetry('comfy', startComfy, 15000); });
}
function stopComfy() { if (!comfy) return; const c = comfy; comfy = null; try { c.kill(); } catch {} }
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
  stopVision(); stopVoice();
  if (deep) stopThinker();
}
async function studioRestore() {
  studioHold = false;
  startVision(); startVoice(); startThinker();
}
// THINKER (Ahmad 2026-09-02 "Ornith as thinker"): Ornith 1.5 35B-A3B on :8011, split across both GPUs.
// Nemotron :8001 stays the executor. Same rule: start only if nothing answers on :8011.
const THINKER_CMD = path.join(OPC1_ROOT, 'body', 'ops', 'start_brain_ornith.ps1');
const THINKER_PORT = 8011;
let thinker = null;
async function startThinker() {
  if (thinker || quitting) return;
  if (await portOpen(600, THINKER_PORT)) return;
  thinker = spawn('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', THINKER_CMD], { windowsHide: true, detached: false, stdio: 'ignore' });
  thinker.on('exit', (code) => { thinker = null; if (!quitting && !studioHold) setTimeout(startThinker, 20000); });
}
function stopThinker() { if (!thinker) { killPortOwner(THINKER_PORT); return; } const t = thinker; thinker = null; try { spawn('taskkill', ['/PID', String(t.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} killPortOwner(THINKER_PORT); }
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
let brain = null;
let quitting = false;
let studioHold = false; // Studio mode: parked sidecars stay parked until restore
let restarts = 0;
let brainRestarts = 0;
let restartTimer = null;
let brainTimer = null;

// ── one instance only. Two bodies would fight over :18789. ──────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.on('second-instance', () => showWindow());

// ── the daemon ──────────────────────────────────────────────────────────────
function startWorker() {
  if (worker || quitting) return;

  // argv 'gateway': the worker serves the gateway, so it declares itself as such.
  // Plugins (memos-local viewer/hub/skill-recovery) gate their services on this.
  worker = fork(WORKER, ['gateway'], {
    execPath: NODE,
    silent: false,
    env: {
      ...process.env,
      // OpenClaw resolves OPENCLAW_HOME as a parent and appends .openclaw.
      // Keep the OS user home here; the sovereign state room is explicit below.
      OPENCLAW_HOME: USER_HOME,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_GATEWAY_PORT: String(PORT),
      OPENCLAW_CONFIG_PATH: path.join(STATE_DIR, 'openclaw.json'),
    },
  });

  worker.on('message', (m) => {
    if (m && m.type === 'error') console.error('[body] gateway error:', m.message);
  });

  worker.on('exit', (code, signal) => {
    worker = null;
    if (quitting) return;
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
  try { worker.send({ type: 'shutdown' }); } catch {}
  const w = worker;
  worker = null;
  setTimeout(() => { try { w.kill(); } catch {} }, 2500);
}

// ── Zait's brain ────────────────────────────────────────────────────────────
// 2026-09-06: the launcher ps1 exits right after spawning llama-server, so the
// pwsh pid the body tracks dies in seconds. Killing it killed NOTHING — the
// real server survived quit/restart (proven: :8001 stayed up after app quit).
// All stops are now PORT-OWNER kills: deterministic, engine-agnostic, and the
// same path for every sidecar. A watchdog (below) makes the body never-dies.
async function startBrain() {
  if (brain || quitting) return;
  // Never start a second llama-server on top of a healthy one (Nemotron may already run on its own engine).
  if (await portOpen(600, BRAIN_PORT)) { brainRestarts = 0; return; }

  brain = spawn('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BRAIN_CMD], {
    windowsHide: true,
    detached: false,
    stdio: 'ignore',
  });

  brain.on('exit', (code) => {
    // The pwsh launcher exits right after Start-Process (Nemotron ps1 has no -Wait).
    // Do NOT respawn here — that raced a second engine into the port (proven twice).
    // The watchdog (20s) owns recovery: it waits for the port and only then restarts.
    brain = null;
    if (quitting) return;
    require('node:fs').appendFileSync(path.join(STATE_DIR, 'logs', 'brain_nemotron.err.log'),
      `[body] launcher exited code=${code} — recovery owned by watchdog\n`);
  });
}

function stopBrain() {
  if (brainTimer) { clearTimeout(brainTimer); brainTimer = null; }
  if (brain) { const b = brain; brain = null; try { b.kill(); } catch {} }
  killPortOwner(BRAIN_PORT);
}

// Port-owner kill: find the process LISTENING on a port and kill its tree.
// This is the one deterministic way to stop llama-server (grandchild of pwsh
// that already exited) and every other sidecar. Only touches our ports.
function killPortOwner(port) {
  try {
    const k = spawn('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match 'llama-server|python|node') { taskkill /PID $($c.OwningProcess) /T /F | Out-Null; 'killed:' + $c.OwningProcess } else { 'skipped:' + $p.ProcessName } } else { 'nobody' }`],
      { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => {});
  } catch {}
}

// ── the watchdog: the body keeps its own ports alive. LM Studio behavior. ────
// Every 20s: if a port we own is closed and we are not quitting (and the
// sidecar is not parked for studio mode), start it back. Exits the restart
// loops: nothing can stay down while the app is alive.
const WATCH = [
  { port: 8011, start: () => startThinker(),        parked: true  }, // deep studio parks the thinker
  { port: 8012, start: () => startVision(),         parked: true  },
  { port: 8021, start: () => startEmbedder(),       parked: false },
  { port: VOICE_PORT, start: () => startVoice(),    parked: true  },
  { port: 8188, start: () => startComfy(),          parked: true  },
  { port: 8790, start: () => startDesktop(),        parked: false }, // hands: desktop-control
  { port: PORT, start: () => startWorker(),         parked: false },
];
let watchTimer = null;
function watchTick() {
  if (quitting) return;
  Promise.all(WATCH.map(async (w) => {
    if (await portOpen(600, w.port)) { if (w.port === BRAIN_PORT) brainRestarts = 0; if (w.port === PORT) restarts = 0; return; }
    if (w.parked && studioHold) return;
    w.start();
  })).finally(() => { watchTimer = setTimeout(watchTick, 20000); });
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

async function waitForGateway(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen()) { restarts = 0; return true; }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

// ── window ──────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0E1B2E',
    title: 'Zait Desktop',
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });

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

  win.on('closed', () => { win = null; });
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
    { type: 'separator' },
    { label: 'Restart gateway', click: () => { stopWorker(); setTimeout(startWorker, 800); } },
    { label: 'Restart thinker brain (Ornith :8011)', click: () => { stopThinker(); setTimeout(startThinker, 1500); } },
    { label: 'Start retired Nemotron :8001 manually', click: async () => { if (!(await portOpen(600, BRAIN_PORT))) startBrain(); } },
    { label: 'Rescan brains (local + cloud)', click: discoverBrains },
    { label: 'Launch at login', type: 'checkbox', checked: loginEnabled(), click: (mi) => setLogin(mi.checked) },
    { label: 'Open home folder', click: () => shell.openPath(STATE_DIR) },
    { type: 'separator' },
    { label: 'Quit Zait', click: () => { quitting = true; stopWorker(); stopBrain(); stopThinker(); stopEmbedder(); stopVision(); stopVoice(); stopComfy(); stopDesktop(); try { ModelsPanel && ModelsPanel.stopManaged(); } catch {} app.quit(); } },
  ]));
}

function createTray() {
  // 16x16 gold square — no external asset, so the tray can never fail to load.
  const px = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    px[i * 4 + 0] = 0x5C; px[i * 4 + 1] = 0xA5; px[i * 4 + 2] = 0xC8; px[i * 4 + 3] = 0xFF; // BGRA
  }
  tray = new Tray(nativeImage.createFromBuffer(px, { width: 16, height: 16 }));
  tray.on('click', showWindow);
  updateTray('starting…');
}

// ── first-run bootstrap ─────────────────────────────────────────────────────
// 2026-09-10 (installer): on a fresh per-user install the state home does not
// exist yet. Create it BEFORE any log open (sidecar logs open with 'a' under
// STATE_DIR), and seed a minimal schema-valid openclaw.json with a FRESH random
// gateway token — never copied from any existing machine. The gateway then
// boots (--allow-unconfigured) and fills in the rest itself.
function bootstrapState() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) { console.error('[body] could not create state home:', e && e.message); }
  try { fs.mkdirSync(path.join(STATE_DIR, 'logs'), { recursive: true }); } catch {}
  const cfgPath = path.join(STATE_DIR, 'openclaw.json');
  if (fs.existsSync(cfgPath)) return false;
  const seed = {
    gateway: { port: PORT, auth: { token: require('node:crypto').randomBytes(24).toString('hex') } },
    agents: {
      // 2026-09-11: NO null model fields — gateway 2026.9.2 schema rejects
      // agents.defaults.model.primary: null (boot loop, exit 78). Omit the
      // block entirely; the model panel fills it via /api/primary.
      defaults: {},
      entries: { zait: { name: 'Zait', default: true } },
    },
    models: { providers: {} },
  };
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(seed, null, 2));
    console.error('[body] seeded fresh openclaw.json (new random gateway token)');
    return true;
  } catch (e) { console.error('[body] could not seed openclaw.json:', e && e.message); }
  return false;
}


// ── self-heal (abuz8-doctor): repair the skeleton before anything reads it ──
// Ported 2026-09-17 from the live install (C:\ABUZ8-Agents\ABUZ8-OPC-1).
// It can never block the boot: any doctor failure is logged and we carry on.
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
  anchorCwd(); // FIRST: never resolve a path from someone else's directory
  const firstRun = bootstrapState(); // THEN: state home must exist before any log open
  runDoctor(); // THEN: repair the skeleton before anything reads it
  // Start with Windows like Claude Desktop — but it is a toggle (tray → Launch at login).
  const prefs = readPrefs();
  setLogin(prefs ? !!prefs.openAtLogin : true);

  createTray();
  startThinker();       // THE brain: Ornith :8011 (256K/slot) — Nemotron :8001 RETIRED 2026-09-07
  startEmbedder();      // needed sidecar: shared memory embedder :8021
  startVision();        // needed sidecar: shared eyes :8012
  startVoice();         // needed sidecar: shared mouth+ears :8094
  startComfy();         // needed sidecar: studio (ComfyUI image/video) :8188
  startDesktop();       // needed sidecar: hands (desktop-control :8790, 36 tools) — ONE owner
  if (ModelsPanel) {
    try {
      const { port } = await ModelsPanel.startPanelServer({
        onRestartGateway: () => { stopWorker(); setTimeout(startWorker, 800); },
        onDiscover: () => discoverBrains(),
        onStudio: (action, body) => {
          if (action === 'free') studioFree(body && body.deep);
          else studioRestore();
        },
        onVoiceInstalled: () => voiceInstalled(),
        onOnboardingComplete: () => { if (modelsWin && !modelsWin.isDestroyed()) modelsWin.close(); createWindow(); },
      });
      panelPort = port;
      if (port) console.error(`[body] local-models panel on 127.0.0.1:${port}`);
    } catch (e) { console.error('[body] models panel failed:', e && e.message); }
  }
  discoverBrains();     // then bind every other brain on the box
  setInterval(discoverBrains, 10 * 60 * 1000);
  seedVoiceScript();    // FIRST boot: vendor voice script -> OPC-1 root (even if :8094 is already owned elsewhere)
  startWorker();
  watchTick();          // 20s port watchdog: the body keeps every owned port alive

  const up = await waitForGateway();
  if (!up) {
    updateTray('gateway did not start');
    dialog.showErrorBox(
      'Zait could not start',
      `The gateway did not answer on 127.0.0.1:${PORT} within 90 seconds.\n\n` +
      `Home: ${STATE_DIR}\n\n` +
      `It will keep retrying in the background. Use the tray icon to restart it.`
    );
    return;
  }

  updateTray('running');
  if (firstRun) showModels();
  else createWindow();
});

app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('activate', showWindow);
app.on('before-quit', () => {
  quitting = true;
  stopWorker(); stopBrain(); stopThinker(); stopEmbedder(); stopVision(); stopVoice(); stopComfy(); stopDesktop();
  try { ModelsPanel && ModelsPanel.stopManaged(); } catch {}
});
