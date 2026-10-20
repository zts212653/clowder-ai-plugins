import { defaultBinding } from './binding.mjs';
import { createState } from './state.mjs';
export const storageKey = 'clowder-repo-sync-demo-v2';
export function readState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved?.schema === 2 && saved.deliveries?.length && Array.isArray(saved.events)) {
      saved.binding ??= defaultBinding();
      saved.archives ??= [];
      if (saved.active) saved.active.bindingId ??= saved.binding.id;
      return saved;
    }
  } catch {
    /* Only synthetic demo data is stored; unavailable storage starts a new demo. */
  }
  return createState('unconfigured');
}
export function writeState(state) {
  localStorage.setItem(storageKey, JSON.stringify(state));
}
