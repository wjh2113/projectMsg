/**
 * Static macOS / cross-platform readiness checks (no Mac required).
 * Run: node scripts/check-macos-support.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'server/process.js',
  'server/deploy.js',
  'server/git.js',
  'server/scanner.js',
  'server/store.js',
  'server/db.js',
  'package.json',
];

let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    fail += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const processJs = fs.readFileSync(path.join(root, 'server/process.js'), 'utf8');
ok('runtime uses npm on non-Windows', /isWin \? 'npm\.cmd' : 'npm'/.test(processJs));
ok('runtime kill uses SIGTERM on unix', /process\.kill\(-pid, 'SIGTERM'\)/.test(processJs));
ok('no hard taskkill-only path', /platform === 'win32'[\s\S]*taskkill/.test(processJs));

const deployJs = fs.readFileSync(path.join(root, 'server/deploy.js'), 'utf8');
ok('ssh bin resolves to ssh on darwin', /platform === 'win32' \? \['ssh\.exe'/.test(deployJs));

const storeJs = fs.readFileSync(path.join(root, 'server/store.js'), 'utf8');
ok('default scan roots are platform-aware', /platform === 'darwin'/.test(storeJs));

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
ok('no windows-only native deps', !JSON.stringify(pkg.dependencies || {}).includes('node-windows'));
ok('node engine allows modern mac node', String(pkg.engines?.node || '').includes('18'));

const engines = pkg.engines?.node || '';
ok('stack is Node+Express+React+pg (cross-platform)', Boolean(pkg.dependencies?.express && pkg.dependencies?.pg && pkg.dependencies?.react));

console.log('\nPlatform notes:');
console.log('- Hub/Agent on macOS: Node 18+, PostgreSQL, git, OpenSSH (usually preinstalled)');
console.log('- Scan roots: /Users/... or /Volumes/... (not D:\\ or UNC)');
console.log('- Multi-Mac: each Mac runs agent → hub; paths stay local to that node');
console.log(`\nResult: ${fail === 0 ? 'READY for macOS (with Postgres + path config)' : `${fail} issue(s)`}`);
process.exit(fail === 0 ? 0 : 1);
