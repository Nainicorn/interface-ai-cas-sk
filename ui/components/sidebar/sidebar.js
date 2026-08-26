/**
 * App sidebar: every configured app, click to select. Owns selection — publishes it to
 * lib/selected-app.js, which the rest of the console reads.
 *
 * The store rather than an event, because this component resolves its fetch before the
 * workspace has mounted its tables: an event fired here would reach nobody.
 *
 * + Add app and each row's Edit icon hand off to app-modal.
 * API: GET /api/apps.
 */

import { setSelectedApp, storedAppId } from '/global/selected-app.js';
import { esc, getJson } from '/global/helpers.js';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/sidebar/sidebar.html')).text();

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
    setSelectedApp(target); // persists the choice and replays it to late subscribers
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
            <button class="edit-btn" data-edit="${esc(t.app_id)}" type="button" title="Edit ${esc(t.display_name)}">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 2.3a1.4 1.4 0 0 1 2 2l-7.1 7.1-2.7.7.7-2.7 7.1-7.1Z"/><path d="M10 3.6 12.4 6"/></svg>
              <span class="sr">Edit</span>
            </button>
          </li>`;
      })
      .join('');
  };

  const refresh = async ({ selectId } = {}) => {
    try {
      targets = await getJson('/api/apps');
      const key = JSON.stringify(targets.map((t) => [t.app_id, t.display_name, t.goal]));
      if (key !== lastKey) {
        lastKey = key;
        render();
      }
      if (!targets.length) {
        selectedId = null;
        setSelectedApp(null); // a decision, not an absence of one
        return;
      }
      if (selectId && targets.some((t) => t.app_id === selectId)) select(selectId);
      else if (!selectedId || !targets.some((t) => t.app_id === selectedId)) {
        const stored = storedAppId();
        select(targets.some((t) => t.app_id === stored) ? stored : targets[0].app_id);
      }
    } catch {
      /* transient poll failure */
    }
  };

  root.addEventListener('click', (event) => {
    const editButton = event.target.closest('[data-edit]');
    if (editButton) {
      event.stopPropagation(); // editing an app should not also select it
      window.dispatchEvent(new CustomEvent('edit-app', { detail: { appId: editButton.dataset.edit } }));
      return;
    }
    if (event.target.closest('[data-add]')) {
      return window.dispatchEvent(new CustomEvent('add-app'));
    }
    const item = event.target.closest('[data-app]');
    if (item) return select(item.dataset.app);
  });

  window.addEventListener('targets-changed', (event) => {
    lastKey = '';
    // A delete broadcasts no appId — drop the selection so refresh falls to a survivor.
    if (!event.detail?.appId) selectedId = null;
    refresh({ selectId: event.detail?.appId });
  });
  refresh();
  setInterval(refresh, 5000);
}
