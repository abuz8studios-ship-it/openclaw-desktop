'use strict';

// abuz8-tokenomics.cjs — where the tokens actually go.
//
// Ahmad 2026-09-20: "I want ... tokenomics ... live working."
//
// The numbers already exist; nothing was aggregating them. Every model call
// OpenClaw makes lands in an agent database as a transcript event carrying the
// provider, the model, and a usage block:
//
//   {"provider":"ornith-local","model":"ornith-1.5-35b-a3b",
//    "usage":{"input":21723,"output":2450,"cacheRead":0,"cacheWrite":0,
//             "totalTokens":24173,"cost":{"input":0,...,"total":0}}}
//
// This module reads those events across every agent and rolls them up by model,
// provider, agent and day. It is strictly READ-ONLY: the agent databases are
// opened with readOnly:true and never written. That matters here specifically —
// writing to session_nodes.entry_json sets entry_valid=0 and bricks the CLI, so
// this file never touches it and only parses what it finds.
//
// Local inference reports cost 0, which is correct rather than missing: the
// llama-server brains cost nothing per call. So the money view is really "what
// did the CLOUD lanes cost", and the token view is "what did the whole fleet
// think", including the free local work. Both are reported, never conflated.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OPC1_ROOT = process.env.OPC1_HOME || path.join(os.homedir(), '.openclaw-OPC-1');
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || path.join(OPC1_ROOT, 'home');
const AGENTS_DIR = path.join(STATE_DIR, 'agents');

// node:sqlite is a Node builtin, but the panel runs inside ELECTRON, whose
// bundled Node does not expose it — so requiring it here succeeds under the
// bundled node.exe and fails in the process that actually serves /api. Rather
// than take a dependency on some plugin's private better-sqlite3, the module
// re-runs itself under the bundled runtime and parses the result. Same code,
// same queries, one known-good sqlite.
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* fallback below */ }

function bundledNodeExe() {
  const RESOURCES_DIR = path.join(__dirname, '..');
  for (const p of [
    process.env.OPC1_UPGRADE_NODE,
    path.join(RESOURCES_DIR, 'runtime', 'node', 'node.exe'),
    path.join(OPC1_ROOT, 'runtime', 'node', 'node.exe'),
  ]) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function viaBundledNode(days) {
  const exe = bundledNodeExe();
  if (!exe) return { error: 'node:sqlite unavailable and no bundled node.exe found' };
  const r = require('node:child_process').spawnSync(
    exe, [__filename, `--days=${days}`],
    { encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 64 * 1024 * 1024 },
  );
  const out = (r.stdout || '').trim();
  const i = out.indexOf('{');
  if (i < 0) return { error: `bundled-node rollup produced no JSON: ${(r.stderr || out).slice(-300)}` };
  try { return JSON.parse(out.slice(i)); }
  catch (e) { return { error: `bundled-node rollup unparseable: ${e.message}` }; }
}

function agentDatabases() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const db = path.join(AGENTS_DIR, d.name, 'agent', 'openclaw-agent.sqlite');
    if (fs.existsSync(db)) out.push({ agent: d.name, db });
  }
  return out;
}

const dayOf = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 'unknown';
  return new Date(n > 1e12 ? n : n * 1000).toISOString().slice(0, 10);
};

function addInto(bucket, key, rec) {
  const b = bucket[key] || (bucket[key] = {
    calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0,
  });
  b.calls += 1;
  b.input += rec.input;
  b.output += rec.output;
  b.cacheRead += rec.cacheRead;
  b.cacheWrite += rec.cacheWrite;
  b.totalTokens += rec.totalTokens;
  b.costUsd += rec.costUsd;
  return b;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Usage blocks are nested at varying depths across event shapes, so the event
// is walked rather than assumed. Each object carrying a usage block together
// with a model is one billable call.
function harvest(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const v of node) harvest(v, out); return; }
  const u = node.usage;
  if (u && typeof u === 'object' && (node.model || node.provider)) {
    const cost = u.cost && typeof u.cost === 'object' ? u.cost : {};
    out.push({
      provider: String(node.provider || 'unknown'),
      model: String(node.model || 'unknown'),
      api: node.api ? String(node.api) : null,
      at: num(node.timestamp) || 0,
      input: num(u.input ?? u.inputTokens ?? u.promptTokens),
      output: num(u.output ?? u.outputTokens ?? u.completionTokens),
      cacheRead: num(u.cacheRead),
      cacheWrite: num(u.cacheWrite),
      totalTokens: num(u.totalTokens) || (num(u.input) + num(u.output)),
      costUsd: num(cost.total ?? u.estimatedCostUsd),
    });
  }
  for (const v of Object.values(node)) harvest(v, out);
}

function scanAgent(entry, sinceMs) {
  const rows = [];
  if (!DatabaseSync) return { rows, error: 'node:sqlite unavailable on this runtime' };
  let db;
  try { db = new DatabaseSync(entry.db, { readOnly: true }); }
  catch (e) { return { rows, error: `open failed: ${e.message}` }; }
  try {
    // Filter in SQL first: only a minority of events carry usage, and parsing
    // every transcript event of every agent on each request is wasteful.
    const stmt = db.prepare(
      `SELECT event_json, created_at FROM transcript_events
       WHERE event_json LIKE '%"usage"%' ${sinceMs ? 'AND created_at >= ?' : ''}`,
    );
    for (const r of (sinceMs ? stmt.all(sinceMs) : stmt.all())) {
      let parsed;
      try { parsed = JSON.parse(r.event_json); } catch { continue; }
      const found = [];
      harvest(parsed, found);
      for (const f of found) {
        if (!f.at) f.at = num(r.created_at);
        f.agent = entry.agent;
        rows.push(f);
      }
    }
  } catch (e) {
    try { db.close(); } catch {}
    return { rows, error: `query failed: ${e.message}` };
  }
  try { db.close(); } catch {}
  return { rows, error: null };
}

let CACHE = { key: null, at: 0, value: null };

function tokenomics({ days = 30, refresh = false } = {}) {
  const sinceMs = days > 0 ? Date.now() - days * 86400000 : 0;
  const dbs = agentDatabases();
  const sig = dbs.map((d) => {
    let m = 0; try { m = fs.statSync(d.db).mtimeMs; } catch {}
    return `${d.agent}:${Math.round(m)}`;
  }).join('|') + `#${days}`;

  // Re-scanning tens of thousands of events per request is the difference
  // between a panel that opens and one that hangs. Invalidated by agent-db
  // mtime, so new calls still show up as soon as they are written.
  if (!refresh && CACHE.key === sig && Date.now() - CACHE.at < 60000) return CACHE.value;

  // Wrong runtime for sqlite: delegate the whole rollup to the bundled Node,
  // then cache the answer here so the panel pays the subprocess cost once.
  if (!DatabaseSync) {
    const delegated = viaBundledNode(days);
    if (!delegated.error) {
      delegated.via = 'bundled-node';
      CACHE = { key: sig, at: Date.now(), value: delegated };
      return delegated;
    }
    return { generatedAt: new Date().toISOString(), windowDays: days, error: delegated.error, totals: null };
  }

  const byModel = {}, byProvider = {}, byAgent = {}, byDay = {};
  const totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
  const errors = [];
  let firstAt = null, lastAt = null;

  for (const entry of dbs) {
    const { rows, error } = scanAgent(entry, sinceMs);
    if (error) errors.push({ agent: entry.agent, error });
    for (const r of rows) {
      addInto(byModel, `${r.provider}/${r.model}`, r);
      addInto(byProvider, r.provider, r);
      addInto(byAgent, r.agent, r);
      addInto(byDay, dayOf(r.at), r);
      totals.calls += 1;
      totals.input += r.input; totals.output += r.output;
      totals.cacheRead += r.cacheRead; totals.cacheWrite += r.cacheWrite;
      totals.totalTokens += r.totalTokens; totals.costUsd += r.costUsd;
      if (r.at) {
        if (firstAt === null || r.at < firstAt) firstAt = r.at;
        if (lastAt === null || r.at > lastAt) lastAt = r.at;
      }
    }
  }

  const sorted = (o) => Object.entries(o)
    .map(([k, v]) => ({ key: k, ...v, costUsd: Number(v.costUsd.toFixed(6)) }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  // The split Ahmad actually cares about: local inference is free, so a big
  // token count is not a big bill. Reporting one number would hide that.
  const localish = (k) => /^(local|ornith|vision-local|local-fallback|embed)/i.test(k);
  const localTokens = sorted(byProvider).filter((p) => localish(p.key)).reduce((s, p) => s + p.totalTokens, 0);

  const value = {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    agentsScanned: dbs.map((d) => d.agent),
    range: { first: firstAt ? new Date(firstAt).toISOString() : null, last: lastAt ? new Date(lastAt).toISOString() : null },
    totals: { ...totals, costUsd: Number(totals.costUsd.toFixed(6)) },
    split: {
      localTokens,
      cloudTokens: totals.totalTokens - localTokens,
      localShare: totals.totalTokens ? Number((localTokens / totals.totalTokens).toFixed(4)) : null,
      note: 'Local lanes report cost 0 because they are free; cost here is real cloud spend only.',
    },
    byModel: sorted(byModel),
    byProvider: sorted(byProvider),
    byAgent: sorted(byAgent),
    byDay: Object.entries(byDay)
      .map(([k, v]) => ({ day: k, ...v, costUsd: Number(v.costUsd.toFixed(6)) }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    errors,
  };
  CACHE = { key: sig, at: Date.now(), value };
  return value;
}

module.exports = { tokenomics, agentDatabases };

if (require.main === module) {
  const days = Number((process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1]) || 30;
  console.log(JSON.stringify(tokenomics({ days, refresh: true }), null, 2));
}
