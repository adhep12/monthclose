// Who entered a number and when, who confirmed it and when, and a log of every change.
//
// A confirmation keeps a copy of the values it confirmed. If the numbers change afterwards —
// someone retypes one, a new statement replaces the old — the confirmation no longer matches and
// shows as needing another look, rather than silently vouching for numbers nobody checked.

import { h } from './ui.js';

export function nowIso() { return new Date().toISOString(); }

export function stampEntered(obj, user) {
  obj.enteredBy = user;
  obj.enteredAt = nowIso();
  return obj;
}

export function confirmValues(obj, user, values) {
  obj.confirmation = { by: user, at: nowIso(), values: JSON.parse(JSON.stringify(values ?? null)) };
  return obj;
}

export function confirmationState(obj, values) {
  const c = obj?.confirmation;
  if (!c) return 'none';
  return JSON.stringify(c.values ?? null) === JSON.stringify(values ?? null) ? 'confirmed' : 'stale';
}

export function logChange(rec, user, what) {
  rec.log = rec.log || [];
  rec.log.push({ at: nowIso(), by: user, what });
  if (rec.log.length > 1000) rec.log = rec.log.slice(-1000);
}

export function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "Entered by … · Confirm" / "Confirmed by …" / "Changed since … confirmed it".
export function stampBadge({ enteredBy, enteredAt, obj, values, user, onConfirm, onUnconfirm }) {
  const state = confirmationState(obj, values);
  const c = obj?.confirmation;
  const hasValue = values && Object.values(values).some((v) => v != null && v !== '');
  return h('div', { class: 'stamp' },
    enteredBy ? h('div', {}, h('span', { class: 'muted' }, 'Entered '), enteredBy, h('span', { class: 'muted' }, ` · ${when(enteredAt)}`)) : null,
    state === 'confirmed'
      ? h('div', { class: 'good-text' }, '✓ Confirmed ', c.by, h('span', { class: 'muted' }, ` · ${when(c.at)}`),
        c.by === enteredBy ? h('span', { class: 'muted', title: 'The same person entered and confirmed this.' }, ' (self)') : null,
        onUnconfirm ? h('button', { class: 'link', onclick: onUnconfirm, title: 'Remove this confirmation' }, 'undo') : null)
      : h('div', {},
        state === 'stale' ? h('span', { class: 'warn-text' }, `Changed since ${c.by} confirmed it · `) : null,
        hasValue && onConfirm
          ? h('button', { class: 'small-btn', onclick: onConfirm, title: enteredBy && enteredBy === user ? 'You entered this — ideally someone else confirms it.' : '' }, 'Confirm')
          : null));
}
