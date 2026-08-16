/**
 * Light/dark theme: a stored choice, or the OS when there isn't one.
 *
 * The <html> element carries data-theme only when the user has actually chosen; absent,
 * the prefers-color-scheme media query in styles.css decides. That three-state model is
 * what lets someone follow their OS by default and still override it here.
 *
 * A tiny copy of applyStoredTheme() runs inline in each page's <head> — see index.html —
 * because applying the theme from a module would paint the light palette first.
 */

const KEY = 'cas-theme';

const store = {
  get() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null; // private mode: the toggle still works for this page load
    }
  },
  set(value) {
    try {
      localStorage.setItem(KEY, value);
    } catch {
      /* ignore */
    }
  },
};

const prefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

/** The theme actually showing: the stored choice, else the OS. */
export const resolvedTheme = () => store.get() ?? (prefersDark() ? 'dark' : 'light');

function apply(theme) {
  document.documentElement.dataset.theme = theme;
}

/**
 * Mount the toggle. Swaps light↔dark from whatever is currently showing, so the first
 * click always does the visible thing rather than fighting the OS setting.
 */
export function mountThemeToggle(button) {
  if (!button) return;

  const sun =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M6.3 6.3 4.8 4.8M19.2 19.2l-1.5-1.5M17.7 6.3l1.5-1.5M4.8 19.2l1.5-1.5"/></svg>';
  const moon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2Z"/></svg>';

  const paint = () => {
    const dark = resolvedTheme() === 'dark';
    // Show the destination, not the current state: the icon is the action.
    button.innerHTML = `${dark ? sun : moon}<span class="sr">${dark ? 'Switch to light' : 'Switch to dark'}</span>`;
    button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    button.setAttribute('aria-pressed', String(dark));
  };

  button.addEventListener('click', () => {
    const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
    store.set(next);
    apply(next);
    paint();
  });

  // Follow the OS live, but only while the user has expressed no preference.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (!store.get()) paint();
  });

  paint();
}
