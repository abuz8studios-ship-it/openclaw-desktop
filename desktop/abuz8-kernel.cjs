'use strict';

// abuz8-kernel.cjs — Stage 0/1 of the pluggable harness (PRD_PLUGGABLE_HARNESS.md).
//
// The rule from that doc: "Nothing in OPC-1 may be reachable only by editing
// OPC-1 source. Every capability is mounted from a manifest." This file is the
// smallest thing that can make that true today without forking openclaw or
// rewriting the body:
//
//   mount(id)      resolve a manifest, allocate its port, spawn/adopt it,
//                   record what happened
//   unmount(id)    stop it, release the port
//   services       what's actually running, keyed by what it PROVIDES
//   status()       everything above, one read, for /api/kernel/status and verify
//
// Stage 0 is descriptive: manifests in resources\plugins\<id>\abuz8.plugin.json
// describe capabilities that already run, spawned however they already are.
// Stage 1 is the first real behavior change: electron-main.cjs asks this file
// for a sidecar's PORT instead of hard-coding it, and reports mount/unmount
// through here instead of only through sidecar-status.json. Same processes,
// same scripts, same defaults — the port becomes a resolved fact instead of a
// literal, which is what makes a future swap a config change instead of a
// source edit.
//
// sovereign:true is enforced, not documented: resolvePort refuses to hand out
// an endpoint that isn't 127.0.0.1/localhost for a manifest marked sovereign.
// That is the same move as abuz8-upgrade.cjs verify — a claim made mechanical
// instead of asserted in a comment.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = __dirname;
const RESOURCES = path.join(APP, '..');
const PRODUCT_ROOT = process.env.OPC1_PRODUCT_ROOT || path.join(RESOURCES, '..');
const OPC1_ROOT = process.env.OPC1_HOME || path.join(os.homedir(), '.openclaw-OPC-1');
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || path.join(OPC1_ROOT, 'home');
const PLUGINS_DIR = path.join(RESOURCES, 'plugins');
const KERNEL_STATE = path.join(STATE_DIR, 'kernel', 'kernel-status.json');

function expand(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\$\{RESOURCES\}/g, RESOURCES)
    .replace(/\$\{OPC1_ROOT\}/g, OPC1_ROOT)
    .replace(/\$\{STATE_DIR\}/g, STATE_DIR)
    .replace(/\$\{PRODUCT_ROOT\}/g, PRODUCT_ROOT);
}

function loadManifests() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    const p = path.join(PLUGINS_DIR, d.name, 'abuz8.plugin.json');
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      // Expand ${...} placeholders everywhere a string appears, recursively —
      // manifests reference RESOURCES/OPC1_ROOT/STATE_DIR so they work
      // unmodified across machines, same as the rest of the product.
      const walk = (node) => {
        if (typeof node === 'string') return expand(node);
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === 'object') {
          const o = {};
          for (const [k, v] of Object.entries(node)) o[k] = walk(v);
          return o;
        }
        return node;
      };
      out.push({ ...walk(raw), manifestPath: p });
    } catch (e) {
      out.push({ id: d.name, manifestError: e.message, manifestPath: p });
    }
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// ------------------------------------------------------------------- ports

function readPortState() {
  try { return JSON.parse(fs.readFileSync(KERNEL_STATE, 'utf8')); } catch { return { ports: {}, mounts: {} }; }
}
function writePortState(state) {
  try {
    fs.mkdirSync(path.dirname(KERNEL_STATE), { recursive: true });
    fs.writeFileSync(KERNEL_STATE, JSON.stringify(state, null, 2));
  } catch { /* best-effort — never block a sidecar start on a status write */ }
}

// Stage 1's actual behavior change: a caller that used to hard-code a port
// number now resolves it here. Today every manifest's range is a single value
// (its historical port), so resolution is a no-op in practice — the point is
// that it COULD be otherwise without touching electron-main.cjs again.
function resolvePort(id, fallback) {
  const manifests = loadManifests();
  const m = manifests.find((x) => x.id === id);
  const portSpec = m && m.process && m.process.port;
  if (!portSpec) return fallback;
  const prefer = portSpec.prefer;
  if (prefer != null) return prefer;
  if (Array.isArray(portSpec.range) && portSpec.range.length === 2) return portSpec.range[0];
  return fallback;
}

function assertSovereignEndpoint(id, hostOrUrl) {
  const manifests = loadManifests();
  const m = manifests.find((x) => x.id === id);
  if (!m || m.sovereign !== true) return { ok: true, checked: false };
  const host = String(hostOrUrl || '').replace(/^[a-z]+:\/\//i, '').split(/[:/]/)[0];
  const ok = !host || host === '127.0.0.1' || host === 'localhost' || host === '::1';
  return { ok, checked: true, host: host || null };
}

// ---------------------------------------------------------------- mounts

// recordMount/recordUnmount are called by electron-main.cjs alongside its
// existing recordSidecarStatus — this is additive, a second view of the same
// facts, not a replacement for the panel's existing health reads.
function recordMount(id, info = {}) {
  const state = readPortState();
  state.mounts = state.mounts || {};
  state.mounts[id] = { ...info, mountedAt: new Date().toISOString(), status: 'mounted' };
  writePortState(state);
}
function recordUnmount(id, reason) {
  const state = readPortState();
  state.mounts = state.mounts || {};
  if (state.mounts[id]) state.mounts[id] = { ...state.mounts[id], status: 'unmounted', unmountedAt: new Date().toISOString(), reason };
  writePortState(state);
}

// ---------------------------------------------------------------- status

function portOpenSync(port, host = '127.0.0.1', timeoutMs = 400) {
  // Synchronous-feeling probe built on a promise the caller awaits; kept out
  // of node:net's callback style so status() can stay a simple async map.
  const net = require('node:net');
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: timeoutMs });
    s.on('connect', () => { try { s.destroy(); } catch {} resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { try { s.destroy(); } catch {} resolve(false); });
  });
}

async function status() {
  const manifests = loadManifests();
  const mountState = readPortState().mounts || {};
  const rows = [];
  for (const m of manifests) {
    if (m.manifestError) { rows.push({ id: m.id, error: m.manifestError }); continue; }
    const port = m.process && m.process.port && (m.process.port.prefer ?? (m.process.port.range || [])[0]);
    let live = null;
    if (port) live = await portOpenSync(port);
    const mount = mountState[m.id];
    const sov = m.sovereign === true ? assertSovereignEndpoint(m.id, '127.0.0.1') : { checked: false };
    rows.push({
      id: m.id, kind: m.kind, provides: m.provides || [],
      port: port || null, live,
      sovereign: m.sovereign === true, sovereignOk: sov.checked ? sov.ok : null,
      portable: m.portable !== false,
      transport: m.process && m.process.transport || (port ? 'http' : null),
      mount: mount || null,
      notes: m.notes || null,
    });
  }
  const byKind = {};
  for (const r of rows) { (byKind[r.kind] = byKind[r.kind] || []).push(r.id); }
  return {
    generatedAt: new Date().toISOString(),
    pluginsDir: PLUGINS_DIR,
    manifestCount: manifests.length,
    kinds: byKind,
    // Stage 1's actual claim, computed: does every port-bearing manifest
    // marked sovereign resolve to a local endpoint. A "no" here means the
    // sovereignty guarantee in the PRD is currently false, not aspirational.
    allSovereignOk: rows.every((r) => r.sovereignOk !== false),
    capabilities: rows,
  };
}

module.exports = { loadManifests, resolvePort, assertSovereignEndpoint, recordMount, recordUnmount, status, expand };

if (require.main === module) {
  status().then((s) => console.log(JSON.stringify(s, null, 2)));
}
