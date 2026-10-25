'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

// One shared, non-blocking interpreter resolver. Cache entries are tied to the
// resolved executable and imported package files, and expire after six hours.
function createPythonProbes(cachePath) {
  const pending = new Map();
  let cache;
  let writes = Promise.resolve();
  async function readCache() {
    if (!cache) cache = fs.readFile(cachePath, 'utf8').then(JSON.parse).catch(() => ({}));
    return cache;
  }
  function run(cmd, args, timeout = 30000) {
    return new Promise((resolve) => {
      execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 65536, encoding: 'utf8' },
        (error, stdout) => resolve({ ok: !error, stdout: stdout || '' }));
    });
  }
  async function stamp(file) {
    try { const s = await fs.stat(file); return [file, s.size, s.mtimeMs]; }
    catch { return null; }
  }
  async function valid(record) {
    if (!record || !record.python || !Array.isArray(record.files) || !record.files.length ||
        Date.now() - record.at < 0 || Date.now() - record.at > 6 * 60 * 60 * 1000) return false;
    const current = await Promise.all(record.files.map(([file]) => stamp(file)));
    return current.every((s, i) => s && s[1] === record.files[i][1] && s[2] === record.files[i][2]);
  }
  async function persist() {
    const data = await readCache();
    writes = writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      const temp = `${cachePath}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(data, null, 2));
      await fs.rename(temp, cachePath);
    }).catch(() => {});
    await writes;
  }
  async function probe(candidates, modules) {
    const key = createHash('sha256').update(JSON.stringify({ version: 1, candidates, modules,
      searchPath: process.env.PATH || '', pythonPath: process.env.PYTHONPATH || '' })).digest('hex');
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      const data = await readCache();
      if (await valid(data[key])) return { ...data[key].python, pre: [...data[key].python.pre] };
      for (const c of candidates) {
        // A single process validates Python, imports its required packages and
        // returns sys.executable. This removes py/venv launcher ownership drift.
        const script = 'import sys,json,importlib\n' +
          'assert sys.version_info >= (3,10)\n' +
          `mods=[importlib.import_module(m) for m in ${JSON.stringify(modules)}]\n` +
          'print("OPC1_PYTHON_PROBE="+json.dumps({"executable":sys.executable,"files":[getattr(m,"__file__",None) for m in mods]}))';
        const result = await run(c.cmd, [...c.pre, '-c', script]);
        if (!result.ok) continue;
        const line = result.stdout.split(/\r?\n/).find((s) => s.startsWith('OPC1_PYTHON_PROBE='));
        if (!line) continue;
        try {
          const found = JSON.parse(line.slice('OPC1_PYTHON_PROBE='.length));
          if (!path.isAbsolute(found.executable)) continue;
          const files = await Promise.all([found.executable, ...found.files.filter(Boolean)].map(stamp));
          if (files.some((s) => !s)) continue;
          const python = { cmd: found.executable, pre: [], label: c.label };
          data[key] = { at: Date.now(), python, files };
          // Keep the cache bounded even when environment/interpreter settings change.
          for (const old of Object.keys(data).sort((a, b) => data[b].at - data[a].at).slice(16)) delete data[old];
          await persist();
          return python;
        } catch { /* malformed interpreter output: try the next candidate */ }
      }
      delete data[key];
      return null;
    })();
    pending.set(key, job);
    try { return await job; }
    finally { pending.delete(key); }
  }
  return { probe };
}

module.exports = { createPythonProbes };
