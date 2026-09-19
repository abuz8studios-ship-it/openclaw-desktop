#!/usr/bin/env node
'use strict';
// ── ABUZ8-OPC-1 body doctor ─────────────────────────────────────────────────
// Why this exists (2026-09-16, Ahmad: "a real permanent never dying home that
// can debug itself"):
//
// On 2026-09-15 ~21:50 the stranger-overlay packer ran a FILENAME-based scrub
// over the staged payload and deleted
//   resources\app\docs\reference\templates\{SOUL.md,IDENTITY.md}
// because the names matched an owner-content rule. Those two files are NOT
// owner content -- they are the generic upstream workspace templates the agent
// runtime loads via loadTemplate() when it bootstraps a workspace. With them
// gone, the first real message dies with:
//   "Missing workspace template: SOUL.md (...). Ensure workspace templates are
//    packaged."
// The port smoke passed anyway, because ports come up long before any workspace
// bootstrap runs. A green smoke and a dead first message.
//
// The fix is not "put the files back once". The fix is that the body checks its
// own skeleton every single launch and puts back anything missing, from a vault
// whose payload filenames (wt-*.bin) no name-based scrub can recognise. Whatever
// a future packer, an antivirus, a half-finished copy or an upstream update
// removes, the next boot restores.
//
// Run standalone:
//   node abuz8-doctor.cjs            repair (default)
//   node abuz8-doctor.cjs --check    report only, change nothing
//   node abuz8-doctor.cjs --json     machine-readable report on stdout
//
// In-process (electron-main, panel):
//   require('./abuz8-doctor.cjs').run({ repair: true })

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');

const APP_DIR = __dirname;
const VAULT_DIR = path.join(APP_DIR, 'abuz8-body-vault');
const VAULT_MANIFEST = path.join(VAULT_DIR, 'vault.json');
const VAULT_PAYLOAD = path.join(VAULT_DIR, 'workspace-templates');
const TEMPLATE_DIR = path.join(APP_DIR, 'docs', 'reference', 'templates');

// Same resolution electron-main uses, so a doctor run and a body run always
// agree about where home is.
const OPC1_ROOT = process.env.OPC1_HOME || path.join(os.homedir(), '.openclaw-OPC-1');
const STATE_DIR = path.join(OPC1_ROOT, 'home');
const DOCTOR_DIR = path.join(STATE_DIR, 'doctor');
const REPORT_PATH = path.join(DOCTOR_DIR, 'last-report.json');
const LOG_PATH = path.join(DOCTOR_DIR, 'doctor.log');

// Scripts the body cannot boot without. A truncated or half-written .cjs here
// is the difference between "Zait starts" and a silent black window.
// The install root: two levels above resources\app.
const INSTALL_ROOT = path.resolve(APP_DIR, '..', '..');
// The home's ownership stamp. See checkHomeOwnership below.
const OWNER_STAMP = path.join(STATE_DIR, '.opc1-owner.json');

const CRITICAL_SCRIPTS = [
  'electron-main.cjs',
  'abuz8-models.cjs',
  'abuz8-daemon-worker.cjs',
  'brain-discover.cjs',
  'models-registry.cjs',
];

const REQUIRED_WORKSPACE_FILES = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md'];

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// A home under a temp tree means this process is a smoke/replay copy, not the
// real install. That is exactly the confusion that cost 2026-09-16: an error
// from C:\Temp\BF_ZaitOverlay_smoke read as "the install moved to temp".
function looksTemporary(p) {
  const low = String(p || '').replace(/\\/g, '/').toLowerCase();
  return /(^|\/)(temp|tmp)(\/|$)/.test(low) || low.includes('/appdata/local/temp/');
}

// ── checks ──────────────────────────────────────────────────────────────────
// Every check returns { id, ok, severity, detail, repaired: [] }. A check may
// repair; it never throws. The doctor must not be the reason a boot fails.

function checkStateHome(repair) {
  const out = { id: 'state-home', ok: false, severity: 'fatal', detail: '', repaired: [] };
  try {
    if (!fs.existsSync(STATE_DIR)) {
      if (!repair) { out.detail = 'missing: ' + STATE_DIR; return out; }
      fs.mkdirSync(STATE_DIR, { recursive: true });
      out.repaired.push('created ' + STATE_DIR);
    }
    const probe = path.join(STATE_DIR, '.doctor-write-probe');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    out.ok = true;
    out.detail = 'writable: ' + STATE_DIR;
  } catch (e) {
    out.detail = 'not writable: ' + STATE_DIR + ' (' + (e && e.message) + ')';
  }
  return out;
}

// THE check that would have caught the 09-15 scrub. Compares the live template
// dir against the sealed vault and restores byte-for-byte on any miss.
function checkWorkspaceTemplates(repair) {
  const out = { id: 'workspace-templates', ok: false, severity: 'fatal', detail: '', repaired: [], missing: [], corrupt: [] };
  const manifest = readJson(VAULT_MANIFEST);
  if (!manifest || !Array.isArray(manifest.entries)) {
    out.detail = 'vault manifest unreadable: ' + VAULT_MANIFEST + ' — cannot self-heal templates';
    return out;
  }
  try { fs.mkdirSync(TEMPLATE_DIR, { recursive: true }); } catch {}

  for (const entry of manifest.entries) {
    const live = path.join(TEMPLATE_DIR, entry.target);
    const vaulted = path.join(VAULT_PAYLOAD, entry.vault);
    let state = 'ok';
    try {
      if (fs.readFileSync(live).length === 0) state = 'corrupt';
    } catch { state = 'missing'; }

    if (state === 'ok') continue;
    (state === 'missing' ? out.missing : out.corrupt).push(entry.target);
    if (!repair) continue;
    try {
      const src = fs.readFileSync(vaulted);
      if (sha256(src) !== entry.sha256) {
        out.detail += 'vault payload ' + entry.vault + ' failed its own checksum; ';
        continue;
      }
      fs.writeFileSync(live, src);
      out.repaired.push('restored ' + entry.target + ' from vault');
    } catch (e) {
      out.detail += 'could not restore ' + entry.target + ': ' + (e && e.message) + '; ';
    }
  }

  // Required templates are the ones loadTemplate() hard-fails on.
  const stillGone = manifest.entries
    .filter((e) => e.required)
    .filter((e) => { try { return fs.readFileSync(path.join(TEMPLATE_DIR, e.target)).length === 0; } catch { return true; } })
    .map((e) => e.target);

  out.ok = stillGone.length === 0;
  if (!out.ok) out.detail += 'required templates still absent: ' + stillGone.join(', ');
  else if (!out.detail) {
    out.detail = out.repaired.length
      ? out.repaired.length + ' template(s) restored from vault'
      : 'all ' + manifest.entries.length + ' templates present';
  }
  return out;
}

// The owner workspace. We seed missing bootstrap files from the templates, but
// we never invent the workspace directory itself — if the configured workspace
// is gone that is a real incident, and quietly creating an empty one would hide
// it behind an agent with no memory.
function checkWorkspaceBootstrap(repair) {
  const out = { id: 'workspace-bootstrap', ok: false, severity: 'warn', detail: '', repaired: [] };
  const cfg = readJson(path.join(STATE_DIR, 'openclaw.json'));
  const wsPath = cfg && cfg.agents && cfg.agents.entries
    ? Object.values(cfg.agents.entries).map((a) => a && a.workspace).find(Boolean)
    : null;
  if (!wsPath) { out.ok = true; out.detail = 'no workspace configured yet (fresh install)'; return out; }
  out.workspace = wsPath;
  if (!fs.existsSync(wsPath)) {
    out.severity = 'fatal';
    out.detail = 'configured workspace does not exist: ' + wsPath +
      ' — not auto-creating (that would hide the loss of the agent memory behind a blank one)';
    return out;
  }
  for (const name of REQUIRED_WORKSPACE_FILES) {
    const target = path.join(wsPath, name);
    let present = false;
    try { present = fs.readFileSync(target).length > 0; } catch {}
    if (present) continue;
    if (!repair) { out.detail += name + ' missing; '; continue; }
    try {
      fs.writeFileSync(target, fs.readFileSync(path.join(TEMPLATE_DIR, name)));
      out.repaired.push('seeded ' + name + ' into workspace from template');
    } catch (e) { out.detail += 'could not seed ' + name + ': ' + (e && e.message) + '; '; }
  }
  out.ok = REQUIRED_WORKSPACE_FILES
    .every((n) => { try { return fs.readFileSync(path.join(wsPath, n)).length > 0; } catch { return false; } });
  if (out.ok && !out.detail) out.detail = 'workspace bootstrap complete: ' + wsPath;
  return out;
}

// Parse-check, not just exist-check. An interrupted write leaves a file that is
// present, non-empty and fatal.
function checkCriticalScripts() {
  const out = { id: 'critical-scripts', ok: false, severity: 'fatal', detail: '', repaired: [], bad: [] };
  for (const name of CRITICAL_SCRIPTS) {
    const p = path.join(APP_DIR, name);
    try {
      const src = fs.readFileSync(p, 'utf8');
      if (!src.trim()) { out.bad.push(name + ': empty'); continue; }
      // Compile inside the CommonJS module wrapper Node itself uses — otherwise
      // a legal top-level `return` in a .cjs reads as "Illegal return statement".
      // [^\n]* not .* — in JS regex `.` does not match \r, so `.*\n` misses a
      // CRLF shebang line and leaves a stray `#!` in the source.
      const body = src.replace(/^#![^\n]*\n/, '');
      new vm.Script('(function (exports, require, module, __filename, __dirname) {' + body + '\n});', { filename: p });
    } catch (e) {
      out.bad.push(name + ': ' + (e && e.message ? e.message.split('\n')[0] : 'unreadable'));
    }
  }
  out.ok = out.bad.length === 0;
  out.detail = out.ok ? CRITICAL_SCRIPTS.length + ' critical scripts parse clean' : out.bad.join('; ');
  return out;
}

// openclaw.json is the one file that, when malformed, takes the gateway into
// the crash-loop guard. Restore from the newest backup rather than reseeding,
// so the owner config survives.
function checkConfig(repair) {
  const out = { id: 'config', ok: false, severity: 'fatal', detail: '', repaired: [] };
  const cfgPath = path.join(STATE_DIR, 'openclaw.json');
  if (!fs.existsSync(cfgPath)) { out.ok = true; out.detail = 'no openclaw.json yet — electron-main seeds it on first run'; return out; }
  if (readJson(cfgPath)) { out.ok = true; out.detail = 'openclaw.json parses clean'; return out; }

  out.detail = 'openclaw.json is not valid JSON';
  if (!repair) return out;
  let backups = [];
  try {
    backups = fs.readdirSync(STATE_DIR)
      .filter((f) => f.startsWith('openclaw.json.') || f.startsWith('openclaw.json-'))
      .map((f) => ({ f, m: fs.statSync(path.join(STATE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
  } catch {}
  for (const b of backups) {
    const candidate = path.join(STATE_DIR, b.f);
    if (!readJson(candidate)) continue;
    try {
      fs.copyFileSync(cfgPath, cfgPath + '.broken-' + Date.now());
      fs.copyFileSync(candidate, cfgPath);
      out.repaired.push('restored openclaw.json from ' + b.f);
      out.ok = true;
      out.detail = 'openclaw.json was corrupt; restored from ' + b.f;
      return out;
    } catch (e) { out.detail += '; restore from ' + b.f + ' failed: ' + (e && e.message); }
  }
  out.detail += '; no parseable backup found — repair by hand, then tray → Restart gateway';
  return out;
}

// Answers "why is it in temp" in one line, forever.
//
// 2026-09-16, the second time: the app tree and home were both correct and the
// body was STILL broken, because the live process was running with its cwd
// inside C:\Temp\BF_ZaitOverlay_smoke. resolveWorkspaceTemplateSearchDirs() and
// electron-main's firstExisting() both consider cwd, so a foreign cwd silently
// re-roots template lookup and sidecar script resolution into a stranger's tree.
// Zait's heartbeat failed every 30 minutes for eight hours on exactly this, with
// a correct install on disk the whole time. cwd is load-bearing — check it.
function checkInstallLocation() {
  const out = { id: 'install-location', ok: true, severity: 'warn', detail: '', repaired: [] };
  const cwd = process.cwd();
  out.appDir = APP_DIR;
  out.home = OPC1_ROOT;
  out.cwd = cwd;
  out.isSandboxCopy = looksTemporary(APP_DIR) || looksTemporary(OPC1_ROOT);

  // The install root is two levels above resources\app.
  const installRoot = path.resolve(APP_DIR, '..', '..');
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  out.cwdInsideInstall = norm(cwd) === norm(installRoot) || norm(cwd).startsWith(norm(installRoot) + '/');

  if (out.isSandboxCopy) {
    out.ok = false;
    out.detail = 'THIS IS A SANDBOX COPY, NOT THE INSTALL — app=' + APP_DIR + ', home=' + OPC1_ROOT +
      '. Errors raised here say nothing about the real install.';
  } else if (!out.cwdInsideInstall) {
    // fatal: this is the failure mode that looks like a healthy install and is not.
    out.ok = false;
    out.severity = 'fatal';
    out.detail = 'FOREIGN WORKING DIRECTORY — install is ' + installRoot + ' but cwd is ' + cwd +
      '. Template and sidecar lookup resolve through cwd, so this body will load another tree\'s files. ' +
      'Relaunch the exe with its own folder as the working directory.';
  } else {
    out.detail = 'install tree: ' + APP_DIR + '; home: ' + OPC1_ROOT + '; cwd: ' + cwd;
  }
  return out;
}

// ── one state tree, not two ─────────────────────────────────────────────────
// 2026-09-16: the state dir had grown a SECOND, parallel copy of itself at
// <state>\.openclaw\ — agent DBs, a state DB, plugins, its own npm store. It is
// a path double-append: code joining '.openclaw' onto a directory that IS
// already the state dir. Nothing in openclaw.json referenced it, and it held 5
// rows where the live agent DB held 72,844 — a dead skeleton.
//
// Dead is not harmless. Both trees carried the same schema markers, so a future
// migration touches whichever the gateway registers and lets the other silently
// diverge, and every tool that enumerates databases (the backup command did on
// 09-16 at 22:02) opens both. Two trees with one truth is how you lose the truth.
//
// The canonical agent tree is <state>\agents. Anything else is a divergence and
// the body says so on every launch. Cheap on purpose: named suspects plus a
// single non-recursive scan, never a walk of a 2.6 GB tree.
function checkSingleStateTree() {
  const out = { id: 'single-state-tree', ok: true, severity: 'warn', detail: '', repaired: [], rogue: [] };
  const canonical = path.join(STATE_DIR, 'agents');
  const isAgentTree = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).some((e) =>
        e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'agent', 'openclaw-agent.sqlite')));
    } catch { return false; }
  };

  let entries = [];
  try { entries = fs.readdirSync(STATE_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch {}
  for (const e of entries) {
    if (e.name === 'agents') continue; // the canonical one
    const nestedAgents = path.join(STATE_DIR, e.name, 'agents');
    if (fs.existsSync(nestedAgents) && isAgentTree(nestedAgents)) out.rogue.push(nestedAgents);
  }

  out.canonical = canonical;
  if (out.rogue.length) {
    out.ok = false;
    out.detail = 'SECOND AGENT-DB TREE PRESENT: ' + out.rogue.join(', ') +
      '. The canonical tree is ' + canonical + '. Two trees sharing one schema marker means a migration ' +
      'can advance one and silently strand the other — retire the rogue tree (move it aside, do not delete).';
  } else {
    out.detail = 'one agent tree only: ' + canonical;
  }
  return out;
}

// ── home ownership ──────────────────────────────────────────────────────────
// The bug this exists to kill, 2026-09-16:
//
// OPC1_ROOT falls back to <userhome>\.openclaw-OPC-1 whenever OPC1_HOME is not
// set. That is correct for the installed body and catastrophic for a stray copy:
// on 09-16 at 12:20:15 the leftover smoke copy at C:\Temp\BF_ZaitOverlay_smoke
// was started WITHOUT OPC1_HOME, so it silently adopted the real Zait's home and
// ran temp-tree code against the live config, state DB, logs and sidecar ports.
// Its own home sat untouched since 09-15. Zait's heartbeat then failed every 30
// minutes for eight hours while the install on disk stayed perfect. Ahmad's words
// for it — "Zait landed in temp" — were exactly right.
//
// So the home records which install owns it, and a body that is not that install
// refuses to touch it. This is FATAL and it is meant to be: booting anyway is how
// the damage happened. A stray copy is blocked because the real install still
// exists; a genuine move or reinstall re-claims automatically because the old
// install root is gone. OPC1_ADOPT_HOME=1 forces a re-claim for a deliberate
// migration.
function checkHomeOwnership(repair) {
  const out = { id: 'home-ownership', ok: false, severity: 'fatal', detail: '', repaired: [] };
  out.installRoot = INSTALL_ROOT;
  const claim = {
    installRoot: INSTALL_ROOT,
    exePath: process.execPath,
    hostname: os.hostname(),
    claimedAt: new Date().toISOString(),
  };
  const write = (why) => {
    if (!repair) return false;
    try {
      fs.writeFileSync(OWNER_STAMP, JSON.stringify(claim, null, 2));
      out.repaired.push(why);
      return true;
    } catch (e) { out.detail += 'could not write owner stamp: ' + (e && e.message) + '; '; return false; }
  };

  const prior = readJson(OWNER_STAMP);
  if (!prior || !prior.installRoot) {
    // First run, or a home from before this guard existed. Claim it.
    out.ok = write('claimed home for ' + INSTALL_ROOT) || !repair;
    out.detail = out.ok
      ? 'home claimed by this install' + (repair ? '' : ' (would claim; --check made no change)')
      : out.detail || 'home is unclaimed and could not be claimed';
    return out;
  }

  const same = (a, b) => path.resolve(a).replace(/\\/g, '/').toLowerCase() === path.resolve(b).replace(/\\/g, '/').toLowerCase();
  out.ownedBy = prior.installRoot;
  if (same(prior.installRoot, INSTALL_ROOT)) {
    out.ok = true;
    out.detail = 'home belongs to this install (' + INSTALL_ROOT + ')';
    return out;
  }

  if (process.env.OPC1_ADOPT_HOME === '1') {
    out.ok = write('OPC1_ADOPT_HOME=1 — re-claimed home from ' + prior.installRoot) || !repair;
    out.detail = 'home re-claimed from ' + prior.installRoot + ' by explicit OPC1_ADOPT_HOME=1';
    return out;
  }

  // The recorded owner is gone → this is a legitimate move/reinstall, not a hijack.
  let ownerExists = false;
  try { ownerExists = fs.existsSync(path.join(prior.installRoot, 'resources', 'app')); } catch {}
  if (!ownerExists) {
    out.ok = write('previous install ' + prior.installRoot + ' no longer exists — re-claimed') || !repair;
    out.detail = 'previous owner ' + prior.installRoot + ' is gone; home re-claimed by ' + INSTALL_ROOT;
    return out;
  }

  // The owner still exists and it is not us. This body is a stray copy.
  out.ok = false;
  out.isHijack = true;
  out.detail =
    'REFUSING TO ADOPT ANOTHER INSTALL\'S HOME. This body is ' + INSTALL_ROOT +
    ' but ' + STATE_DIR + ' belongs to ' + prior.installRoot + ' (claimed ' + prior.claimedAt + '). ' +
    'Running on would overwrite the real Zait\'s config, state and sidecar ports — that is exactly the 2026-09-16 incident. ' +
    'Set OPC1_HOME to this copy\'s own home, or OPC1_ADOPT_HOME=1 if you really mean to take it over.';
  return out;
}

// ── runner ──────────────────────────────────────────────────────────────────
function run(opts) {
  const repair = !opts || opts.repair !== false;
  const started = Date.now();
  const checks = [];

  // state-home first: every later check and the report itself write under it.
  const home = checkStateHome(repair);
  checks.push(home);
  checks.push(checkInstallLocation());
  checks.push(checkWorkspaceTemplates(repair));
  checks.push(checkCriticalScripts());
  if (home.ok) {
    // Ownership before config/workspace: if this body does not own the home, the
    // checks below would be inspecting — and repairing — someone else's Zait.
    checks.push(checkHomeOwnership(repair));
    checks.push(checkSingleStateTree());
    checks.push(checkConfig(repair));
    checks.push(checkWorkspaceBootstrap(repair));
  }

  const repaired = checks.reduce((acc, c) => acc.concat(c.repaired || []), []);
  const fatal = checks.filter((c) => !c.ok && c.severity === 'fatal');
  const warn = checks.filter((c) => !c.ok && c.severity === 'warn');

  const ownership = checks.find((c) => c.id === 'home-ownership');
  const report = {
    at: new Date().toISOString(),
    ms: Date.now() - started,
    mode: repair ? 'repair' : 'check',
    appDir: APP_DIR,
    installRoot: INSTALL_ROOT,
    home: OPC1_ROOT,
    // Set when this body is a stray copy pointed at another install's home.
    // electron-main treats this as a hard stop rather than booting over it.
    homeHijack: !!(ownership && ownership.isHijack),
    healthy: fatal.length === 0,
    fatal: fatal.map((c) => c.id),
    warn: warn.map((c) => c.id),
    repaired,
    checks,
  };

  // A stray copy must not write even its own report into a home it does not own
  // — the guard would otherwise be the first thing to violate it.
  if (home.ok && !report.homeHijack) {
    try {
      fs.mkdirSync(DOCTOR_DIR, { recursive: true });
      fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
      const line = '[' + report.at + '] ' + report.mode + ' healthy=' + report.healthy +
        (repaired.length ? ' repaired=' + repaired.length + ' (' + repaired.join(' | ') + ')' : '') +
        (fatal.length ? ' FATAL=' + fatal.map((c) => c.id + ': ' + c.detail).join(' | ') : '') + '\n';
      fs.appendFileSync(LOG_PATH, line);
    } catch { /* a doctor that cannot write its own log still returns its verdict */ }
  }
  return report;
}

function lastReport() { return readJson(REPORT_PATH); }

module.exports = { run, lastReport, REPORT_PATH, LOG_PATH, TEMPLATE_DIR, VAULT_DIR };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const report = run({ repair: !argv.includes('--check') });
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log('ABUZ8-OPC-1 doctor — ' + report.mode + ' — ' + (report.healthy ? 'HEALTHY' : 'UNHEALTHY') + ' (' + report.ms + 'ms)');
    console.log('  app:  ' + report.appDir);
    console.log('  home: ' + report.home);
    for (const c of report.checks) {
      const tag = c.ok ? ' ok ' : (c.severity === 'fatal' ? 'FAIL' : 'warn');
      console.log('  [' + tag + '] ' + c.id.padEnd(21) + ' ' + c.detail);
    }
    if (report.repaired.length) {
      console.log('  repaired:');
      for (const r of report.repaired) console.log('    - ' + r);
    }
    console.log('  report: ' + REPORT_PATH);
  }
  process.exitCode = report.healthy ? 0 : 1;
}
