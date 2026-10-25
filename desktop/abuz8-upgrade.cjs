'use strict';

// abuz8-upgrade.cjs — the native upgrade path for ABUZ8-OPC-1.
//
// Why this file exists. `openclaw update` refuses on this install:
//   "Update refused: package manager owner is unknown; no changes were made."
// resources\app is a VENDORED copy inside the Electron bundle — not an
// npm/pnpm/bun install and not a git checkout, so no package manager owns it
// and the upstream updater has nothing to drive. Before this file, the only
// path forward was a hand procedure written in prose in LEDGER_LOG.md, which
// means it was not a path at all: it could not be verified, dry-run, rolled
// back, or driven from the panel.
//
// This is that procedure as code. It owns three things the prose could not:
//
// 1. LOCAL EDITS ARE DISCOVERED, NOT REMEMBERED. The hand list said there were
//    three modified upstream files. A content diff against the pristine tarball
//    of the PINNED version found SEVEN. A written list goes stale the moment
//    someone patches a file and forgets to update it; a diff cannot. So every
//    run re-derives the truth by fetching openclaw@<pinned> and hashing it
//    against disk. Anything it finds that has no re-apply rule below STOPS the
//    upgrade rather than being silently reverted.
//
// 2. EDITS RE-APPLY SEMANTICALLY, NOT BY FILENAME. dist filenames are
//    content-hashed and change every release (sqlite-readonly-location-BC9PgENz
//    .js became sqlite-readonly-location-BwZwi2pJ.mjs — new hash AND new
//    extension). Replaying a stored copy would either miss the file or paste
//    last release's code over this release's. Each rule locates its site by
//    content signature in the NEW tree and transforms it there. A rule whose
//    site upstream has deleted reports OBSOLETE instead of failing — which is
//    what happened to the windowsHide patch: 2026.9.5 replaced the PowerShell
//    shell-out with a koffi FFI CreateDirectoryW call, so there is no longer a
//    process to hide and the patch is not merely unnecessary but inapplicable.
//
// 3. THE ONE-WAY STEP IS GATED. The sqlite schema migration is forward-only:
//    once a newer build opens the state DB, the old build refuses it, so past
//    first boot "rollback" means restore-from-backup. The app-tree backup is
//    taken by this script; the WAL-aware state backup is NOT something it will
//    fake — it shells `openclaw backup create --verify` and refuses to proceed
//    if that does not pass.
//
// Usage:
//   node abuz8-upgrade.cjs inventory  [--pinned <v>] [--json]
//   node abuz8-upgrade.cjs preflight  [--target <v|latest>] [--json]
//   node abuz8-upgrade.cjs node-swap  --to <26.x.y> [--dry-run]
//   node abuz8-upgrade.cjs apply      [--target <v|latest>] [--dry-run]
//                                     [--state-backup <archive.tar.gz>]
//                                     [--include-flagged] [--skip-state-backup]
//   node abuz8-upgrade.cjs rollback   --slot <name>
//   node abuz8-upgrade.cjs verify     [--json]
//   node abuz8-upgrade.cjs slots      [--json]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const APP = __dirname;                                  // resources\app
const RESOURCES = path.join(APP, '..');                 // resources
function firstExisting(list) { return list.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || list[0]; }
const PRODUCT_ROOT = process.env.OPC1_PRODUCT_ROOT || firstExisting(['C:\\ABUZ8-Agents\\ABUZ8-OPC-1', path.join(RESOURCES, '..')]);
const OPC1_ROOT = process.env.OPC1_HOME || path.join(os.homedir(), '.openclaw-OPC-1');
const STATE_DIR = path.join(OPC1_ROOT, 'home');
const UPSTREAM_JSON = path.join(PRODUCT_ROOT, 'ABUZ8_UPSTREAM.json');
const CACHE_DIR = path.join(PRODUCT_ROOT, 'backups', 'upgrade-cache');
const SLOTS_DIR = path.join(PRODUCT_ROOT, 'backups', 'upgrade-slots');
const LOG = path.join(STATE_DIR, 'logs', 'app-update.log');
const BUNDLED_NODE = firstExisting([
  path.join(RESOURCES, 'runtime', 'node', 'node.exe'),
  path.join(OPC1_ROOT, 'runtime', 'node', 'node.exe'),
]);

// dist\ is 100% upstream-owned — verified by diffing the pinned tarball against
// disk: every local file under it is one of the re-apply rules below, plus one
// stray .bak. So it is replaced wholesale, which is the only way stale modules
// from the old release do not linger and confuse content-signature lookups.
// Everything else merges, because skills\ holds at least one hand-authored
// skill (skills\session-logs) that a wholesale replace would delete.
const WHOLESALE_DIRS = ['dist'];

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, msg + '\n'); } catch {}
  if (!globalThis.__ABUZ8_UPGRADE_JSON) console.log(msg);
}
const sha1 = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

function walk(root, rel = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) { if (d.name === 'node_modules') continue; walk(root, r, out); }
    else out.push(r);
  }
  return out;
}

function copyTree(src, dst) {
  for (const rel of walk(src)) {
    const to = path.join(dst, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, rel), to);
  }
}

// ---------------------------------------------------------------- local edits
//
// Every rule is: how to FIND the site in an arbitrary release, and how to
// transform it. `flagged` marks an edit that changes the agent's own safety or
// oversight text — never re-applied unless the operator passes --include-flagged
// on this specific run, because carrying a change like that across an upgrade
// silently is how it stops being a decision anyone made.

const EDITS = [
  {
    id: 'package-main',
    what: 'package.json "main" -> electron-main.cjs',
    why: 'The Electron body is the product. Upstream ships main=dist/index.js; without this override the app no longer launches as Zait.',
    detect: (tree) => {
      try { return JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8')).main === 'electron-main.cjs'; }
      catch { return false; }
    },
    apply: (tree) => {
      const p = path.join(tree, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (pkg.main === 'electron-main.cjs') return { status: 'already' };
      pkg.main = 'electron-main.cjs';
      fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
      return { status: 'applied', file: 'package.json' };
    },
    covers: (rel) => rel === 'package.json',
  },
  {
    id: 'branding-icons',
    what: 'dist/control-ui favicons + apple-touch-icon (Zait marks)',
    why: 'The control UI is user-facing product surface; upstream icons would reappear in the panel and the taskbar.',
    detect: () => true,
    apply: (tree, ctx) => {
      const names = ['favicon.ico', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png'];
      const done = [];
      for (const n of names) {
        const from = path.join(ctx.stash, 'branding', n);
        const to = path.join(tree, 'dist', 'control-ui', n);
        if (!fs.existsSync(from)) continue;
        if (!fs.existsSync(path.dirname(to))) continue;
        fs.copyFileSync(from, to);
        done.push(n);
      }
      return done.length ? { status: 'applied', files: done } : { status: 'obsolete', reason: 'no control-ui icon targets in this release' };
    },
    covers: (rel) => /^dist\/control-ui\/(favicon(-32)?\.(ico|svg|png)|apple-touch-icon\.png)$/.test(rel),
    stash: (live, stashDir) => {
      const dir = path.join(stashDir, 'branding');
      fs.mkdirSync(dir, { recursive: true });
      for (const n of ['favicon.ico', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png']) {
        const f = path.join(live, 'dist', 'control-ui', n);
        if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, n));
      }
    },
  },
  {
    id: 'sqlite-windowshide',
    what: 'windowsHide:true on the private-SQLite-directory PowerShell spawns',
    why: 'Without it every private-directory creation flashes a PowerShell console over whatever the user is doing.',
    detect: () => true,
    apply: (tree) => {
      // Located by content, never by name: the module is content-hashed and in
      // 2026.9.5 it also changed extension (.js -> .mjs).
      const distDir = path.join(tree, 'dist');
      const hit = walk(distDir)
        .filter((r) => /\.(js|mjs|cjs)$/.test(r))
        .find((r) => {
          try { return fs.readFileSync(path.join(distDir, r), 'utf8').includes('runPrivateDirectoryPowerShell'); }
          catch { return false; }
        });
      if (!hit) {
        // 2026.9.3+ replaced the shell-out with a koffi FFI CreateDirectoryW
        // call. No child process, so nothing to hide — the patch is obsolete,
        // not broken, and the upgrade must not treat it as a failure.
        return { status: 'obsolete', reason: 'no PowerShell private-directory spawn in this release (upstream moved to native FFI)' };
      }
      const file = path.join(distDir, hit);
      let src = fs.readFileSync(file, 'utf8');
      const before = (src.match(/windowsHide/g) || []).length;
      // Both spawn sites carry a `timeout:` line in their options object; the
      // patch is one added property after it. Anchored on the two option
      // objects specifically so the upstream-native windowsHide uses elsewhere
      // in the file are left alone.
      src = src.replace(
        /(timeout: WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS)(\s*\n)(\s*)\}/g,
        (m, a, nl, indent) => `${a},${nl}${indent}\twindowsHide: true${nl}${indent}}`,
      );
      const after = (src.match(/windowsHide/g) || []).length;
      if (after <= before) return { status: 'failed', reason: `patch anchor not matched in dist/${hit}` };
      fs.writeFileSync(file, src);
      return { status: 'applied', file: `dist/${hit}`, windowsHideCount: after };
    },
    covers: (rel) => /^dist\/sqlite-readonly-location-.*\.(js|mjs)$/.test(rel),
  },
  {
    id: 'uncensored-system-prompt',
    flagged: true,
    what: 'replaces the agent system prompt\'s "## Safety" block with an "## Operating Mode" block',
    why: 'Hand-added 2026-09-18. It rewrites the shipped agent policy text, including the lines about pausing on conflict and not altering its own safety/tool policy. Carried forward only on an explicit --include-flagged.',
    detect: () => true,
    apply: (tree, ctx) => {
      const distDir = path.join(tree, 'dist');
      const hit = walk(distDir)
        .filter((r) => /^system-prompt-params-.*\.(js|mjs|cjs)$/.test(r))
        .find((r) => { try { return fs.readFileSync(path.join(distDir, r), 'utf8').includes('"## Safety"'); } catch { return false; } });
      if (!hit) return { status: 'obsolete', reason: 'no "## Safety" block in this release' };
      const file = path.join(distDir, hit);
      const src = fs.readFileSync(file, 'utf8');
      const block = ctx.stash && fs.existsSync(path.join(ctx.stash, 'uncensored-block.json'))
        ? JSON.parse(fs.readFileSync(path.join(ctx.stash, 'uncensored-block.json'), 'utf8'))
        : null;
      if (!block) return { status: 'failed', reason: 'stashed replacement block not captured from the live tree' };
      const lines = src.split('\n');
      const start = lines.findIndex((l) => l.includes('"## Safety"'));
      if (start < 0) return { status: 'obsolete', reason: 'anchor vanished' };
      let end = start;
      while (end + 1 < lines.length && /^\s*"/.test(lines[end + 1]) && !/"## /.test(lines[end + 1])) end++;
      const indent = (lines[start].match(/^\s*/) || [''])[0];
      const replacement = block.lines.map((t) => `${indent}${JSON.stringify(t)},`);
      replacement[replacement.length - 1] = replacement[replacement.length - 1].replace(/,$/, lines[end].trim().endsWith(',') ? ',' : '');
      lines.splice(start, end - start + 1, ...replacement);
      fs.writeFileSync(file, lines.join('\n'));
      return { status: 'applied', file: `dist/${hit}`, replacedLines: end - start + 1 };
    },
    covers: (rel) => /^dist\/system-prompt-params-.*\.(js|mjs)$/.test(rel),
    stash: (live, stashDir) => {
      const distDir = path.join(live, 'dist');
      const hit = walk(distDir)
        .filter((r) => /^system-prompt-params-.*\.(js|mjs|cjs)$/.test(r))
        .find((r) => { try { return fs.readFileSync(path.join(distDir, r), 'utf8').includes('"## Operating Mode"'); } catch { return false; } });
      if (!hit) return;
      const lines = fs.readFileSync(path.join(distDir, hit), 'utf8').split('\n');
      const start = lines.findIndex((l) => l.includes('"## Operating Mode"'));
      if (start < 0) return;
      let end = start;
      while (end + 1 < lines.length && /^\s*"/.test(lines[end + 1]) && !/"## /.test(lines[end + 1])) end++;
      const captured = lines.slice(start, end + 1)
        .map((l) => { try { return JSON.parse(l.trim().replace(/,$/, '')); } catch { return null; } })
        .filter((s) => typeof s === 'string');
      fs.mkdirSync(stashDir, { recursive: true });
      fs.writeFileSync(path.join(stashDir, 'uncensored-block.json'), JSON.stringify({ lines: captured }, null, 2));
    },
  },
  {
    id: 'heartbeat-stub',
    what: 'src/agents/templates/HEARTBEAT.md kept as a comments-only stub',
    why: 'Suppresses scheduled heartbeat API calls. Not in the npm package, so no overlay can touch it — but `openclaw doctor --fix` can, so it is verified after every upgrade.',
    detect: () => true,
    apply: (tree) => {
      const rel = 'src/agents/templates/HEARTBEAT.md';
      const f = path.join(tree, rel);
      if (!fs.existsSync(f)) return { status: 'obsolete', reason: 'template path not present in this tree' };
      const body = fs.readFileSync(f, 'utf8');
      const live = body.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('<!--'));
      return live.length ? { status: 'failed', reason: 'HEARTBEAT.md has non-comment content; heartbeat calls would resume' } : { status: 'already', file: rel };
    },
    covers: () => false, // ours entirely; never appears in an upstream diff
  },
];

// OPC-1's desktop widgets are retained independently of the vendored core.
EDITS.push({
  id: 'opc1-desktop-widgets',
  what: 'OPC-1 update preview and native subscription status widgets',
  why: 'Preserve the local desktop integration while adopting upstream features.',
  detect: (tree) => fs.existsSync(path.join(tree, 'dist/control-ui/assets/opc1-update-preview.js')),
  covers: (rel) => ['dist/control-ui/assets/opc1-update-preview.js', 'dist/control-ui/assets/opc1-subscription-status.js', 'dist/control-ui/assets/config-page-BhM2MyN4-opc1-calendar-channels-20261001-v2.js', 'dist/control-ui/assets/model-providers-page-CFwBkQKH-opc1-calendar-channels-20261001-v2.js'].includes(rel),
  stash: (live, stashDir) => {
    const dir = path.join(stashDir, 'opc1-widgets'); fs.mkdirSync(dir, { recursive: true });
    for (const name of ['opc1-update-preview.js', 'opc1-subscription-status.js']) {
      const file = path.join(live, 'dist/control-ui/assets', name);
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, name));
    }
  },
  apply: (tree, ctx) => {
    const assets = path.join(tree, 'dist/control-ui/assets');
    if (!fs.existsSync(assets)) throw new Error('OPC-1 desktop integration requires the upstream Control UI assets');
    const sites = [['<div id="config-section-update">', 'opc1-update-preview'], ['<div class="model-providers__provider-list">', 'opc1-subscription-status']];
    const files = [];
    for (const [anchor, tag] of sites) {
      const helper = path.join(ctx.stash, 'opc1-widgets', tag + '.js');
      if (!fs.existsSync(helper)) throw new Error('Missing checkpoint for ' + tag);
      fs.copyFileSync(helper, path.join(assets, tag + '.js'));
      let found = false;
      for (const name of fs.readdirSync(assets).filter((n) => n.endsWith('.js') && n !== tag + '.js')) {
        const file = path.join(assets, name); let content = fs.readFileSync(file, 'utf8');
        if (!content.includes(anchor)) continue;
        found = true;
        if (content.includes('<' + tag + '>')) continue;
        content = "import './" + tag + ".js';\n" + content.replace(anchor, anchor + '<' + tag + '></' + tag + '>');
        fs.writeFileSync(file, content); files.push('dist/control-ui/assets/' + name);
      }
      if (!found) throw new Error('Upstream changed the ' + tag + ' integration point; keep the current runtime until the adapter is reviewed');
    }
    return { status: files.length ? 'applied' : 'already', files };
  }
});

EDITS.push({id:'opc1-async-dictation-close',what:'Await local transcription completion',why:'Prevent cold local STT from losing its final transcript',covers:rel=>rel==='dist/handlers-D4tRHP--.mjs'||rel==='dist/control-ui/assets/control-ui-boot-shared-6jDbGebE-opc1-calendar-channels-20261001-v2.js',apply:(tree)=>{let files=[],found=false;for(const name of fs.readdirSync(path.join(tree,'dist')).filter(n=>n.startsWith('handlers-')&&n.endsWith('.mjs'))){const file=path.join(tree,'dist',name);let text=fs.readFileSync(file,'utf8');if(text.includes('const completion = session.sttSession.close();')){found=true;continue;}if(text.includes("\t\tsession.sttSession.close();\n\t} catch (error) {")){text=text.replace("\t\tsession.sttSession.close();\n\t} catch (error) {","\t\tconst completion = session.sttSession.close();\n\t\tif (completion && typeof completion.then === \"function\") {\n\t\t\tclearTimeout(session.cleanupTimer);\n\t\t\tsession.cleanupTimer = setTimeout(() => { if (transcriptionSessions.get(session.id) === session) closeTranscriptionSession(session, \"completed\"); }, 35e3);\n\t\t\tsession.cleanupTimer.unref?.();\n\t\t\tPromise.resolve(completion).finally(() => { if (transcriptionSessions.get(session.id) === session) closeTranscriptionSession(session, \"completed\"); }).catch(() => {});\n\t\t}\n\t} catch (error) {");fs.writeFileSync(file,text);files.push('dist/'+name);found=true;}}if(!found)throw Error('Upstream transcription close contract changed; review adapter before updating');const assets=path.join(tree,'dist/control-ui/assets');let uiFound=false;for(const name of fs.readdirSync(assets).filter(n=>n.startsWith('control-ui-boot-shared-')&&n.endsWith('.js'))){const file=path.join(assets,name);let text=fs.readFileSync(file,'utf8');if(text.includes('By=35e3,Ky="g711_ulaw"')){uiFound=true;continue;}if(text.includes('By=1e4,Ky="g711_ulaw"')){text=text.replace('By=1e4,Ky="g711_ulaw"','By=35e3,Ky="g711_ulaw"');fs.writeFileSync(file,text);files.push('dist/control-ui/assets/'+name);uiFound=true;}}if(!uiFound)throw Error('Upstream dictation UI deadline changed; review before updating');return {status:files.length?'applied':'already',files};}});
EDITS.push({id:'opc1-ui-compressed-assets',what:'Keep compressed UI assets in sync with OPC-1 adapters',why:'Gateway serves precompressed files before source JavaScript',covers:rel=>/dist\/control-ui\/assets\/(?:config-page-BhM2MyN4|model-providers-page-CFwBkQKH|control-ui-boot-shared-6jDbGebE)-opc1-calendar-channels-20261001-v2\.js\.(?:br|gz)$/.test(rel)||/dist\/control-ui\/assets\/opc1-(?:update-preview|subscription-status)\.js\.(?:br|gz)$/.test(rel),apply:tree=>{const assets=path.join(tree,'dist/control-ui/assets'),z=require('node:zlib');let files=[];for(const name of fs.readdirSync(assets).filter(n=>n.endsWith('.js'))){const file=path.join(assets,name),body=fs.readFileSync(file);const text=body.toString();if(!text.includes('opc1-subscription-status')&&!text.includes('opc1-update-preview')&&!text.includes('By=35e3,Ky="g711_ulaw"'))continue;fs.writeFileSync(file+'.br',z.brotliCompressSync(body,{params:{[z.constants.BROTLI_PARAM_QUALITY]:4}}));fs.writeFileSync(file+'.gz',z.gzipSync(body));files.push('dist/control-ui/assets/'+name+'.br','dist/control-ui/assets/'+name+'.gz');}return {status:'applied',files};}});
// ------------------------------------------------------------------- registry

function readPinned() {
  try { return JSON.parse(fs.readFileSync(UPSTREAM_JSON, 'utf8')).upstream?.split('@')[1] || null; } catch { return null; }
}
function installedVersion() {
  try { return require(path.join(APP, 'package.json')).version; } catch { return null; }
}
function npmDist(tag = 'latest') {
  return new Promise((resolve) => {
    const req = https.get(`https://registry.npmjs.org/openclaw/${tag}`, { timeout: 15000 }, (res) => {
      let b = '';
      res.on('data', (d) => { if (b.length < 400000) b += d; });
      res.on('end', () => { try { const j = JSON.parse(b); resolve({ version: j.version, engineNode: j.engines?.node || null }); } catch { resolve({ error: 'unparseable' }); } });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

// Same range matcher abuz8-models.cjs uses; partial bounds (">=24.16.0 <25")
// are normal here and a full-triple regex silently makes every clause fail.
function satisfiesRange(version, range) {
  if (!version || !range) return null;
  const v = String(version).replace(/^v/, '').split('.').map(Number);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d < 0 ? -1 : 1; } return 0; };
  return range.split('||').some((clause) => clause.trim().split(/\s+/).filter(Boolean).every((part) => {
    const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(part.trim());
    if (!m) return false;
    const bound = m[2].split('.').map(Number);
    while (bound.length < 3) bound.push(0);
    const c = cmp(v, bound);
    switch (m[1] || '=') {
      case '>=': return c >= 0; case '>': return c > 0;
      case '<=': return c <= 0; case '<': return c < 0;
      default: return c === 0;
    }
  }));
}

// Native addons are the trap the Node floor hides. A plugin that ships a
// .node built against one ABI silently fails to register on another, and the
// only symptom is a service that never binds its port — the gateway itself
// comes up clean. better-sqlite3 in the memos plugin did exactly this: healthy
// gateway, healthy panel, memos down, nothing in the health output saying why.
// So the runtime is never chosen without asking what the addons on disk can
// load. NODE_MODULE_VERSION lives at a fixed offset in the module's metadata,
// but reading it portably is easier done by asking Node to load it.
const NODE_ABI = { 22: 127, 23: 131, 24: 137, 25: 145, 26: 147 };

function nativeAddons() {
  // Extension dirs are user-installed plugin trees; they are not part of the
  // openclaw package and no overlay or npm install will fix them.
  const roots = [path.join(OPC1_ROOT, 'home', 'extensions')];
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const rel of walkAll(root)) {
      if (!rel.endsWith('.node')) continue;
      // N-API addons carry napi in their path and are ABI-stable by design.
      if (/[\/](napi-v\d+|node-api)[\/]/.test(rel)) continue;
      found.push(path.join(root, rel));
    }
  }
  return found;
}

// walk() skips node_modules, which is exactly where addons live.
function walkAll(root, rel = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) walkAll(root, r, out); else out.push(r);
  }
  return out;
}

function addonLoadsOn(nodeExe, addonPath) {
  // dlopen is the same call require() makes for a .node, minus module
  // resolution — so a clean load here is exactly what the plugin needs, and a
  // mismatch produces the very error the gateway would otherwise swallow.
  const probe = 'try { process.dlopen({ exports: {} }, ' + JSON.stringify(addonPath) +
    '); console.log("ADDON_OK"); } catch (e) { console.log("ADDON_FAIL:" + String(e && e.message).replace(/\s+/g, " ")); }';
  const r = spawnSync(nodeExe, ['-e', probe], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (out.includes('ADDON_OK')) return { ok: true };
  const abi = /NODE_MODULE_VERSION (\d+).*?NODE_MODULE_VERSION (\d+)/.exec(out);
  const msg = (/ADDON_FAIL:(.*)/.exec(out) || [, out])[1] || out;
  return { ok: false, reason: abi ? `built for ABI ${abi[1]}, runtime is ABI ${abi[2]}` : msg.trim().slice(0, 200) };
}

function nativeAddonReport(nodeExe) {
  const addons = nativeAddons();
  const abiMismatch = [];
  const otherFailures = [];
  for (const a of addons) {
    const r = addonLoadsOn(nodeExe, a);
    if (r.ok) continue;
    const entry = { addon: path.relative(OPC1_ROOT, a), reason: r.reason };
    // Only an ABI mismatch means "this runtime cannot run this plugin". Other
    // load failures are usually a packaged variant the platform never loads —
    // rollup ships both the gnu and msvc Windows builds and requires one.
    (/\bABI\b/.test(r.reason) ? abiMismatch : otherFailures).push(entry);
  }
  return { scanned: addons.length, broken: abiMismatch, otherFailures };
}

function bundledNodeVersion() {
  try { return execFileSync(BUNDLED_NODE, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim(); }
  catch { return null; }
}

// System npm drives the fetch; the bundled runtime may be the very thing being
// replaced, so it is never the tool that does the replacing. npm-cli.js is run
// directly rather than through npm.cmd: spawning a .cmd needs shell:true, which
// concatenates arguments unescaped.
function npmRun(args, opts) {
  const cli = firstExisting([
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(BUNDLED_NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]);
  if (!fs.existsSync(cli)) throw new Error('could not locate npm-cli.js');
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, ...opts });
}

function fetchPackage(version) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const dir = path.join(CACHE_DIR, `openclaw-${version}`);
  if (fs.existsSync(path.join(dir, 'package', 'package.json'))) return path.join(dir, 'package');
  fs.mkdirSync(dir, { recursive: true });
  log(`fetch openclaw@${version} (npm pack)`);
  const packed = npmRun(['pack', `openclaw@${version}`], { cwd: dir });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${(packed.stderr || '').slice(-500)}`);
  const tgz = fs.readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');
  const un = spawnSync('tar', ['-xzf', tgz], { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (un.status !== 0) throw new Error(`tar failed: ${(un.stderr || '').slice(-500)}`);
  return path.join(dir, 'package');
}

// --------------------------------------------------------------- subcommands

function inventory({ pinned }) {
  const version = pinned || readPinned() || installedVersion();
  const base = fetchPackage(version);
  const baseFiles = walk(base);
  const modified = [];
  const deleted = [];
  for (const rel of baseFiles) {
    const live = path.join(APP, rel);
    if (!fs.existsSync(live)) { deleted.push(rel); continue; }
    try { if (sha1(path.join(base, rel)) !== sha1(live)) modified.push(rel); } catch { modified.push(rel); }
  }
  const rules = EDITS.filter((e) => !e.covers || typeof e.covers === 'function');
  const covered = [];
  const uncovered = [];
  for (const rel of modified) {
    const rule = rules.find((e) => e.covers && e.covers(rel));
    (rule ? covered : uncovered).push(rule ? { file: rel, rule: rule.id, flagged: !!rule.flagged } : { file: rel });
  }
  return {
    baselineVersion: version,
    baselineFiles: baseFiles.length,
    modified: modified.length,
    covered,
    // An upstream file changed on disk with no rule to re-apply it. Upgrading
    // would revert it without anyone noticing, so apply refuses on this.
    uncovered,
    deletedUpstreamFiles: deleted,
    localOnlyRules: EDITS.filter((e) => !e.covers || !modified.some((m) => e.covers(m))).map((e) => e.id),
  };
}

async function preflight({ target }) {
  const pinned = readPinned();
  const installed = installedVersion();
  const latest = await npmDist(target && target !== 'latest' ? target : 'latest');
  const targetVersion = target && target !== 'latest' ? target : latest.version;
  const nodeBundled = bundledNodeVersion();
  const requires = latest.engineNode;
  const nodeOk = satisfiesRange(nodeBundled, requires);

  let inv = null; let invError = null;
  try { inv = inventory({ pinned: pinned || installed }); } catch (e) { invError = e.message; }

  const addons = nativeAddonReport(BUNDLED_NODE);

  const blockers = [];
  if (addons.broken.length) {
    blockers.push({
      id: 'native-addon-abi',
      fix: 'run the bundled runtime on an ABI these addons have binaries for, or rebuild/upgrade the addon',
      detail: `${addons.broken.length} plugin native addon(s) cannot load on bundled Node ${bundledNodeVersion()}: ` +
        addons.broken.map((b) => `${b.addon} (${b.reason})`).join('; ') +
        '. The gateway still starts; the plugin silently fails to register and its port never binds.',
    });
  }
  const warnings = [];
  if (nodeOk === false) {
    blockers.push({
      id: 'node-floor',
      fix: `node-swap --to 26.7.0`,
      detail: `bundled Node ${nodeBundled} does not satisfy ${targetVersion}'s ${requires}; the gateway would refuse to start on every boot.`,
    });
  }
  if (inv && inv.uncovered.length) {
    blockers.push({
      id: 'uncovered-local-edits',
      fix: 'add a re-apply rule to EDITS in abuz8-upgrade.cjs, or revert the file',
      detail: `${inv.uncovered.length} locally modified upstream file(s) have no re-apply rule: ${inv.uncovered.map((u) => u.file).join(', ')}`,
    });
  }
  if (invError) blockers.push({ id: 'inventory-failed', detail: invError, fix: 'check network / npm access' });
  const flagged = (inv?.covered || []).filter((c) => c.flagged);
  if (flagged.length) {
    warnings.push({
      id: 'flagged-edits',
      detail: `${flagged.length} local edit(s) change agent safety/oversight text and are NOT carried forward unless --include-flagged is passed: ${flagged.map((f) => f.rule).join(', ')}`,
    });
  }
  if (addons.otherFailures?.length) {
    warnings.push({
      id: 'addon-load-failures',
      detail: `${addons.otherFailures.map((b) => `${b.addon}: ${b.reason}`).join('; ')} — not an ABI mismatch, so not a blocker; typically a packaged variant this platform never loads.`,
    });
  }
  warnings.push({
    id: 'one-way-migration',
    detail: `first boot on ${targetVersion} migrates the sqlite state schema forward; ${installed} will refuse the DB afterwards. Rollback past that point is restore-from-backup.`,
  });

  return {
    productRoot: PRODUCT_ROOT,
    installed, pinned, targetVersion,
    nativeAddons: addons,
    node: { bundled: nodeBundled, requiredByTarget: requires, satisfied: nodeOk, systemNode: (() => { try { return execFileSync(process.platform === 'win32' ? 'node.exe' : 'node', ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim(); } catch { return null; } })() },
    localEdits: inv,
    blockers,
    warnings,
    ready: blockers.length === 0,
    // This is the whole point of the file: a real answer to "can the product
    // update itself", computed rather than asserted.
    selfApplicable: blockers.length === 0,
  };
}

function nodeSwap({ to, dryRun, force }) {
  if (!/^\d+\.\d+\.\d+$/.test(String(to || ''))) throw new Error('--to must be a full version, e.g. 26.7.0');
  const current = bundledNodeVersion();
  const plan = { from: current, to: `v${to}`, exe: BUNDLED_NODE };
  if (dryRun) return { ...plan, dryRun: true, addonsOnCurrentRuntime: nativeAddonReport(BUNDLED_NODE) };

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const zipName = `node-v${to}-win-x64.zip`;
  const zipPath = path.join(CACHE_DIR, zipName);
  if (!fs.existsSync(zipPath)) {
    log(`download https://nodejs.org/dist/v${to}/${zipName}`);
    const curl = spawnSync('curl', ['-fsSL', '-o', zipPath, `https://nodejs.org/dist/v${to}/${zipName}`], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
    if (curl.status !== 0) throw new Error(`download failed: ${(curl.stderr || '').slice(-400)}`);
  }
  // Verify against the release SHASUMS before anything is unpacked.
  const sumsPath = path.join(CACHE_DIR, `SHASUMS256-${to}.txt`);
  if (!fs.existsSync(sumsPath)) {
    const s = spawnSync('curl', ['-fsSL', '-o', sumsPath, `https://nodejs.org/dist/v${to}/SHASUMS256.txt`], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (s.status !== 0) throw new Error('could not fetch SHASUMS256.txt');
  }
  const want = fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/).find((l) => l.endsWith(` ${zipName}`) || l.endsWith(`  ${zipName}`));
  if (!want) throw new Error(`${zipName} not listed in SHASUMS256.txt`);
  const got = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  if (got !== want.trim().split(/\s+/)[0]) throw new Error(`checksum mismatch for ${zipName}`);
  log(`checksum ok ${zipName}`);

  const unpack = path.join(CACHE_DIR, `node-v${to}-win-x64`);
  if (!fs.existsSync(path.join(unpack, 'node.exe'))) {
    // Expand-Archive rather than tar: whichever tar is first on PATH may be GNU
    // tar, which does not read zip at all, and bsdtar reads a leading "C:" as a
    // remote host. PowerShell is unambiguous on both counts.
    const un = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${CACHE_DIR}' -Force`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 900000 });
    if (un.status !== 0) throw new Error(`unzip failed: ${(un.stderr || '').slice(-400)}`);
  }
  const newExe = path.join(unpack, 'node.exe');
  if (!fs.existsSync(newExe)) throw new Error('unpacked tree has no node.exe');

  // Only node.exe moves. The rest of the runtime directory holds the bundled
  // npm plus globally installed tool shims (hypit and friends) that have
  // nothing to do with the Node line and everything to do with the product.
  const backup = `${BUNDLED_NODE}.bak-${current}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(BUNDLED_NODE, backup);
  fs.copyFileSync(newExe, BUNDLED_NODE);
  const now = bundledNodeVersion();
  if (now !== `v${to}`) {
    fs.copyFileSync(backup, BUNDLED_NODE);
    throw new Error(`swap verification failed (reports ${now}); reverted`);
  }
  // A runtime that satisfies engines but cannot load the plugin addons is not
  // an upgrade, it is a silent outage. Checked here, while the revert is one
  // file copy away.
  const before = nativeAddonReport(backup);
  const after = nativeAddonReport(BUNDLED_NODE);
  if (after.broken.length > before.broken.length && !force) {
    fs.copyFileSync(backup, BUNDLED_NODE);
    throw new Error(
      `reverted to ${current}: ${after.broken.length} native addon(s) cannot load on v${to} ` +
      `(was ${before.broken.length}) — ${after.broken.map((b) => `${b.addon}: ${b.reason}`).join('; ')}. ` +
      `Pass --force to swap anyway.`,
    );
  }
  log(`bundled node ${current} -> ${now} (backup ${path.basename(backup)}); native addons broken: ${after.broken.length}`);
  return { ...plan, swapped: true, verified: now, backup, nativeAddons: after, reversible: `copy "${backup}" over "${BUNDLED_NODE}"` };
}

function stateBackup(outDir) {
  // Not simulated, not skipped quietly. WAL-aware and verified by openclaw
  // itself, because the sqlite migration that follows cannot be undone.
  log('state backup: openclaw backup create --verify');
  // The full env electron-main hands the gateway. OPENCLAW_CONFIG_PATH alone is
  // not enough: without OPENCLAW_HOME and OPENCLAW_STATE_DIR the CLI resolves
  // the DEFAULT ~\.openclaw room and would faithfully back up the wrong state,
  // which is worse than no backup because it reports success.
  // --output, or the archive lands in cwd — which is the app tree the overlay
  // is about to replace. A 4 GB safety net written inside the thing it is
  // supposed to protect is not a safety net.
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync(BUNDLED_NODE, [path.join(APP, 'openclaw.mjs'), 'backup', 'create', '--verify', '--output', outDir], {
    cwd: APP, encoding: 'utf8', windowsHide: true, timeout: 7200000,
    env: {
      ...process.env,
      OPENCLAW_HOME: path.dirname(OPC1_ROOT),
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_CONFIG_PATH: path.join(STATE_DIR, 'openclaw.json'),
    },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const verified = r.status === 0 && /verification:\s*passed/i.test(out);
  const archive = (out.match(/([A-Za-z]:\\[^\r\n"]*?openclaw-backup[^\r\n"]*?\.tar\.gz)/) || [])[1] || null;
  // The check that matters is which state room was READ, not where the archive
  // was written. A verified archive of the default ~\.openclaw room would pass
  // every other test while protecting nothing — so the plan output has to name
  // this product's room before the backup counts.
  const sourceRoom = new RegExp(path.basename(OPC1_ROOT).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(out);
  const ok = verified && sourceRoom;
  return {
    ok, verified, archive, sourceRoom, status: r.status, tail: out.slice(-1200),
    ...(verified && !sourceRoom ? { refusedBecause: `archive verified but its plan never names ${path.basename(OPC1_ROOT)} — it backed up a different state room` } : {}),
  };
}

function apply({ target, dryRun, includeFlagged, skipStateBackup, stateBackupPath }) {
  const installed = installedVersion();
  const targetVersion = target;
  if (!targetVersion || targetVersion === 'latest') throw new Error('apply requires an explicit --target version');
  if (targetVersion === installed) return { noop: true, reason: `already on ${installed}` };

  const inv = inventory({});
  if (inv.uncovered.length) throw new Error(`refusing: ${inv.uncovered.length} locally modified upstream file(s) have no re-apply rule: ${inv.uncovered.map((u) => u.file).join(', ')}`);

  const nextTree = fetchPackage(targetVersion);
  const nodeReq = JSON.parse(fs.readFileSync(path.join(nextTree, 'package.json'), 'utf8')).engines?.node;
  const nodeNow = bundledNodeVersion();
  if (satisfiesRange(nodeNow, nodeReq) === false) throw new Error(`refusing: bundled Node ${nodeNow} does not satisfy ${targetVersion} (${nodeReq}). Run node-swap first.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slot = path.join(SLOTS_DIR, `${stamp}-${installed}-to-${targetVersion}`);
  const plan = {
    from: installed, to: targetVersion, slot,
    node: { bundled: nodeNow, requiredByTarget: nodeReq },
    edits: EDITS.map((e) => ({ id: e.id, flagged: !!e.flagged, willApply: includeFlagged || !e.flagged })),
    wholesaleDirs: WHOLESALE_DIRS,
    stateBackup: stateBackupPath ? ('reusing ' + stateBackupPath) : (skipStateBackup ? 'SKIPPED (operator flag)' : 'openclaw backup create --verify --output <slot>'),
  };
  if (dryRun) return { dryRun: true, plan, inventory: inv };

  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'plan.json'), JSON.stringify(plan, null, 2));

  // 1. Capture the live shape of every edit that has to survive.
  const stash = path.join(slot, 'stash');
  fs.mkdirSync(stash, { recursive: true });
  for (const e of EDITS) { if (e.stash) { try { e.stash(APP, stash); } catch (err) { log(`stash ${e.id} failed: ${err.message}`); } } }

  // 2. Back up every tree the overlay will touch.
  log(`backup app tree -> ${slot}`);
  const appBackup = path.join(slot, 'app');
  for (const rel of walk(nextTree).concat(walk(path.join(APP, 'dist')).map((r) => `dist/${r}`))) {
    const from = path.join(APP, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(appBackup, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.copyFileSync(from, to); } catch {}
  }
  fs.copyFileSync(path.join(APP, 'package.json'), path.join(slot, 'package.json.pre'));

  // 3. State backup — the gate in front of the one-way migration.
  let sb = { ok: true, skipped: true };
  if (stateBackupPath) {
    // An archive the operator already took and verified. Accepted on evidence
    // it exists and is the right order of magnitude, not on their word.
    const st = fs.existsSync(stateBackupPath) ? fs.statSync(stateBackupPath) : null;
    if (!st || !st.isFile()) throw new Error(`refusing: --state-backup ${stateBackupPath} is not a file`);
    if (st.size < 1024 * 1024) throw new Error(`refusing: --state-backup ${stateBackupPath} is only ${st.size} bytes`);
    sb = { ok: true, reused: true, archive: stateBackupPath, bytes: st.size };
    fs.writeFileSync(path.join(slot, 'state-backup.json'), JSON.stringify(sb, null, 2));
  } else if (!skipStateBackup) {
    sb = stateBackup(slot);
    fs.writeFileSync(path.join(slot, 'state-backup.json'), JSON.stringify(sb, null, 2));
    if (!sb.ok) throw new Error(`refusing: state backup did not verify. ${sb.refusedBecause || ''} ${sb.tail.slice(-300)}`);
  }

  // 4. Overlay. dist replaced wholesale so stale modules cannot linger;
  //    everything else merged so hand-authored files survive.
  for (const d of WHOLESALE_DIRS) {
    const live = path.join(APP, d);
    if (fs.existsSync(live)) { log(`replace ${d}/ wholesale`); fs.rmSync(live, { recursive: true, force: true }); }
  }
  log(`overlay openclaw@${targetVersion}`);
  copyTree(nextTree, APP);

  // 5. Re-apply local edits against the NEW tree.
  const results = [];
  for (const e of EDITS) {
    if (e.flagged && !includeFlagged) { results.push({ id: e.id, status: 'skipped', reason: 'flagged; --include-flagged not passed' }); continue; }
    try { results.push({ id: e.id, ...e.apply(APP, { stash }) }); }
    catch (err) { results.push({ id: e.id, status: 'failed', reason: err.message }); }
  }
  fs.writeFileSync(path.join(slot, 'edits.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.status === 'failed');
  for (const r of results) log(`edit ${r.id}: ${r.status}${r.reason ? ' — ' + r.reason : ''}`);

  // 6. Dependencies. 26 of 66 direct deps moved between 2026.9.2 and 2026.9.5,
  //    and the package bundles none of them, so the overlay alone leaves code
  //    importing versions that are not on disk.
  //
  //    --omit=dev is not enough. Running npm install INSIDE the package makes
  //    npm treat it as the root project, so it resolves the 61 devDependencies
  //    too and only omits them at write time. Upstream builds with pnpm and
  //    those dev pins conflict under npm's resolver — 2026.9.5 fails on
  //    @opentelemetry/sdk-node vs a peerOptional of @mistralai/mistralai. A
  //    consumer installing openclaw never sees any of that. So resolution runs
  //    against a production-only manifest, which is what a consumer install
  //    actually is, and the real package.json goes back afterwards.
  log('npm install --omit=dev (production-only manifest)');
  const realManifest = fs.readFileSync(path.join(APP, 'package.json'), 'utf8');
  fs.writeFileSync(path.join(slot, 'package.json.real'), realManifest);
  // The lockfile that shipped with the OLD version describes the old tree and
  // will fight the new manifest; it is archived, not carried.
  const lockPath = path.join(APP, 'package-lock.json');
  if (fs.existsSync(lockPath)) { fs.copyFileSync(lockPath, path.join(slot, 'package-lock.json.pre')); fs.rmSync(lockPath); }
  let inst;
  try {
    const prod = JSON.parse(realManifest);
    delete prod.devDependencies;
    fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify(prod, null, 2) + '\n');
    inst = npmRun(['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: APP, timeout: 3600000 });
  } finally {
    fs.writeFileSync(path.join(APP, 'package.json'), realManifest);
  }
  const installOk = inst.status === 0;
  fs.writeFileSync(path.join(slot, 'npm-install.log'), `${inst.stdout || ''}\n${inst.stderr || ''}`);
  if (!installOk) log(`npm install FAILED: ${(inst.stderr || '').slice(-600)}`);

  // 7. Record the new pin.
  try {
    const up = JSON.parse(fs.readFileSync(UPSTREAM_JSON, 'utf8'));
    fs.writeFileSync(path.join(slot, 'ABUZ8_UPSTREAM.json.pre'), JSON.stringify(up, null, 2));
    up.upstream = `openclaw@${targetVersion}`;
    up.at = new Date().toISOString();
    up.appBackup = appBackup;
    fs.writeFileSync(UPSTREAM_JSON, JSON.stringify(up, null, 2));
  } catch (e) { log(`upstream pin write failed: ${e.message}`); }

  return {
    applied: true, from: installed, to: targetVersion, slot,
    edits: results, editFailures: failed,
    npmInstall: installOk ? 'ok' : 'FAILED — see npm-install.log',
    stateBackup: sb.skipped ? 'skipped' : 'verified',
    next: 'restart the app, then: node abuz8-upgrade.cjs verify',
  };
}

function rollback({ slot: name }) {
  const slots = fs.existsSync(SLOTS_DIR) ? fs.readdirSync(SLOTS_DIR).sort().reverse() : [];
  const chosen = name ? slots.find((s) => s === name || s.includes(name)) : slots[0];
  if (!chosen) throw new Error('no upgrade slot found');
  const slot = path.join(SLOTS_DIR, chosen);
  const appBackup = path.join(slot, 'app');
  if (!fs.existsSync(appBackup)) throw new Error(`slot ${chosen} has no app backup`);
  for (const d of WHOLESALE_DIRS) { const live = path.join(APP, d); if (fs.existsSync(live)) fs.rmSync(live, { recursive: true, force: true }); }
  copyTree(appBackup, APP);
  const pre = path.join(slot, 'ABUZ8_UPSTREAM.json.pre');
  if (fs.existsSync(pre)) fs.copyFileSync(pre, UPSTREAM_JSON);
  log(`rolled back app tree from ${chosen}`);
  return {
    rolledBack: true, slot: chosen,
    warning: 'The app tree is restored. If the newer build already opened the state DB, the schema migrated forward and the older build will refuse it — restore the state backup recorded in this slot as well.',
    stateBackupNote: fs.existsSync(path.join(slot, 'state-backup.json')) ? JSON.parse(fs.readFileSync(path.join(slot, 'state-backup.json'), 'utf8')).tail?.slice(-300) : null,
  };
}

// ---------------------------------------------------------- sovereign surface
//
// The upstream package is only half of this product. The other half is the
// local-control surface: our own Electron body, the local brains, the voice /
// vision / video sidecars, desktop control, and the provider set that makes the
// thing agnostic rather than tied to one vendor's cloud. An upgrade that leaves
// openclaw healthy but quietly drops any of that is a failed upgrade, so it is
// checked by the same command that checks the package.
//
// Every entry names a file or a config fact we own. Nothing here is upstream's
// to define, which is exactly why it has to be asserted after every overlay.
const SOVEREIGN_SURFACE = [
  { id: 'electron-body', what: 'our Electron main process', file: () => path.join(APP, 'electron-main.cjs') },
  { id: 'model-panel', what: 'local model control panel', file: () => path.join(APP, 'abuz8-models.cjs') },
  { id: 'model-panel-ui', what: 'panel UI', file: () => path.join(APP, 'abuz8-models.html') },
  { id: 'model-registry', what: 'role/port registry module', file: () => path.join(APP, 'models-registry.cjs') },
  { id: 'brain-discover', what: 'local brain discovery', file: () => path.join(APP, 'brain-discover.cjs') },
  { id: 'doctor', what: 'our own doctor', file: () => path.join(APP, 'abuz8-doctor.cjs') },
  { id: 'upgrader', what: 'this upgrade path', file: () => path.join(APP, 'abuz8-upgrade.cjs') },
  { id: 'tokenomics', what: 'token spend + cost rollup', file: () => path.join(APP, 'abuz8-tokenomics.cjs') },
  { id: 'kernel', what: 'harness mount kernel (PRD_PLUGGABLE_HARNESS.md Stage 0/1)', file: () => path.join(APP, 'abuz8-kernel.cjs') },
  { id: 'plugin-manifests', what: 'capability manifests directory', file: () => path.join(RESOURCES, 'plugins') },
  { id: 'panel-config', what: 'Stage 2 split: shared config/roots module (kind: config)', file: () => path.join(APP, 'abuz8-config.cjs') },
  { id: 'panel-registry', what: 'Stage 2 split: model registry module (kind: brain)', file: () => path.join(APP, 'abuz8-registry.cjs') },
  { id: 'panel-ledger', what: 'Stage 2 split: benchmarks/health/HF-catalogue module (kind: ledger)', file: () => path.join(APP, 'abuz8-ledger.cjs') },
  { id: 'body-vault', what: 'body vault', file: () => path.join(APP, 'abuz8-body-vault') },
  { id: 'llama-engine', what: 'local GGUF inference engine', file: () => path.join(RESOURCES, 'engine', 'llama-server.exe') },
  { id: 'voice-module', what: 'voice sidecar', file: () => path.join(RESOURCES, 'voice') },
  { id: 'hands-module', what: 'desktop-control sidecar', file: () => path.join(RESOURCES, 'hands') },
  { id: 'subscription-router', what: 'monthly-subscription CLI lanes', file: () => path.join(RESOURCES, 'subscription') },
  { id: 'model-registry-json', what: 'role bindings', file: () => path.join(RESOURCES, 'models.registry.json') },
  { id: 'bundled-runtime', what: 'bundled Node runtime', file: () => BUNDLED_NODE },
];

function sovereignConfigFacts() {
  // Read from the live config rather than assumed: these are the things that
  // make the install agnostic, and an upgrade must not narrow them.
  const out = [];
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'openclaw.json'), 'utf8')); } catch (e) { return [{ id: 'config', ok: false, value: e.message }]; }
  const providers = Object.keys((cfg.models && cfg.models.providers) || {});
  out.push({ id: 'providers', what: 'model providers configured', ok: providers.length > 0, value: `${providers.length}` });
  // 2026-09-20: the HuggingFace *inference provider* was removed on Ahmad's
  // call — its apiKey was env:HUGGINGFACE_API_KEY and that variable is set
  // nowhere, so every call would 401 the moment a fallback reached it. What
  // must survive is the *catalogue*: search/browse/download of GGUFs straight
  // from huggingface.co, which needs no key. So the check follows the
  // capability that is actually load-bearing, not the provider entry.
  let hfCatalogue = false;
  try { hfCatalogue = /api\/hf\/search/.test(fs.readFileSync(path.join(APP, 'abuz8-models.cjs'), 'utf8')); } catch {}
  const hfProvider = providers.includes('huggingface');
  out.push({
    id: 'huggingface-catalogue',
    what: 'HuggingFace model catalogue (search/download, no key needed)',
    ok: hfCatalogue,
    value: hfCatalogue ? `catalogue wired${hfProvider ? '; inference provider also present' : '; inference provider intentionally absent'}` : 'MISSING',
  });
  const localish = providers.filter((p) => /^local[-_]|^ornith|^vision-local|local-fallback/i.test(p));
  out.push({ id: 'local-brains', what: 'local (non-cloud) providers', ok: localish.length > 0, value: localish.join(', ') || 'none' });
  // agents.defaults.model is an object: { primary, fallbacks[] }.
  const modelSel = ((cfg.agents || {}).defaults || {}).model;
  const primary = typeof modelSel === 'string' ? modelSel : (modelSel || {}).primary;
  const fallbacks = (typeof modelSel === 'object' && Array.isArray((modelSel || {}).fallbacks)) ? modelSel.fallbacks : [];
  out.push({ id: 'primary-brain', what: 'primary brain', ok: !!primary, value: String(primary || 'unset') });
  out.push({ id: 'brain-fallbacks', what: 'fallback chain', ok: fallbacks.length > 0, value: fallbacks.join(' -> ') || 'none' });
  const allow = ((cfg.plugins || {}).allow) || [];
  out.push({ id: 'plugins-allowed', what: 'plugins allow-list', ok: allow.length > 0, value: `${allow.length}` });
  // Auto-update must stay structurally off: upstream may ship it on.
  const autoUpdate = ((cfg.update || {}).auto || {}).enabled;
  out.push({ id: 'auto-update-off', what: 'upstream auto-update disabled', ok: autoUpdate !== true, value: String(autoUpdate) });
  return out;
}

function sovereignSurface() {
  const files = SOVEREIGN_SURFACE.map((e) => {
    let p = null, ok = false;
    try { p = e.file(); ok = !!p && fs.existsSync(p); } catch {}
    return { id: e.id, what: e.what, ok, value: ok ? path.relative(PRODUCT_ROOT, p) : 'MISSING' };
  });
  return [...files, ...sovereignConfigFacts()];
}

function verify() {
  const checks = [];
  const version = installedVersion();
  checks.push({ check: 'installed version', value: version });
  const nodeV = bundledNodeVersion();
  const req = (() => { try { return require(path.join(APP, 'package.json')).engines?.node; } catch { return null; } })();
  checks.push({ check: 'bundled node satisfies engines', value: `${nodeV} vs ${req}`, ok: satisfiesRange(nodeV, req) === true });
  let main = null; try { main = require(path.join(APP, 'package.json')).main; } catch {}
  checks.push({ check: 'package.json main', value: main, ok: main === 'electron-main.cjs' });
  for (const n of ['favicon.ico', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png']) {
    checks.push({ check: `branding ${n}`, ok: fs.existsSync(path.join(APP, 'dist', 'control-ui', n)) });
  }
  const hb = path.join(APP, 'src', 'agents', 'templates', 'HEARTBEAT.md');
  checks.push({
    check: 'HEARTBEAT stub', ok: fs.existsSync(hb) &&
      !fs.readFileSync(hb, 'utf8').split(/\r?\n/).some((l) => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('<!--')),
  });
  const distDir = path.join(APP, 'dist');
  const psHit = walk(distDir).filter((r) => /\.(js|mjs|cjs)$/.test(r)).find((r) => { try { return fs.readFileSync(path.join(distDir, r), 'utf8').includes('runPrivateDirectoryPowerShell'); } catch { return false; } });
  checks.push({
    check: 'sqlite private-dir window hidden',
    value: psHit ? `${psHit}: windowsHide x${(fs.readFileSync(path.join(distDir, psHit), 'utf8').match(/windowsHide/g) || []).length}` : 'no PowerShell spawn (upstream native FFI)',
    ok: psHit ? (fs.readFileSync(path.join(distDir, psHit), 'utf8').match(/windowsHide/g) || []).length >= 4 : true,
  });
  let deps = { ok: true, missing: [] };
  try {
    const want = require(path.join(APP, 'package.json')).dependencies || {};
    for (const [name, range] of Object.entries(want)) {
      const p = path.join(APP, 'node_modules', name, 'package.json');
      if (!fs.existsSync(p)) { deps.missing.push(name); continue; }
      const have = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (/^\d+\.\d+\.\d+$/.test(range) && have !== range) deps.missing.push(`${name}@${have}!=${range}`);
    }
    deps.ok = deps.missing.length === 0;
  } catch (e) { deps = { ok: false, missing: [e.message] }; }
  checks.push({ check: 'dependencies on disk match package.json', ok: deps.ok, value: deps.missing.slice(0, 8).join(', ') || 'all match' });
  const addons = nativeAddonReport(BUNDLED_NODE);
  checks.push({ check: 'plugin native addons load on bundled node', ok: addons.broken.length === 0, value: addons.broken.length ? addons.broken.map((b) => b.addon).join(', ') : `${addons.scanned} scanned, all load` });
  // Harness Stage 0/1: every manifest resolves, and every manifest marked
  // sovereign resolves to a local endpoint — checked at the manifest level
  // (no live port probe here; that is what GET /api/kernel/status is for) so
  // this stays synchronous like the rest of verify().
  try {
    const k = require('./abuz8-kernel.cjs');
    const manifests = k.loadManifests();
    const bad = manifests.filter((m) => m.manifestError);
    const nonSovereign = manifests.filter((m) => m.sovereign === true && !k.assertSovereignEndpoint(m.id, '127.0.0.1').ok);
    checks.push({
      check: 'harness manifests load and resolve sovereign',
      ok: bad.length === 0 && nonSovereign.length === 0,
      value: bad.length || nonSovereign.length
        ? `${bad.length} manifest error(s), ${nonSovereign.length} sovereignty violation(s)`
        : `${manifests.length} manifests, all sovereign claims hold`,
    });
  } catch (e) {
    checks.push({ check: 'harness manifests load and resolve sovereign', ok: false, value: e.message });
  }
  const surface = sovereignSurface();
  return {
    version,
    checks,
    // Named separately so a package that is healthy but stripped of our own
    // work can never read as a clean upgrade.
    sovereignSurface: surface,
    ok: checks.every((c) => c.ok !== false) && surface.every((c) => c.ok !== false),
  };
}

function slots() {
  if (!fs.existsSync(SLOTS_DIR)) return [];
  return fs.readdirSync(SLOTS_DIR).sort().reverse().map((name) => {
    const p = path.join(SLOTS_DIR, name, 'plan.json');
    let plan = null; try { plan = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    return { name, from: plan?.from, to: plan?.to, path: path.join(SLOTS_DIR, name) };
  });
}

// ------------------------------------------------------------------------ cli

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.json) globalThis.__ABUZ8_UPGRADE_JSON = true;
  const emit = (v) => console.log(JSON.stringify(v, null, 2));
  try {
    switch (cmd) {
      case 'inventory': return emit(inventory({ pinned: args.pinned }));
      case 'preflight': return emit(await preflight({ target: args.target }));
      case 'node-swap': return emit(nodeSwap({ to: args.to, dryRun: !!args.dryRun, force: !!args.force }));
      case 'apply': {
        let target = args.target;
        if (!target || target === 'latest') target = (await npmDist('latest')).version;
        return emit(apply({ target, dryRun: !!args.dryRun, includeFlagged: !!args.includeFlagged, skipStateBackup: !!args.skipStateBackup, stateBackupPath: typeof args.stateBackup === 'string' ? args.stateBackup : null }));
      }
      case 'rollback': return emit(rollback({ slot: args.slot }));
      case 'verify': return emit(verify());
      case 'reapply': {
        // Re-apply one customization against the tree as it stands. Needed
        // after `openclaw doctor --fix`, after a partial run, or when a flagged
        // edit is deliberately restored later rather than during the upgrade.
        const rule = EDITS.find((e) => e.id === args.id);
        if (!rule) throw new Error(`unknown edit id: ${args.id}. known: ${EDITS.map((e) => e.id).join(', ')}`);
        const slots = fs.existsSync(SLOTS_DIR) ? fs.readdirSync(SLOTS_DIR).sort().reverse() : [];
        const stash = args.stash || (slots.length ? path.join(SLOTS_DIR, slots[0], 'stash') : null);
        if (!stash || !fs.existsSync(stash)) throw new Error('no stash directory found; pass --stash <dir>');
        const r = rule.apply(APP, { stash });
        log(`reapply ${rule.id}: ${r.status}${r.reason ? ' — ' + r.reason : ''}`);
        return emit({ id: rule.id, stash, ...r });
      }
      case 'slots': return emit(slots());
      default:
        console.log(fs.readFileSync(__filename, 'utf8').split('// Usage:')[1].split('*/')[0].replace(/^\/\/ ?/gm, '').trim());
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    console.error(JSON.stringify({ error: e.message }, null, 2));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { inventory, preflight, apply, rollback, verify, slots, nodeSwap, satisfiesRange, EDITS };
