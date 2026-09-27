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
