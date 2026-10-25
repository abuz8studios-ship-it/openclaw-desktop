// apply-side-calendar.cjs - deploy/re-apply the OPC-1 sidebar calendar.
// Run after every upstream overlay (a new dist/ wipes dist/control-ui/).
// Idempotent: copies the sidecar beside index.html and ensures exactly
// one script tag points at it. Backs index.html up once per upstream
// version. Usage: <bundled node> apply-side-calendar.cjs [appDir]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const appDir = process.argv[2] || 'C:/ABUZ8-Agents/ABUZ8-OPC-1/resources/app';
const uiDir = path.join(appDir, 'dist', 'control-ui');
const indexPath = path.join(uiDir, 'index.html');
const srcPath = path.join(__dirname, 'opc1-side-calendar.js');
const destPath = path.join(uiDir, 'opc1-side-calendar.js');

const version = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
const now = new Date();
const stamp = now.toISOString().slice(0, 10).replace(/-/g, '') +
  '-' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') +
  String(now.getSeconds()).padStart(2, '0');
const tag = `<script src="./opc1-side-calendar.js?v=${stamp}"></script>`;

fs.copyFileSync(srcPath, destPath);

let html = fs.readFileSync(indexPath, 'utf8');
const backup = `${indexPath}.bak-pre-calendar-${version}`;
if (!fs.existsSync(backup)) fs.copyFileSync(indexPath, backup);

// Drop any previous sidecar tag, then add one before </body> (or at end).
html = html.replace(/<script src="\.\/opc1-side-calendar\.js[^"]*"><\/script>\s*/g, '');
html = html.includes('</body>') ? html.replace('</body>', `${tag}\n</body>`) : html + '\n' + tag + '\n';
fs.writeFileSync(indexPath, html);

const check = fs.readFileSync(indexPath, 'utf8');
const tags = (check.match(/opc1-side-calendar\.js/g) || []).length;
if (tags !== 1 || !fs.existsSync(destPath)) {
  throw new Error(`apply failed: tags=${tags} dest=${fs.existsSync(destPath)}`);
}
console.log(JSON.stringify({ ok: true, version, tag, dest: destPath, backup }));
