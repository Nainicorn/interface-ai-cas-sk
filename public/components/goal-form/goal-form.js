/**
 * New test run: pick one of the app's saved goals + a login (persona) + params.
 * Goals are authored in the Add/Edit-app modal, not here — the box displays the
 * picked goal read-only. Fires `run-started` so the run list and live viewer follow.
 * API: POST /api/runs.
 */

import { esc, parseParams, postJson } from '/lib/ui.js';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/goal-form/goal-form.html')).text();

  const noApp = root.querySelector('[data-noapp]');
  const form = root.querySelector('[data-form]');
  const appName = root.querySelector('[data-app-name]');
  const goalText = root.querySelector('[data-goal-text]');
  const goalsWrap = root.querySelector('[data-goals-wrap]');
  const goalsSelect = root.querySelector('[name=saved_goal]');
  const personaWrap = root.querySelector('[data-persona-wrap]');
  const personaSelect = root.querySelector('[name=persona]');
  const runButton = root.querySelector('button');
  const status = root.querySelector('[data-status]');

  let target = null;
  let savedGoals = [];

  const showGoal = (index) => {
    const picked = savedGoals[index];
    if (picked) {
      goalText.textContent = picked.text;
      goalText.classList.remove('none');
      runButton.disabled = false;
    } else {
      goalText.textContent = 'No saved goals yet — add one via the app’s ⋯ → Edit menu.';
      goalText.classList.add('none');
      runButton.disabled = true;
    }
  };

  window.addEventListener('app-selected', (event) => {
    target = event.detail.target;
    noApp.hidden = true;
    form.hidden = false;
    appName.textContent = target.display_name;

    savedGoals = target.goals ?? [];
    goalsWrap.hidden = savedGoals.length < 2; // one goal needs no picker
    goalsSelect.innerHTML = savedGoals.map((g, i) => `<option value="${i}">${esc(g.name)}</option>`).join('');
    showGoal(0);

    const personas = target.personas ?? [];
    personaWrap.hidden = personas.length === 0;
    personaSelect.innerHTML = personas
      .map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.note ? ` — ${esc(p.note)}` : ''}</option>`)
      .join('');
  });

  goalsSelect.addEventListener('change', () => showGoal(Number(goalsSelect.value)));

  window.addEventListener('apps-empty', () => {
    target = null;
    noApp.hidden = false;
    form.hidden = true;
  });

  runButton.addEventListener('click', async () => {
    const picked = savedGoals[Number(goalsSelect.value) || 0];
    if (!target || !picked) return;
    try {
      status.textContent = 'Starting…';
      const { run_id: runId } = await postJson('/api/runs', {
        app_id: target.app_id,
        goal: picked.text,
        params: parseParams(root.querySelector('[name=params]').value),
        ...(personaWrap.hidden ? {} : { persona: personaSelect.value }),
      });
      status.textContent = `Started ${runId} — watch it live below.`;
      window.dispatchEvent(new CustomEvent('run-started', { detail: { runId } }));
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });
}
