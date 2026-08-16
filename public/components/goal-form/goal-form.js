/**
 * New test run: shows the selected app's goal read-only, with one Run button.
 * The goal is authored in the add/edit-app dialog, not here — an app has exactly one.
 * Fires `run-started` so the run list and live viewer follow.
 * API: POST /api/runs.
 */

import { onSelectedApp } from '/lib/selected-app.js';
import { postJson } from '/lib/ui.js';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/goal-form/goal-form.html')).text();

  const noApp = root.querySelector('[data-noapp]');
  const form = root.querySelector('[data-form]');
  const appName = root.querySelector('[data-app-name]');
  const goalText = root.querySelector('[data-goal-text]');
  const runButton = root.querySelector('button');
  const status = root.querySelector('[data-status]');

  let target = null;

  const show = (selected) => {
    target = selected;
    noApp.hidden = true;
    form.hidden = false;
    appName.textContent = selected.display_name;
    status.textContent = '';

    const goal = selected.goal?.trim();
    goalText.textContent = goal || 'No goal set yet — hover this app in the sidebar and choose Edit.';
    goalText.classList.toggle('none', !goal);
    runButton.disabled = !goal;
  };

  onSelectedApp((selected) => {
    if (selected) return show(selected);
    target = null;
    noApp.hidden = false;
    form.hidden = true;
  });

  runButton.addEventListener('click', async () => {
    if (!target?.goal) return;
    try {
      status.textContent = 'Starting…';
      const { run_id: runId } = await postJson('/api/runs', { app_id: target.app_id, goal: target.goal });
      status.textContent = `Started ${runId} — watch it live below.`;
      window.dispatchEvent(new CustomEvent('run-started', { detail: { runId } }));
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });
}
