/**
 * Test runs table: every discovery and replay, newest first, each with a Report link
 * that opens the full evidence view in a new tab, and a Delete that removes the run and
 * its evidence. Re-renders only when the data actually changes, so the table never
 * flickers.
 * Scoped to the sidebar's selected app: a run belongs to one app, and showing another
 * app's runs here is wrong, not merely noisy.
 * API: GET /api/runs, DELETE /api/runs/:id.
 */

import { hasSelection, onSelectedApp, selectedAppId } from '/lib/selected-app.js';
import { deleteJson, esc, getJson } from '/lib/ui.js';

/** What a replay run produced, in one readable line. */
function replaySummary(detail) {
  if (detail?.outputs) {
    return Object.entries(detail.outputs)
      .map(([k, v]) => `${esc(k)}: ${esc(v)}`)
      .join(' · ');
  }
  if (detail?.business_outcome) {
    return `${esc(detail.business_outcome.code)} — ${esc(detail.business_outcome.message)}`;
  }
  if (detail?.failed_step) {
    return `failed at step ${esc(detail.failed_step.step)}: ${esc(detail.failed_step.message)}`;
  }
  return '';
}

function render(root, runs) {
  const rows = runs
    .map((run) => {
      const what = run.goal
        ? esc(run.goal)
        : `<span class="muted">${run.detail?.capability ? `${esc(run.detail.capability)} · ` : ''}${replaySummary(run.detail)}</span>`;
      return `
        <tr>
          <td class="mono">${esc(run.id)}</td>
          <td>${esc(run.app_id ?? '')}</td>
          <td>${esc(run.kind)}</td>
          <td><span class="badge ${esc(run.status)}">${esc(run.status)}</span>${run.live ? ` <span class="muted">${esc(ownerLabel(run.owner))}</span>` : ''}</td>
          <td>${what}</td>
          <td class="actions">
            <a class="report-link" target="_blank" rel="noopener" href="/report.html?run=${encodeURIComponent(run.id)}">Report</a>
            ${run.live ? '' : `<button class="del" data-delete="${esc(run.id)}" type="button" title="Delete this run and its evidence">Delete</button>`}
          </td>
        </tr>`;
    })
    .join('');

  root.querySelector('tbody').innerHTML =
    rows || `<tr><td colspan="6" class="muted">No runs for this app yet — start one above.</td></tr>`;
}

/** Who is holding the live session, in the live viewer's words. */
const ownerLabel = (owner) =>
  ({ agent: 'agent driving', human: 'human driving', paused: 'awaiting operator' })[owner] ?? owner ?? '';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/run-list/run-list.html')).text();

  let lastKey = '';
  const refresh = async () => {
    // Until the sidebar has decided, render nothing. Falling back to "all runs" here is
    // what used to splice other apps' runs into the table on a refresh.
    const appId = selectedAppId();
    if (!hasSelection() || !appId) {
      if (lastKey === 'none') return;
      lastKey = 'none';
      render(root, []);
      return;
    }
    try {
      const runs = await getJson('/api/runs');
      const scoped = runs.filter((r) => r.app_id === appId);
      const key = JSON.stringify([appId, scoped.map((r) => [r.id, r.status, r.owner, r.live])]);
      if (key === lastKey) return;
      lastKey = key;
      render(root, scoped);
    } catch {
      /* transient poll failure */
    }
  };
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete]');
    if (!button) return;
    const runId = button.dataset.delete;
    if (!confirm(`Delete run ${runId}? Its screenshots, transcript and recording go with it.`)) return;
    button.disabled = true;
    try {
      await deleteJson(`/api/runs/${encodeURIComponent(runId)}`);
      lastKey = ''; // force a re-render rather than wait for the poll to notice
      await refresh();
      window.dispatchEvent(new CustomEvent('replay-finished')); // capability list may have lost one
    } catch (err) {
      button.disabled = false;
      alert(err.message);
    }
  });

  refresh();
  setInterval(refresh, 2000);
  window.addEventListener('run-started', refresh);
  window.addEventListener('replay-finished', refresh);
  onSelectedApp(() => {
    lastKey = ''; // a different app is a different table; never reuse the last render
    refresh();
  });
}
