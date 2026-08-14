/**
 * Runs tab: every run, newest first, with its status and what it produced.
 * Re-renders only when the data actually changes, so the table never flickers.
 * API: GET /api/runs.
 */

const fetchRuns = () => fetch('/api/runs').then((r) => r.json());

let lastRender = '';

function render(root, runs) {
  const rows = runs
    .map((run) => {
      const artifact = run.detail?.artifact ? `${run.detail.artifact.id} v${run.detail.artifact.version}` : '';
      const outcome = run.kind === 'replay' ? (run.detail?.capability ? `${run.detail.capability} v${run.detail.version}` : '') : '';
      return `
        <tr>
          <td class="mono">${run.id}</td>
          <td>${run.kind}</td>
          <td><span class="badge ${run.status}">${run.status}</span>${run.live ? ` <span class="muted">${run.owner}</span>` : ''}</td>
          <td>${run.goal ?? `<span class="muted">${outcome}</span>`}</td>
          <td class="mono">${artifact}</td>
        </tr>`;
    })
    .join('');

  root.querySelector('tbody').innerHTML =
    rows || `<tr><td colspan="5" class="muted">No runs yet — start one from the goal form.</td></tr>`;
}

export function mount(root) {
  root.innerHTML = `
    <table>
      <thead><tr><th>Run</th><th>Kind</th><th>Status</th><th>Goal / capability</th><th>Recorded</th></tr></thead>
      <tbody></tbody>
    </table>
  `;

  const refresh = async () => {
    try {
      const runs = await fetchRuns();
      const key = JSON.stringify(runs.map((r) => [r.id, r.status, r.owner, r.live]));
      if (key === lastRender) return;
      lastRender = key;
      render(root, runs);
    } catch {
      /* transient poll failure */
    }
  };
  refresh();
  setInterval(refresh, 2000);
  window.addEventListener('run-started', refresh);
}
