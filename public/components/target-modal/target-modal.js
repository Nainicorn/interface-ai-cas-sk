/**
 * Add/Edit-app modal: friendly name + URL (+ saved goals, logins, paths) → a
 * registered target. Opens empty for a new app, or prefilled when the sidebar's ⋯
 * menu sends a target (passwords never round-trip — an empty password on an existing
 * login means "keep the stored one"). On success it clears the secrets from the DOM
 * and broadcasts `targets-changed` {appId}.
 * API: POST /api/targets, PUT /api/targets/:appId.
 */

import { postJson, putJson } from '/lib/ui.js';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/target-modal/target-modal.html')).text();

  const dialog = root.querySelector('[data-dialog]');
  const title = root.querySelector('[data-title]');
  const saveButton = root.querySelector('[data-save]');
  const personas = root.querySelector('[data-personas]');
  const goals = root.querySelector('[data-goals]');
  const personaTemplate = root.querySelector('[data-persona-row]');
  const goalTemplate = root.querySelector('[data-goal-row]');
  const error = root.querySelector('[data-error]');
  const field = (name) => root.querySelector(`[name=${name}]`);

  let editingAppId = null;

  const addRow = (container, template, values = {}) => {
    container.appendChild(template.content.cloneNode(true));
    const row = container.lastElementChild;
    for (const [name, value] of Object.entries(values)) {
      const input = row.querySelector(`[name=${name}]`);
      if (input) input.value = value;
    }
    return row;
  };

  const reset = () => {
    editingAppId = null;
    title.textContent = 'Add an app';
    saveButton.textContent = 'Add app';
    for (const name of ['display_name', 'base_url', 'risky']) field(name).value = '';
    field('entry_route').value = '/';
    field('route_prefixes').value = '/';
    goals.innerHTML = '';
    addRow(goals, goalTemplate);
    personas.innerHTML = '';
    addRow(personas, personaTemplate);
    error.hidden = true;
  };

  const prefill = (target) => {
    editingAppId = target.app_id;
    title.textContent = `Edit ${target.display_name}`;
    saveButton.textContent = 'Save changes';
    field('display_name').value = target.display_name;
    field('base_url').value = target.base_url;
    field('entry_route').value = target.entry_route ?? '/';
    field('route_prefixes').value = (target.allowlist?.route_prefixes ?? ['/']).join(' ');
    field('risky').value = (target.risky_route_patterns ?? []).join(' ');
    goals.innerHTML = '';
    for (const g of target.goals ?? []) addRow(goals, goalTemplate, { 'g-name': g.name, 'g-text': g.text });
    if (!goals.children.length) addRow(goals, goalTemplate);
    personas.innerHTML = '';
    for (const p of target.personas ?? []) {
      const row = addRow(personas, personaTemplate, { 'p-name': p.name, 'p-username': p.username ?? '' });
      row.querySelector('[name=p-password]').placeholder = 'unchanged';
    }
    if (!personas.children.length) addRow(personas, personaTemplate);
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

  const collectGoals = () => {
    const collected = {};
    let n = 0;
    for (const row of goals.querySelectorAll('.goal-row')) {
      const text = row.querySelector('[name=g-text]').value.trim();
      if (!text) continue;
      n += 1;
      const name = row.querySelector('[name=g-name]').value.trim() || `test ${n}`;
      collected[name] = text;
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
    const risky = field('risky').value.split(/[\s,]+/).filter(Boolean);
    if (risky.length) payload.risky_route_patterns = risky;
    const collectedGoals = collectGoals();
    if (Object.keys(collectedGoals).length) payload.goals = collectedGoals;
    const collectedPersonas = collectPersonas();
    if (Object.keys(collectedPersonas).length || editingAppId) payload.personas = collectedPersonas;

    try {
      const saved = editingAppId
        ? await putJson(`/api/targets/${encodeURIComponent(editingAppId)}`, payload)
        : await postJson('/api/targets', payload);
      reset(); // secrets leave the DOM
      dialog.close();
      window.dispatchEvent(new CustomEvent('targets-changed', { detail: { appId: saved.app_id } }));
    } catch (err) {
      const problems = err.detail?.problems;
      error.textContent = problems?.length ? problems.join(' · ') : err.message;
      error.hidden = false;
    }
  };

  saveButton.addEventListener('click', save);
  root.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
  root.querySelector('[data-add-persona]').addEventListener('click', () => addRow(personas, personaTemplate));
  root.querySelector('[data-add-goal]').addEventListener('click', () => addRow(goals, goalTemplate));
  dialog.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-row]');
    if (remove) remove.closest('.row').remove();
  });
  window.addEventListener('open-target-modal', (event) => {
    reset();
    if (event.detail?.target) prefill(event.detail.target);
    if (!dialog.open) dialog.showModal();
  });

  reset();
}
