'use strict';
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

// Windows Terminal may be the default console host after a Windows update.
// OpenClaw periodically creates short-lived CLI and SQLite helper processes;
// force these background children to stay hidden, including ESM imports of
// node:child_process made later by the bundled gateway.
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[name];
  childProcess[name] = function (...args) {
    const optionIndex = name === 'exec' || name === 'execSync' ? 1 : 2;
    if ((name === 'spawn' || name === 'spawnSync' || name === 'execFile' ||
         name === 'execFileSync' || name === 'fork') && !Array.isArray(args[1])) {
      args.splice(1, 0, []);
    }
    const current = args[optionIndex];
    if (typeof current === 'function') args.splice(optionIndex, 0, { windowsHide: true });
    else args[optionIndex] = { ...(current || {}), windowsHide: true };
    return original.apply(this, args);
  };
  if (name === 'execFile' || name === 'exec') {
    Object.defineProperty(childProcess[name], require('node:util').promisify.custom, {
      value: (...args) => {
        let child;
        const promise = new Promise((resolve, reject) => {
          child = childProcess[name](...args, (error, stdout, stderr) => {
            if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
            else resolve({ stdout, stderr });
          });
        });
        promise.child = child;
        return promise;
      }
    });
  }
}
syncBuiltinESMExports();
