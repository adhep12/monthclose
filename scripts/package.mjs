// Checks app/ against the bp-vibes deploy rules (see CLAUDE.md) and zips it to dist/monthclose.zip.
//   node scripts/package.mjs          check + zip
//   node scripts/package.mjs --check  check only
// In the zip, css/, js/ and vendor/ sit in a folder named for the build (b202609300130/) and
// index.html points there, so a new deploy never runs with a browser's cached copy of the last one.
import { readdirSync, statSync, mkdirSync, rmSync, existsSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
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
const build = `b${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}`;
const stage = join(out, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, build), { recursive: true });
for (const name of readdirSync(ROOT)) {
  const inBuild = statSync(join(ROOT, name)).isDirectory();
  cpSync(join(ROOT, name), inBuild ? join(stage, build, name) : join(stage, name), { recursive: true });
}
const html = readFileSync(join(stage, 'index.html'), 'utf8');
const pointed = html.replace(/(href|src)="(css|js|vendor)\//g, `$1="${build}/$2/`);
if (!pointed.includes(`${build}/js/app.js`)) { console.error('✗ index.html no longer loads js/app.js; update scripts/package.mjs'); process.exit(1); }
writeFileSync(join(stage, 'index.html'), pointed);
execFileSync('zip', ['-qr', zip, '.'], { cwd: stage });
rmSync(stage, { recursive: true, force: true });
console.log(`✓ wrote ${relative(process.cwd(), zip)} (build ${build}) — upload it on the app's Deploy card in HAL`);
