/**
 * Test runs table: every discovery and replay, newest first, with a Report icon that
 * opens the full evidence view in a new tab and a Delete icon that removes the run.
 * Re-renders only when the data actually changes, so the table never flickers.
 *
 * Columns are deliberately thin: the run's path is where it lives, not information, so
 * only its timestamp is shown; the goal and outcome live in the report behind it.
 * Scoped to the sidebar's selected app: a run belongs to one app, and showing another
 * app's runs here is wrong, not merely noisy.
 * API: GET /api/runs, DELETE /api/runs/:id.
 */

import { hasSelection, onSelectedApp, selectedAppId } from '/global/selected-app.js';
import { deleteJson, esc, getJson } from '/global/ui.js';

/** Inline icons, so the table needs no icon font or network fetch. */
const ICON = {
  report: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z"/><path class="fold" d="M9 1.5V5a.5.5 0 0 0 .5.5H13"/><path class="rule" d="M5.5 8.5h5M5.5 11h3.5"/></svg>',
  trash: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.75A.75.75 0 0 1 7.25 2h1.5a.75.75 0 0 1 .75.75V4"/><path d="M4 4.5v8A1.5 1.5 0 0 0 5.5 14h5a1.5 1.5 0 0 0 1.5-1.5v-8"/><path d="M6.75 7v4M9.25 7v4"/></svg>',
};

/**
 * Split the run's timestamp out of its id — the rest of the path is just where it
 * lives. Date and time get their own cells so both columns align down the table.
 */
function when(run) {
  const stamp = String(run.id).split('/').pop() ?? ''; // 2026-08-16_041115
  const [date, time] = stamp.split('_');
  if (!date || !time) return { date: esc(stamp), time: '' };
  return {
    date: esc(new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
    time: esc(`${time.slice(0, 2)}:${time.slice(2, 4)}`),
  };
}

function render(root, runs) {
  const rows = runs
    .map((run) => {
      const at = when(run);
      return `
        <tr>
          <td class="date">${at.date}</td>
          <td class="time mono">${at.time}</td>
          <td>${esc(run.kind)}</td>
          <td><span class="badge ${esc(run.status)}">${esc(run.status)}</span>${run.live ? ` <span class="muted">${esc(ownerLabel(run.owner))}</span>` : ''}</td>
          <td class="actions">
            <a class="icon report-link" target="_blank" rel="noopener" title="Open the full report"
               href="/report.html?run=${encodeURIComponent(run.id)}">${ICON.report}<span class="sr">Report</span></a>
            ${
              run.live
                ? ''
                : `<button class="icon del" data-delete="${esc(run.id)}" type="button" title="Delete this run and its evidence">${ICON.trash}<span class="sr">Delete</span></button>`
            }
          </td>
        </tr>`;
    })
    .join('');

  root.querySelector('tbody').innerHTML =
    rows || `<tr><td colspan="5" class="muted">No runs for this app yet — start one above.</td></tr>`;
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
