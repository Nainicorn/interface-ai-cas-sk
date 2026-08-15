/**
 * Add-app modal: friendly name + URL (+ optional goal, paths, logins) → a registered
 * target. On success it clears the secrets from the DOM and broadcasts
 * `targets-changed` {appId} so the sidebar refreshes and selects the new app.
 * API: POST /api/targets.
 */

import { postJson } from '/lib/ui.js';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/target-modal/target-modal.html')).text();

  const dialog = root.querySelector('[data-dialog]');
  const personas = root.querySelector('[data-personas]');
  const rowTemplate = root.querySelector('[data-persona-row]');
  const error = root.querySelector('[data-error]');
  const field = (name) => root.querySelector(`[name=${name}]`);

  const addPersonaRow = () => personas.appendChild(rowTemplate.content.cloneNode(true));

  const reset = () => {
    for (const name of ['display_name', 'base_url', 'goal', 'risky']) field(name).value = '';
    field('entry_route').value = '/';
    field('route_prefixes').value = '/';
    personas.innerHTML = '';
    addPersonaRow();
    error.hidden = true;
  };

  const collectPersonas = () => {
    const collected = {};
    let n = 0;
    for (const row of personas.querySelectorAll('.persona-row')) {
      const username = row.querySelector('[name=p-username]').value.trim();
      const password = row.querySelector('[name=p-password]').value;
      if (!username && !password) continue; // untouched row
      n += 1;
      const name = (row.querySelector('[name=p-name]').value.trim() || `login${n}`).replace(/[^a-zA-Z0-9_-]/g, '-');
      collected[name] = { username, password };
    }
    return collected;
  };

  const paths = (value) =>
    value
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((p) => (p.startsWith('/') ? p : `/${p}`));

  const save = async () => {
    error.hidden = true;
    const payload = {
      display_name: field('display_name').value.trim(),
      base_url: field('base_url').value.trim(),
      entry_route: field('entry_route').value.trim() || '/',
      allowlist: { route_prefixes: paths(field('route_prefixes').value) },
    };
    if (!payload.allowlist.route_prefixes.length) payload.allowlist.route_prefixes = ['/'];
    const goal = field('goal').value.trim();
    if (goal) payload.goal = goal;
    const risky = field('risky').value.split(/[\s,]+/).filter(Boolean);
    if (risky.length) payload.risky_route_patterns = risky;
    const collected = collectPersonas();
    if (Object.keys(collected).length) payload.personas = collected;

    try {
      const { app_id: appId } = await postJson('/api/targets', payload);
      reset(); // secrets leave the DOM
      dialog.close();
      window.dispatchEvent(new CustomEvent('targets-changed', { detail: { appId } }));
    } catch (err) {
      const problems = err.detail?.problems;
      error.textContent = problems?.length ? problems.join(' · ') : err.message;
      error.hidden = false;
    }
  };

  root.querySelector('[data-save]').addEventListener('click', save);
  root.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
  root.querySelector('[data-add-persona]').addEventListener('click', addPersonaRow);
  personas.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-row]');
    if (remove) remove.closest('.persona-row').remove();
  });
  window.addEventListener('open-target-modal', () => {
    if (!dialog.open) dialog.showModal();
  });

  reset();
}
