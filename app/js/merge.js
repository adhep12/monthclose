// Saving a month from a pop-up that has been open a while: someone (or another pop-up) may have
// saved the month since it was read. Rather than write the pop-up's whole copy over theirs — or
// have the platform refuse it as a conflict — take the month as it is now and apply only what this
// pop-up changed: each top-level field it changed, each account / statement / decision inside the
// keyed fields it changed, and the log entries it added.

const KEYED = ['bank', 'statements', 'bankStatements', 'excluded', 'dismissed', 'autoConfirm', 'ditGl', 'stripeAs', 'glMatch', 'glNot', 'signoff', 'timing', 'gl', 'paypalSentAs', 'bankFiles'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function mergeChanges(current, base, local) {
  const out = structuredClone(current || {});
  for (const k of new Set([...Object.keys(base || {}), ...Object.keys(local || {})])) {
    if (k === 'key' || k === 'updatedAt' || k === 'updatedBy') continue;
    const b = base?.[k], l = local?.[k];
    if (same(b, l)) continue;
    if (k === 'log') { out.log = [...(out.log || []), ...(l || []).slice((b || []).length)]; continue; }
    if (KEYED.includes(k) && l && typeof l === 'object' && !Array.isArray(l)) {
      const into = (out[k] = { ...(out[k] && typeof out[k] === 'object' ? out[k] : {}) });
      for (const s of new Set([...Object.keys(b || {}), ...Object.keys(l)])) {
        if (same(b?.[s], l[s])) continue;
        if (l[s] === undefined) delete into[s]; else into[s] = structuredClone(l[s]);
      }
      continue;
    }
    if (l === undefined) delete out[k]; else out[k] = structuredClone(l);
  }
  return out;
}
