/**
 * Add/edit-app dialog. Opens on `edit-app` {appId} to edit, or `add-app` to create,
 * writes apps/<app>/config.json, then broadcasts `targets-changed` so the sidebar re-reads.
 *
 * The password field arrives empty even when one is stored — the API reports only
 * whether it is set. Leaving it empty keeps the stored value.
 * API: GET/POST/PUT/DELETE /api/apps.
 */

import { deleteJson, esc, getJson, postJson, putJson } from '/global/helpers.js';

/** The five action primitives. Mirrors ACTION_TYPES in src/schema/enums.js. */
const ACTION_TYPES = ['navigate', 'click', 'type', 'read', 'wait_for'];
const DEFAULT_ROUTE_PREFIXES = ['/'];

/** A textarea of one-per-line values ↔ an array, blank lines dropped. */
const linesToList = (value) =>
  String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/app-modal/app-modal.html')).text();

  const dialog = root.querySelector('[data-dialog]');
  const error = root.querySelector('[data-error]');
  const title = root.querySelector('[data-title]');
  const intro = root.querySelector('[data-intro]');
  const pwHint = root.querySelector('[data-pw-hint]');
  const deleteButton = root.querySelector('[data-delete]');
  const field = (name) => root.querySelector(`[name="${name}"]`);
  let appId = null; // null means "creating"

  // One checkbox per action primitive, rendered once.
  root.querySelector('[data-action-types]').innerHTML = ACTION_TYPES.map(
    (a) => `<label class="check"><input type="checkbox" name="action:${esc(a)}" /> <span class="mono">${esc(a)}</span></label>`,
  ).join('');

  const setActions = (allowed) => {
    for (const a of ACTION_TYPES) field(`action:${a}`).checked = allowed.includes(a);
  };
  const readActions = () => ACTION_TYPES.filter((a) => field(`action:${a}`).checked);

  /** Show a config's permissions; a config with none shows the defaults it runs under. */
  const setPermissions = (config = {}) => {
    field('route_prefixes').value = (config.allowlist?.route_prefixes ?? DEFAULT_ROUTE_PREFIXES).join('\n');
    setActions(config.allowlist?.action_types ?? ACTION_TYPES);
    field('risky_route_patterns').value = (config.risky_route_patterns ?? []).join('\n');
    field('redact_fields').value = (config.redact_fields ?? []).join('\n');
  };

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
    setPermissions(); // the defaults a new app gets, shown rather than implied
    dialog.showModal();
  };

  const openEdit = async (id) => {
    error.hidden = true;
    try {
      const config = await getJson(`/api/apps/${encodeURIComponent(id)}`);
      appId = id;
      title.textContent = 'Edit app';
      intro.textContent = `Saving rewrites apps/${id}/config.json — the next run reads the new values.`;
      deleteButton.hidden = false;
      field('name').value = config.name;
      field('url').value = config.url;
      field('goal').value = config.goal;
      field('username').value = config.username;
      field('password').value = '';
      field('password').placeholder = config.has_password ? '•••••••• (unchanged)' : '';
      pwHint.textContent = config.has_password ? 'stored — type to replace' : 'optional';
      setPermissions(config);
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
    const routePrefixes = linesToList(field('route_prefixes').value);
    const actionTypes = readActions();

    // Refused here rather than written and enforced later: an empty allowlist is a
    // config that can never do anything, and finding that out mid-run is worse than
    // being told now.
    if (!routePrefixes.length) return fail('Allowed routes cannot be empty — use / for the whole site.');
    if (!actionTypes.length) return fail('Tick at least one action, or the agent cannot do anything.');

    const body = {
      name: field('name').value.trim(),
      url: field('url').value.trim(),
      goal: field('goal').value.trim(),
      username: field('username').value.trim(),
      password: field('password').value,
      allowlist: { route_prefixes: routePrefixes, action_types: actionTypes },
      risky_route_patterns: linesToList(field('risky_route_patterns').value),
      redact_fields: linesToList(field('redact_fields').value),
    };
    try {
      // Creating returns the slug the server chose; editing keeps the id it opened with.
      const result = appId === null ? await postJson('/api/apps', body) : await putJson(`/api/apps/${encodeURIComponent(appId)}`, body);
      done(result.app_id ?? appId);
    } catch (err) {
      fail(err.message);
    }
  });

  deleteButton.addEventListener('click', async () => {
    if (appId === null) return;

    // Deleting an app cascades to everything it produced, so the confirm names the
    // count rather than describing the policy — "3 runs and 1 capability" is the fact
    // an operator needs, and it is the last chance to see it.
    let scope = '';
    try {
      const runs = await getJson('/api/runs');
      const mine = runs.filter((r) => r.app_id === appId);
      const caps = mine.filter((r) => r.detail?.artifact).length;
      if (mine.length) {
        scope = `\n\nThis also deletes ${mine.length} run${mine.length === 1 ? '' : 's'}`
          + (caps ? ` and ${caps} recorded capabilit${caps === 1 ? 'y' : 'ies'}` : '')
          + ', with their transcripts and screenshots.';
      }
    } catch {
      scope = '\n\nThis also deletes its runs and recorded capabilities.';
    }

    if (!confirm(`Delete "${field('name').value}"?${scope}`)) return;
    try {
      await deleteJson(`/api/apps/${encodeURIComponent(appId)}`);
      done(null);
    } catch (err) {
      fail(err.message);
    }
  });

  window.addEventListener('edit-app', (event) => openEdit(event.detail.appId));
  window.addEventListener('add-app', openCreate);
}
