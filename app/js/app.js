import { h, mount, toast } from './ui.js';
import { initStore, storeMode } from './store.js';
import { monthName } from './fiscal.js';

// Two tabs: Proof of cash (the fiscal-year sheet, with a details page per month) and the CD
// schedule. Months live in the URL hash (#/poc/2026-07) so a details page knows its month.
const routes = [
  [/^#?\/?$/, () => import('./views/poc-year.js')],
  [/^#\/poc$/, () => import('./views/poc-year.js')],
  [/^#\/poc\/(\d{4}-\d{2})$/, () => import('./views/poc.js')],
  [/^#\/poc\/import$/, () => import('./views/poc-import.js')],
  [/^#\/cds$/, () => import('./views/cds.js')],
];

const TABS = [
  ['#/poc', 'Proof of cash', (hash) => hash === '' || hash === '#/' || hash.startsWith('#/poc')],
  ['#/cds', 'CD schedule', (hash) => hash.startsWith('#/cds')],
];

let user = null;

async function greet() {
  try {
    const auth = await import('/_shared/auth.js');
    await auth.loadPermissions();
    user = { name: auth.getFullName(), first: auth.getFirstName(), email: auth.getEmail() };
  } catch { /* no platform (local preview) — carry on */ }
}

export function currentUser() {
  return user?.name || user?.email || 'Unknown user';
}

let renderSeq = 0;
export async function render() {
  const seq = ++renderSeq;
  const hash = location.hash || '#/';
  const root = document.getElementById('app');
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('strong', {}, 'Proof of Cash'), h('span', { class: 'muted' }, 'BibleProject Accounting')),
    h('nav', { class: 'tabs-top' }, TABS.map(([href, label, active]) => h('a', { href, class: active(hash) ? 'active' : '' }, label))),
    h('span', { class: 'who muted' }, user?.first ? `Hi, ${user.first}` : ''));
  const banner = storeMode() === 'local'
    ? h('div', { class: 'banner warn' }, 'Preview mode: the platform storage isn’t reachable, so anything you save stays in this browser only. Deploy to bp-vibes to share data.')
    : null;
  const main = h('main', { class: 'content' }, h('p', { class: 'muted' }, 'Loading…'));
  mount(root, header, banner, main);

  const match = routes.find(([re]) => re.test(hash));
  if (!match) { mount(main, h('h1', {}, 'Not found'), h('p', {}, h('a', { href: '#/poc' }, 'Back to proof of cash'))); return; }
  const params = hash.match(match[0]).slice(1).map(decodeURIComponent);
  try {
    const mod = await match[1]();
    if (seq !== renderSeq) return;
    await mod.default(main, { params, month: params[0], rerender: render, monthName, user: currentUser() });
  } catch (err) {
    console.error(err);
    if (seq !== renderSeq) return;
    mount(main, h('h1', {}, 'Something went wrong'), h('p', { class: 'error' }, err?.message || String(err)),
      h('p', {}, h('button', { class: 'btn', onclick: render }, 'Try again')));
    if (err?.signedOut) toast('Signing you in again…');
  }
}

window.addEventListener('hashchange', render);
// A file dropped anywhere that isn't a drop target shouldn't make the browser open it and leave
// the app.
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
await Promise.all([greet(), initStore()]);
render();
