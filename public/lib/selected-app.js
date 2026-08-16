/**
 * Which app the console is looking at — one shared piece of state.
 *
 * This exists because a plain window event cannot be relied on here: the sidebar mounts
 * and resolves its fetch before the workspace has mounted its children, so an
 * `app-selected` event fired at that moment reaches nobody, and every table that missed
 * it renders unscoped. A store replays the current selection to whoever subscribes,
 * whenever they get around to subscribing.
 *
 * `known` distinguishes "no app is selected" from "we have not decided yet". Tables must
 * render EMPTY until a decision exists — falling back to "show everything" is what put
 * other apps' runs in the list on refresh.
 */

const KEY = 'cas-selected-app';

let current = null; // the selected target object, or null when there are no apps
let known = false; // has a selection decision been made this page load?
const listeners = new Set();

/** The selected target object, or null. */
export const getSelectedApp = () => current;

/** The selected app id, or null. */
export const selectedAppId = () => current?.app_id ?? null;

/** Whether a selection decision has been made yet (even if that decision is "none"). */
export const hasSelection = () => known;

/** The app id chosen last page load, so a refresh lands where the user left off. */
export const storedAppId = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // private mode / storage disabled — the default selection still works
  }
};

/** Set the selection (or null for "no apps") and notify everyone. */
export function setSelectedApp(target) {
  current = target ?? null;
  known = true;
  try {
    if (current) localStorage.setItem(KEY, current.app_id);
    else localStorage.removeItem(KEY);
  } catch {
    /* selection still works for this page load */
  }
  for (const fn of listeners) fn(current);
}

/**
 * Subscribe. Fires immediately with the current selection if one has been decided, so
 * subscribing late is not the same as missing the event.
 * @returns {() => void} unsubscribe
 */
export function onSelectedApp(fn) {
  listeners.add(fn);
  if (known) fn(current);
  return () => listeners.delete(fn);
}
