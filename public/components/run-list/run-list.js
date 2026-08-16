/**
 * Test runs table: every discovery and replay, newest first, each with a Report link
 * that opens the full evidence view in a new tab. Re-renders only when the data
 * actually changes, so the table never flickers.
 * API: GET /api/runs.
 */

import { esc, getJson } from '/lib/ui.js';

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
          <td><a class="report-link" target="_blank" rel="noopener" href="/report.html?run=${encodeURIComponent(run.id)}">Report</a></td>
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
  let selectedApp = null;
  const refresh = async () => {
    try {
      const runs = await getJson('/api/runs');
      // The list is scoped to the app selected in the sidebar.
      const scoped = selectedApp ? runs.filter((r) => r.app_id === selectedApp) : runs;
      const key = JSON.stringify([selectedApp, scoped.map((r) => [r.id, r.status, r.owner, r.live])]);
      if (key === lastKey) return;
      lastKey = key;
      render(root, scoped);
    } catch {
      /* transient poll failure */
    }
  };
  refresh();
  setInterval(refresh, 2000);
  window.addEventListener('run-started', refresh);
  window.addEventListener('replay-finished', refresh);
  window.addEventListener('app-selected', (event) => {
    selectedApp = event.detail.target.app_id;
    refresh();
  });
}
