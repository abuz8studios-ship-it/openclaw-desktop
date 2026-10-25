// OPC1-CLI.cmd token source. Prints the gateway auth token on stdout with no
// trailing newline, for capture by the caller's `for /f`.
//
// Why a helper file at all: batch cannot parse JSON, and inlining a
// `node -e "...json..."` into a for/f backtick fails on the nested quotes
// ("The filename, directory name, or volume label syntax is incorrect"). A
// separate .cjs keeps the quoting trivial.
//
// Never fails loudly: if the config is missing or unreadable the CLI still runs,
// it just cannot authenticate to the gateway websocket - which is the same
// state as before this existed, and a visible error would be worse than a
// missing variable.
const fs = require('node:fs');
const path = require('node:path');

try {
  const raw = fs.readFileSync(path.resolve(process.argv[2]), 'utf8');
  const cfg = JSON.parse(raw);
  const token = cfg?.gateway?.auth?.token;
  if (typeof token === 'string' && token.length) process.stdout.write(token);
} catch {
  /* leave stdout empty; caller proceeds without a token */
}
