import { h, mount, toast } from './ui.js';
import { initStore, storeMode } from './store.js';
import { addMonths, currentMonth, monthName } from './fiscal.js';

const routes = [
  [/^#?\/?$/, () => import('./views/home.js')],
  [/^#\/fa$/, () => import('./views/fa-register.js')],
  [/^#\/fa\/new$/, () => import('./views/fa-asset.js')],
  [/^#\/fa\/asset\/(.+)$/, () => import('./views/fa-asset.js')],
  [/^#\/fa\/import$/, () => import('./views/fa-import.js')],
  [/^#\/fa\/je$/, () => import('./views/fa-je.js')],
  [/^#\/poc$/, () => import('./views/poc-year.js')],
  [/^#\/poc\/month$/, () => import('./views/poc.js')],
  [/^#\/poc\/import$/, () => import('./views/poc-import.js')],
  [/^#\/cds$/, () => import('./views/cds.js')],
  [/^#\/tb$/, () => import('./views/tb.js')],
  [/^#\/settings$/, () => import('./views/settings.js')],
];

const NAV = [
  ['#/', 'Close overview'],
  ['#/poc', 'Proof of cash'],
  ['#/cds', 'CD schedule'],
  ['#/fa', 'Fixed assets'],
  ['#/fa/je', 'Depreciation JE'],
  ['#/tb', 'Acumatica uploads'],
  ['#/settings', 'Settings'],
];

// The month being closed. Kept per browser — it's a view preference, not data.
const MONTH_KEY = 'monthclose:month';
export function closeMonth() {
  try { return localStorage.getItem(MONTH_KEY) || addMonths(currentMonth(), -1); } catch { return addMonths(currentMonth(), -1); }
}
function setCloseMonth(m) {
  try { localStorage.setItem(MONTH_KEY, m); } catch { /* private window — fine */ }
}

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

function shell() {
  const monthInput = h('input', {
    type: 'month', value: closeMonth(), 'aria-label': 'Month being closed',
    onchange: (e) => { if (e.target.value) { setCloseMonth(e.target.value); render(); } },
  });
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('strong', {}, 'Month Close'), h('span', { class: 'muted' }, 'BibleProject Accounting')),
    h('label', { class: 'month-pick' }, h('span', {}, 'Closing'), monthInput),
    h('span', { class: 'who muted' }, user?.first ? `Hi, ${user.first}` : ''),
  );
  const nav = h('nav', { class: 'sidenav' }, NAV.map(([href, label]) => h('a', { href, 'data-href': href }, label)));
  const banner = storeMode() === 'local'
    ? h('div', { class: 'banner warn' }, 'Preview mode: the platform storage isn’t reachable, so anything you save stays in this browser only. Deploy to bp-vibes to share data.')
    : null;
  return { header, nav, banner };
}

let renderSeq = 0;
export async function render() {
  const seq = ++renderSeq;
  const hash = location.hash || '#/';
  const root = document.getElementById('app');
  const { header, nav, banner } = shell();
  const main = h('main', { class: 'content' }, h('p', { class: 'muted' }, 'Loading…'));
  mount(root, header, h('div', { class: 'layout' }, nav, h('div', { class: 'main-col' }, banner, main)));
  for (const a of nav.querySelectorAll('a')) {
    const href = a.dataset.href;
    const active = href === '#/' ? hash === '#/' || hash === '' : hash === href || (href === '#/fa' && /^#\/fa\/(asset|new|import)/.test(hash)) || (href === '#/poc' && /^#\/poc\//.test(hash));
    if (active) a.classList.add('active');
  }

  const match = routes.find(([re]) => re.test(hash));
  if (!match) { mount(main, h('h1', {}, 'Not found'), h('p', {}, h('a', { href: '#/' }, 'Back to the overview'))); return; }
  const params = hash.match(match[0]).slice(1).map(decodeURIComponent);
  try {
    const mod = await match[1]();
    if (seq !== renderSeq) return;
    await mod.default(main, { month: closeMonth(), params, rerender: render, monthName, user: currentUser(),
      setMonth: (m) => { setCloseMonth(m); render(); } });
  } catch (err) {
    console.error(err);
    if (seq !== renderSeq) return;
    mount(main, h('h1', {}, 'Something went wrong'), h('p', { class: 'error' }, err?.message || String(err)),
      h('p', {}, h('button', { class: 'btn', onclick: render }, 'Try again')));
    if (err?.signedOut) toast('Signing you in again…');
  }
}

window.addEventListener('hashchange', render);
await Promise.all([greet(), initStore()]);
render();
