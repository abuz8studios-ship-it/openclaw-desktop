'use strict';

// OPC-1's one provider/model resolver.  This is a read-only index: runtime
// ownership remains with the model registry and direct provider endpoints.
// Keeping resolution here prevents those surfaces from silently disagreeing.
const fs = require('node:fs');
const path = require('node:path');

const { STATE_DIR } = require('./abuz8-config.cjs');
const ERROR_CAP = 2048;
const REGISTRY_FILE = path.join(STATE_DIR, 'models.registry.json');
const OPENCLAW_FILE = path.join(STATE_DIR, 'openclaw.json');
const CLIBRAINS_FILE = path.join(__dirname, '..', 'subscription', 'server.py');
const memo = new Map();
const errors = [];

function noteError(message) {
  errors.push(String(message).slice(0, ERROR_CAP));
  while (errors.length > ERROR_CAP) errors.shift();
}

function readMemo(file, parser) {
  const key = file.toLowerCase();
  let stat;
  try { stat = fs.statSync(file); }
  catch (e) { noteError(`${file}: ${e.message}`); return null; }
  const fingerprint = { mtimeMs: stat.mtimeMs, size: stat.size };
  const old = memo.get(key);
  if (old && old.mtimeMs === fingerprint.mtimeMs && old.size === fingerprint.size) return old.value;
  try {
    const value = parser(fs.readFileSync(file, 'utf8'));
    memo.set(key, { ...fingerprint, value });
    return value;
  } catch (e) {
    noteError(`${file}: ${e.message}`);
    return null;
  }
}

function parseProviders(text) {
  const cfg = JSON.parse(text);
  const out = [];
  for (const [provider, entry] of Object.entries(cfg.models?.providers || {})) {
    for (const model of entry.models || []) {
      if (!model?.id) continue;
      out.push({
        source: 'openclaw', kind: 'provider', provider, model: String(model.id),
        ref: `${provider}/${model.id}`, baseUrl: entry.baseUrl || null,
      });
    }
  }
  return out;
}

function parseRegistry(text) {
  const reg = JSON.parse(text);
  const out = [];
  for (const [role, entry] of Object.entries(reg.roles || {})) {
    for (const candidate of entry.candidates || []) {
      if (candidate === '*') continue;
      out.push({ source: 'models.registry.json', kind: 'local-role', role, model: candidate, ref: `${role}/${candidate}`, port: entry.port, gpu: entry.gpu });
    }
  }
  for (const model of reg.pool || []) {
    if (model?.file) out.push({ source: 'models.registry.json', kind: 'local-pool', model: model.file, ref: `pool/${model.file}` });
  }
  return out;
}

function parseCliBrains(text) {
  const out = [];
  const re = /CLIAdapter\("(cli-[^"]+)",\s*"([^"]*)",\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(text))) {
    out.push({ source: 'clibrains', kind: 'cli-adapter', model: match[1], ref: `cli-brains/${match[1]}`, label: match[2], binary: match[3] });
  }
  return out;
}

function inventory() {
  const out = [];
  out.push(...(readMemo(OPENCLAW_FILE, parseProviders) || []));
  out.push(...(readMemo(REGISTRY_FILE, parseRegistry) || []));
  out.push(...(readMemo(CLIBRAINS_FILE, parseCliBrains) || []));
  const unique = new Map();
  for (const item of out) unique.set(`${item.source}:${item.ref}`, item);
  return [...unique.values()];
}

function resolve(ref) {
  const query = String(ref || '').trim();
  if (!query) return { ok: false, query, match: null, candidates: [], errors: [...errors] };
  const lower = query.toLowerCase();
  const items = inventory();
  const matches = items.filter((item) => [item.ref, item.model, item.backend].some((value) => String(value || '').toLowerCase() === lower));
  return { ok: matches.length > 0, query, match: matches[0] || null, candidates: matches, errors: [...errors] };
}

function list() { return inventory(); }

function snapshot() {
  const items = inventory();
  return {
    version: 1, count: items.length, errors: [...errors], errorCap: ERROR_CAP,
    sources: [...new Set(items.map((item) => item.source))].sort(),
    memo: [...memo.entries()].map(([file, value]) => ({ file, mtimeMs: value.mtimeMs, size: value.size })),
  };
}

function clearCache() { memo.clear(); errors.length = 0; }

module.exports = { ERROR_CAP, resolve, list, snapshot, clearCache };
