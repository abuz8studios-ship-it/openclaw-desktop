'use strict';

// models-registry.cjs — UNIVERSAL model layer. Code knows KINDS (chat/vision/embed),
// PORTS, and how to detect + launch. It knows ZERO model names: every filename,
// path, flag set, and role binding lives in models.registry.json (shipped default
// in resources\, user override in <home>\models.registry.json — override wins
// per-key). Any GGUF in any listed folder can fill any role of its kind.

const fs = require('node:fs');
const path = require('node:path');

function expandFolder(p, opc1Root) {
  return String(p).replace(/%OPC1%/g, opc1Root);
}

function loadRegistry(opc1Root, resourcesDir) {
  let base = {};
  try { base = JSON.parse(fs.readFileSync(path.join(resourcesDir, 'models.registry.json'), 'utf8')); } catch {}
  let over = {};
  try { over = JSON.parse(fs.readFileSync(path.join(opc1Root, 'home', 'models.registry.json'), 'utf8')); } catch {}
  const merged = { ...base, ...over };
  merged.roles = { ...(base.roles || {}), ...((over.roles) || {}) };
  for (const [k, r] of Object.entries(merged.roles)) {
    if (over.roles && over.roles[k]) merged.roles[k] = { ...(base.roles || {})[k], ...over.roles[k] };
  }
  merged.overrides = { ...(base.overrides || {}), ...(over.overrides || {}) };
  merged.folders = (over.folders || base.folders || []).map((f) => expandFolder(f, opc1Root));
  merged.pool = over.pool || base.pool || [];
  return merged;
}

function slug(s) {
  return String(s).replace(/\.gguf$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64);
}

// Kind from the file alone — no name lists. Embedding models are universally
// named *-embed-*. Everything else is chat; a sibling mmproj projector makes it
// vision-CAPABLE (flag, not kind — a stray projector must never reclassify a
// text brain, proven live 2026-09-14: Ornith dir holds a stray mmproj).
function detectKind(file) {
  if (/embed/i.test(file)) return 'embed';
  return 'chat';
}

// Any folder holding <dir>/<file>.gguf pairs is a brain folder. Extra user
// folders (panel-added) merge in via extraFolders.
function scanModels(folders, extraFolders) {
  const roots = [...folders];
  for (const f of (extraFolders || [])) { const t = String(f).trim(); if (t && !roots.includes(t)) roots.push(t); }
  const out = [];
  const errors = [];
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
    catch (e) { errors.push(root + ': ' + e.message); continue; }
    // Flat root holding .gguf directly (no subdirs) counts too — one virtual dir.
    let flat = [];
    try { flat = fs.readdirSync(root).filter((f) => /\.gguf$/i.test(f)); } catch {}
    const dirList = dirs.length ? dirs : (flat.length ? ['.'] : []);
    for (const dir of dirList) {
      const full = dir === '.' ? root : path.join(root, dir);
      let files = [];
      try { files = fs.readdirSync(full).filter((f) => /\.gguf$/i.test(f)); } catch { continue; }
      const mmproj = files.find((f) => /mmproj/i.test(f));
      for (const f of files) {
        if (/mmproj/i.test(f)) continue;
        if (/mtp-|draft/i.test(f) && !/ABLITERATED-Q5_K_M|ABLITERATED-Q6_K/i.test(f)) continue; // speculative drafts
        let size = 0;
        try { size = fs.statSync(path.join(full, f)).size; } catch {}
        out.push({
          root, dir, file: f, path: path.join(full, f),
          mmproj: mmproj ? path.join(full, mmproj) : null,
          gb: Math.round((size / 1073741824) * 100) / 100,
          bytes: size,
          alias: slug(f),
          kind: detectKind(f),
          visionCapable: !!mmproj,
        });
      }
    }
  }
  // Disambiguate identical filenames in different dirs/roots.
  const seen = new Map();
  for (const m of out) {
    if (seen.has(m.alias)) {
      const first = seen.get(m.alias);
      if (!first.tagged) { first.alias = `${first.alias}-${first.dir}`; first.tagged = true; }
      m.alias = `${m.alias}-${m.dir}`;
    } else seen.set(m.alias, m);
  }
  return { models: out, roots, scanErrors: errors.length ? errors : undefined };
}

function findByFile(models, file) {
  const base = String(file).toLowerCase();
  return models.find((m) => m.file.toLowerCase() === base)
      || models.find((m) => m.file.toLowerCase().endsWith('/' + base) || m.file.toLowerCase().endsWith('\\' + base));
}

// Resolve a role to a concrete model: candidates in order (exact filename match,
// any kind — the user knows what they bound). '*' = any model that can serve the
// kind: exact kind, or visionCapable for the vision role. Thinker takes the
// largest (most capable); helper roles take the smallest that qualifies.
function roleFits(roleKind, m) {
  if (m.kind === roleKind) return true;
  if (roleKind === 'vision' && m.visionCapable) return true;
  return false;
}
function resolveRole(registry, roleName, scanned) {
  const role = (registry.roles || {})[roleName];
  if (!role) return null;
  for (const c of (role.candidates || [])) {
    if (c === '*') {
      const pool = scanned.filter((m) => roleFits(role.kind, m));
      if (!pool.length) continue;
      pool.sort((a, b) => (role.kind === 'chat' ? (b.bytes - a.bytes) : (a.bytes - b.bytes)));
      return { model: pool[0], via: '*' };
    } else {
      const m = findByFile(scanned, c);
      if (m) return { model: m, via: c };
    }
  }
  return null;
}

function subst(tpl, map) {
  return tpl.map((t) => String(t).replace(/\{(\w+)\}/g, (_, k) => (map[k] !== undefined ? String(map[k]) : `{${k}}`)));
}

// Build the llama-server argv for a role+model. Per-model overrides
// (registry.overrides[alias-or-file]: {ctx, gpu, extraArgs}) win over role data.
function roleArgs(registry, roleName, model, stateDir) {
  const role = registry.roles[roleName];
  const ov = (registry.overrides || {})[model.alias] || (registry.overrides || {})[model.file] || {};
  const ctx = ov.ctx || role.ctx || registry.genericChatCtx || 32768;
  const template = ov.template || role.template || '';
  const map = {
    model: model.path, mmproj: model.mmproj || '', template,
    port: role.port, ctx, alias: model.alias, state: stateDir,
  };
  let args = subst(role.argsBase || registry.genericChatArgs || [], map);
  if (ov.extraArgs && Array.isArray(ov.extraArgs)) args = args.concat(ov.extraArgs.map(String));
  // Drop mmproj/template pairs whose value is empty (role filled by a '*' model
  // that has no projector, or no chat template on disk).
  const clean = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--mmproj' || args[i] === '--chat-template-file') && !args[i + 1]) { i++; continue; }
    clean.push(args[i]);
  }
  return { args: clean, gpu: String(ov.gpu || role.gpu || '0'), port: role.port, ctx };
}

// Generic pool-model argv (any chat/vision/embed GGUF on any free port).
function poolArgs(registry, model, port, ctx, stateDir) {
  const ov = (registry.overrides || {})[model.alias] || (registry.overrides || {})[model.file] || {};
  const map = {
    model: model.path, mmproj: model.mmproj || '', template: ov.template || '',
    port, ctx: ov.ctx || ctx || registry.genericChatCtx || 32768, alias: model.alias, state: stateDir,
  };
  let args = subst(registry.genericChatArgs || [], map);
  if (model.kind === 'embed') args.push('--embeddings', '--pooling', 'mean');
  if (model.mmproj) args.push('--mmproj', model.mmproj);
  if (ov.extraArgs && Array.isArray(ov.extraArgs)) args = args.concat(ov.extraArgs.map(String));
  return { args, gpu: String(ov.gpu !== undefined ? ov.gpu : '0') };
}

module.exports = { loadRegistry, expandFolder, slug, detectKind, scanModels, findByFile, roleFits, resolveRole, roleArgs, poolArgs };
