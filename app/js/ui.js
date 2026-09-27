// Tiny DOM helpers. Everything goes through textContent / attributes — never innerHTML with data —
// so a name typed into an asset can't turn into markup.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(root, ...children) {
  root.replaceChildren();
  append(root, children);
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input,
    hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function select(options, value, props = {}) {
  return h('select', props, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

let toastTimer = null;
export function toast(msg, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'error' ? 8000 : 3500);
}

export function table(columns, rows, { empty = 'Nothing here yet.', foot = null, rowProps = null } = {}) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', {}, rows.length
      ? rows.map((r) => h('tr', rowProps ? rowProps(r) : {}, columns.map((c) => h('td', { class: c.num ? 'num' : '' }, c.cell(r)))))
      : h('tr', {}, h('td', { colspan: columns.length, class: 'empty' }, empty))),
    foot ? h('tfoot', {}, h('tr', {}, columns.map((c) => h('td', { class: c.num ? 'num' : '' }, foot(c))))) : null,
  ));
}

export function fileButton(label, accept, onFile, props = {}) {
  const input = h('input', { type: 'file', accept, class: 'visually-hidden' });
  input.addEventListener('change', () => {
    const f = input.files[0];
    input.value = '';
    if (f) onFile(f);
  });
  return h('label', { class: `btn ${props.class || ''}` }, label, input);
}

export function statusPill(text, kind) {
  return h('span', { class: `pill ${kind}` }, text);
}

// ---- In-page dialogs ---------------------------------------------------------------------
// The app runs in an iframe, where the browser's confirm()/prompt()/alert() can be suppressed
// silently. These render inside the page instead and resolve a promise.

function openDialog(build) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const close = (value) => { overlay.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); resolve(value); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' });
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(null); } }, box);
    build(box, close);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    (box.querySelector('[autofocus]') || box.querySelector('button.primary') || box.querySelector('button'))?.focus();
  });
}

export function ask(title, message, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return openDialog((box, close) => {
    box.append(h('h3', {}, title), message ? h('p', {}, message) : null,
      h('div', { class: 'row dialog-actions' },
        h('button', { onclick: () => close(false) }, cancel),
        h('button', { class: danger ? 'danger primary' : 'primary', onclick: () => close(true) }, ok)));
  }).then((v) => v === true);
}

export function askValue(title, message, { value = '', type = 'text', ok = 'OK' } = {}) {
  return openDialog((box, close) => {
    const input = h('input', { type, value, autofocus: true, onkeydown: (e) => { if (e.key === 'Enter') close(input.value); } });
    box.append(h('h3', {}, title), message ? h('p', {}, message) : null, input,
      h('div', { class: 'row dialog-actions' }, h('button', { onclick: () => close(null) }, 'Cancel'), h('button', { class: 'primary', onclick: () => close(input.value) }, ok)));
  });
}

export function notify(title, lines) {
  return openDialog((box, close) => {
    box.append(h('h3', {}, title), h('ul', {}, [].concat(lines).map((l) => h('li', {}, l))),
      h('div', { class: 'row dialog-actions' }, h('button', { class: 'primary', onclick: () => close(true) }, 'OK')));
  });
}

// A panel that slides in from the right; build(body, close) fills it. Resolves when closed.
export function panel(title, build, { wide = false } = {}) {
  return openDialog((box, close) => {
    box.classList.add('panel');
    if (wide) box.classList.add('wide');
    const body = h('div', { class: 'panel-body' });
    box.append(h('div', { class: 'panel-head' }, h('h2', {}, title), h('button', { class: 'small-btn', onclick: () => close(true), 'aria-label': 'Close' }, 'Close')), body);
    build(body, close);
  });
}
