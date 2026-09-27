// Checks app/ against the bp-vibes deploy rules (see CLAUDE.md) and zips it to dist/monthclose.zip.
//   node scripts/package.mjs          check + zip
//   node scripts/package.mjs --check  check only
import { readdirSync, statSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../app/', import.meta.url).pathname;
const ALLOWED = new Set(('html htm css js mjs map json xml txt md svg png jpg jpeg gif webp avif ico bmp ' +
  'woff woff2 ttf otf eot wasm webmanifest pdf csv thumbnail').split(' '));

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p); else files.push(relative(ROOT, p));
  }
})(ROOT);

const problems = [];
for (const f of files) {
  const ext = extname(f).slice(1).toLowerCase();
  if (!ALLOWED.has(ext)) problems.push(`not an allowed file type: ${f}`);
}
if (!files.includes('index.html')) problems.push('index.html must be at the root of app/');
if (!files.includes('vibes.json')) problems.push('vibes.json must be at the root of app/');
const size = files.reduce((t, f) => t + statSync(join(ROOT, f)).size, 0);
if (size > 200 * 1024 * 1024) problems.push('bundle is over 200 MB');

if (problems.length) { console.error(problems.map((p) => `✗ ${p}`).join('\n')); process.exit(1); }
console.log(`✓ ${files.length} files, ${(size / 1024).toFixed(0)} KB — deployable`);
if (process.argv.includes('--check')) process.exit(0);

const out = new URL('../dist/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const zip = join(out, 'monthclose.zip');
if (existsSync(zip)) rmSync(zip);
execFileSync('zip', ['-qr', zip, '.'], { cwd: ROOT });
console.log(`✓ wrote ${relative(process.cwd(), zip)} — upload it on the app's Deploy card in HAL`);
