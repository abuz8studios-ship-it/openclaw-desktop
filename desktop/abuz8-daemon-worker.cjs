'use strict';

// The gateway stays bundled with this product. Electron owns this worker over
// Node IPC; no system OpenClaw install or upstream gateway process is used.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
    const port = String(process.env.OPENCLAW_GATEWAY_PORT || 5119);
    const openclaw = await import(pathToFileURL(entry).href);
    send('loaded', { entry });
    await openclaw.runLegacyCliEntry([
      process.execPath,
      entry,
      'gateway',
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
