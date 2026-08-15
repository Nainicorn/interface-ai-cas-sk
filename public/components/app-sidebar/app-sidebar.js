/**
 * App sidebar: every registered target, click to select, + Add app opens the modal,
 * and each row's ⋯ menu edits or deletes the app. Owns selection — broadcasts
 * `app-selected` {target} (or `apps-empty`) so the rest of the console follows.
 * API: GET /api/targets, DELETE /api/targets/:appId.
 */

import { deleteJson, esc, getJson } from '/lib/ui.js';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/app-sidebar/app-sidebar.html')).text();

  const list = root.querySelector('[data-apps]');
  const empty = root.querySelector('[data-empty]');
  const popup = root.querySelector('[data-menu-popup]');
  const STORAGE_KEY = 'cas-selected-app';
  let targets = [];
  let selectedId = null;
  let menuAppId = null;
  let lastKey = '';

  const select = (appId) => {
    const target = targets.find((t) => t.app_id === appId);
    if (!target) return;
    selectedId = appId;
    localStorage.setItem(STORAGE_KEY, appId); // survive a refresh
    for (const item of list.querySelectorAll('[data-app]')) {
      item.classList.toggle('selected', item.dataset.app === appId);
    }
    window.dispatchEvent(new CustomEvent('app-selected', { detail: { target } }));
  };

  const render = () => {
    empty.hidden = targets.length > 0;
    list.innerHTML = targets
      .map((t) => {
        let host = t.base_url;
        try {
          host = new URL(t.base_url).host;
        } catch {
          /* show it raw */
        }
        return `
          <li data-app="${esc(t.app_id)}" class="${t.app_id === selectedId ? 'selected' : ''}">
            <span class="name">${esc(t.display_name)}</span>
            <span class="host mono">${esc(host)}</span>
            <button class="menu-btn" data-menu="${esc(t.app_id)}" type="button" title="App options">⋯</button>
          </li>`;
      })
      .join('');
  };

  const refresh = async ({ selectId } = {}) => {
    try {
      targets = await getJson('/api/targets');
      const key = JSON.stringify(targets.map((t) => [t.app_id, t.display_name, t.personas?.length, t.goals?.length]));
      if (key !== lastKey) {
        lastKey = key;
        render();
      }
      if (!targets.length) {
        selectedId = null;
        window.dispatchEvent(new CustomEvent('apps-empty'));
        return;
      }
      if (selectId) select(selectId);
      else if (!selectedId || !targets.some((t) => t.app_id === selectedId)) {
        const stored = localStorage.getItem(STORAGE_KEY);
        select(targets.some((t) => t.app_id === stored) ? stored : targets[0].app_id);
      }
    } catch {
      /* transient poll failure */
    }
  };

  const closeMenu = () => {
    popup.hidden = true;
    menuAppId = null;
  };

  root.addEventListener('click', (event) => {
    const menuButton = event.target.closest('[data-menu]');
    if (menuButton) {
      menuAppId = menuButton.dataset.menu;
      const rect = menuButton.getBoundingClientRect();
      popup.style.top = `${rect.bottom + 4}px`;
      popup.style.left = `${Math.max(8, rect.right - 130)}px`;
      popup.hidden = false;
      return;
    }
    const item = event.target.closest('[data-app]');
    if (item) return select(item.dataset.app);
    if (event.target.closest('[data-add]')) {
      window.dispatchEvent(new CustomEvent('open-target-modal'));
    }
  });

  popup.querySelector('[data-edit]').addEventListener('click', () => {
    const target = targets.find((t) => t.app_id === menuAppId);
    closeMenu();
    if (target) window.dispatchEvent(new CustomEvent('open-target-modal', { detail: { target } }));
  });

  popup.querySelector('[data-delete]').addEventListener('click', async () => {
    const target = targets.find((t) => t.app_id === menuAppId);
    closeMenu();
    if (!target) return;
    if (!confirm(`Delete "${target.display_name}"? Its recorded runs stay in history.`)) return;
    try {
      await deleteJson(`/api/targets/${encodeURIComponent(target.app_id)}`);
      if (selectedId === target.app_id) selectedId = null;
      lastKey = '';
      refresh();
    } catch {
      /* next poll re-renders the truth */
    }
  });

  // Any click outside the popup closes it.
  document.addEventListener('click', (event) => {
    if (!popup.hidden && !event.target.closest('[data-menu-popup]') && !event.target.closest('[data-menu]')) closeMenu();
  });

  window.addEventListener('targets-changed', (event) => {
    lastKey = '';
    refresh({ selectId: event.detail?.appId });
  });
  refresh();
  setInterval(refresh, 5000);
}
