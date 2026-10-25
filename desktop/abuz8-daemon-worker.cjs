'use strict';

// The gateway stays bundled with this product. Electron owns this worker over
// Node IPC; no system OpenClaw install or upstream gateway process is used.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
require('./abuz8-hidden-children.cjs');
// Propagate console hiding to Node broker/CLI grandchildren as well.
const hiddenPreload = '--require=' + JSON.stringify(require('node:path').join(__dirname, 'abuz8-hidden-children.cjs'));
if (!(process.env.NODE_OPTIONS || '').includes('abuz8-hidden-children.cjs')) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, hiddenPreload].filter(Boolean).join(' ');
}

const entry = path.join(__dirname, 'dist', 'index.js');

function send(type, payload = {}) {
  if (typeof process.send === 'function') process.send({ type, ...payload });
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'ping') send('pong', { at: Date.now() });
  if (message.type === 'engine-state') send('engine-state-ack', {
    state: message.state,
    port: message.port,
  });
  if (message.type === 'shutdown') process.exit(0);
});

(async () => {
  try {
    // NOTE 2026-09-03: setting process.argv to include 'gateway' enables the memos
    // Memory Viewer, but caused gateway boot fights (EADDRINUSE loop) — reverted to
    // stable. Viewer hunt continues separately. Do NOT re-add without a clean test.
    const port = String(process.env.OPENCLAW_GATEWAY_PORT || 18789);
    // Electron supplies a 4 GiB old-space cap; report the effective V8 limit so
    // it can be checked independently of a configured environment string.
    const heapLimitMiB = Math.round(require('node:v8').getHeapStatistics().heap_size_limit / 1048576);
    console.error(`[daemon-worker] heap limit=${heapLimitMiB}MiB approach=bounded-4096-old-space`);
    const openclaw = await import(pathToFileURL(entry).href);
    send('loaded', { entry });
    await openclaw.runLegacyCliEntry([
      process.execPath,
      entry,
      'gateway',
      'run',
      '--port',
      port,
      '--allow-unconfigured',
    ]);
  } catch (error) {
    const message = error && error.stack ? error.stack : String(error);
    console.error(`[daemon-worker] ${message}`);
    send('error', { message });
    process.exitCode = 1;
  }
})();
