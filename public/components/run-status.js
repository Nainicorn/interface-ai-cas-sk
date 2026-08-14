/**
 * Run list: polls all runs, badges their status, shows the live screenshot of the
 * selected (or most recent live) run.
 * API: GET /api/runs, GET /api/runs/:id/screenshot.
 */

const fetchRuns = () => fetch('/api/runs').then((r) => r.json());

let selectedRunId = null;

function render(root, runs) {
  const rows = runs
    .map((run) => {
      const artifact = run.detail?.artifact
        ? `${run.detail.artifact.id} v${run.detail.artifact.version}`
        : '';
      return `
        <tr class="selectable" data-run="${run.id}">
          <td>${run.id}</td>
          <td>${run.kind}</td>
          <td><span class="badge ${run.status}">${run.status}</span>${run.live ? ` <span class="muted">owner: ${run.owner}</span>` : ''}</td>
          <td>${run.goal ?? ''}</td>
          <td>${artifact}</td>
        </tr>`;
    })
    .join('');

  root.querySelector('tbody').innerHTML = rows || `<tr><td colspan="5" class="muted">No runs yet.</td></tr>`;

  const live = runs.find((r) => r.id === selectedRunId) ?? runs.find((r) => r.live) ?? runs[0];
  const img = root.querySelector('img');
  if (live) {
    // onerror hides it for runs with no screenshots (e.g. clean replays).
    img.src = `/api/runs/${live.id}/screenshot?t=${Date.now()}`;
  } else {
    img.style.display = 'none';
  }
}

export function mount(root) {
  root.innerHTML = `
    <h2>Runs</h2>
    <table>
      <thead><tr><th>Run</th><th>Kind</th><th>Status</th><th>Goal</th><th>Artifact</th></tr></thead>
      <tbody></tbody>
    </table>
    <img class="shot" alt="latest screenshot of selected run" />
  `;

  const img = root.querySelector('img');
  img.addEventListener('error', () => { img.style.display = 'none'; });
  img.addEventListener('load', () => { img.style.display = ''; });

  root.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-run]');
    if (row) selectedRunId = row.dataset.run;
  });

  const refresh = () => fetchRuns().then((runs) => render(root, runs)).catch(() => {});
  refresh();
  setInterval(refresh, 2000);
  window.addEventListener('run-started', refresh);
}
