/**
 * App sidebar: every registered target, click to select, + Add app opens the modal.
 * Owns selection — broadcasts `app-selected` {target} so the run form follows along.
 * API: GET /api/targets.
 */

import { esc, getJson } from '/lib/ui.js';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/app-sidebar/app-sidebar.html')).text();

  const list = root.querySelector('[data-apps]');
  const empty = root.querySelector('[data-empty]');
  let targets = [];
  let selectedId = null;
  let lastKey = '';

  const select = (appId) => {
    const target = targets.find((t) => t.app_id === appId);
    if (!target) return;
    selectedId = appId;
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
          </li>`;
      })
      .join('');
  };

  const refresh = async ({ selectId } = {}) => {
    try {
      targets = await getJson('/api/targets');
      const key = JSON.stringify(targets.map((t) => [t.app_id, t.display_name, t.personas?.length]));
      if (key !== lastKey) {
        lastKey = key;
        render();
      }
      if (selectId) select(selectId);
      else if (!selectedId && targets.length) select(targets[0].app_id);
    } catch {
      /* transient poll failure */
    }
  };

  root.addEventListener('click', (event) => {
    const item = event.target.closest('[data-app]');
    if (item) return select(item.dataset.app);
    if (event.target.closest('[data-add]')) {
      window.dispatchEvent(new CustomEvent('open-target-modal'));
    }
  });

  window.addEventListener('targets-changed', (event) => refresh({ selectId: event.detail?.appId }));
  refresh();
  setInterval(refresh, 5000);
}
