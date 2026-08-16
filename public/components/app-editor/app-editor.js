/**
 * Add/edit-app dialog. Opens on `edit-app` {appId} to edit, or `add-app` to create,
 * writes artifacts/<app>/config.json, then broadcasts `targets-changed` so the sidebar re-reads.
 *
 * The password field arrives empty even when one is stored — the API reports only
 * whether it is set. Leaving it empty keeps the stored value.
 * API: GET/POST/PUT/DELETE /api/targets.
 */

import { deleteJson, getJson, postJson, putJson } from '/global/ui.js';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/app-editor/app-editor.html')).text();

  const dialog = root.querySelector('[data-dialog]');
  const error = root.querySelector('[data-error]');
  const title = root.querySelector('[data-title]');
  const intro = root.querySelector('[data-intro]');
  const pwHint = root.querySelector('[data-pw-hint]');
  const deleteButton = root.querySelector('[data-delete]');
  const field = (name) => root.querySelector(`[name="${name}"]`);
  let appId = null; // null means "creating"

  const fail = (message) => {
    error.textContent = message;
    error.hidden = false;
  };

  const openCreate = () => {
    appId = null;
    error.hidden = true;
    title.textContent = 'Add an app';
    intro.textContent =
      "Point the agent at any web app you're allowed to automate — a sandbox or demo, never real customer data.";
    deleteButton.hidden = true;
    pwHint.textContent = 'optional';
    for (const name of ['name', 'url', 'goal', 'username', 'password']) field(name).value = '';
    field('password').placeholder = '';
    dialog.showModal();
  };

  const openEdit = async (id) => {
    error.hidden = true;
    try {
      const config = await getJson(`/api/targets/${encodeURIComponent(id)}`);
      appId = id;
      title.textContent = 'Edit app';
      intro.textContent = `Saving rewrites artifacts/${id}/config.json — the next run reads the new values.`;
      deleteButton.hidden = false;
      field('name').value = config.name;
      field('url').value = config.url;
      field('goal').value = config.goal;
      field('username').value = config.username;
      field('password').value = '';
      field('password').placeholder = config.has_password ? '•••••••• (unchanged)' : '';
      pwHint.textContent = config.has_password ? 'stored — type to replace' : 'optional';
      dialog.showModal();
    } catch (err) {
      console.error('Could not load app config:', err.message);
    }
  };

  const done = (id) => {
    dialog.close();
    window.dispatchEvent(new CustomEvent('targets-changed', { detail: { appId: id } }));
  };

  root.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());

  root.querySelector('[data-save]').addEventListener('click', async () => {
    error.hidden = true;
    const body = {
      name: field('name').value.trim(),
      url: field('url').value.trim(),
      goal: field('goal').value.trim(),
      username: field('username').value.trim(),
      password: field('password').value,
    };
    try {
      // Creating returns the slug the server chose; editing keeps the id it opened with.
      const result = appId === null ? await postJson('/api/targets', body) : await putJson(`/api/targets/${encodeURIComponent(appId)}`, body);
      done(result.app_id ?? appId);
    } catch (err) {
      fail(err.message);
    }
  });

  deleteButton.addEventListener('click', async () => {
    if (appId === null) return;
    if (!confirm(`Delete "${field('name').value}"? Its recorded runs stay in evidence/.`)) return;
    try {
      await deleteJson(`/api/targets/${encodeURIComponent(appId)}`);
      done(null);
    } catch (err) {
      fail(err.message);
    }
  });

  window.addEventListener('edit-app', (event) => openEdit(event.detail.appId));
  window.addEventListener('add-app', openCreate);
}
