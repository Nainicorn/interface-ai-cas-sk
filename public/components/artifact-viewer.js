/**
 * Artifact viewer: the recorded capabilities, human-readable. Click one to read the
 * full versioned JSON — the thing a reviewer would approve.
 * API: GET /api/artifacts, GET /api/artifacts/:id.
 */

const fetchArtifacts = () => fetch('/api/artifacts').then((r) => r.json());
const fetchArtifact = (id) => fetch(`/api/artifacts/${id}`).then((r) => r.json());

function render(root, artifacts) {
  root.querySelector('tbody').innerHTML =
    artifacts
      .map(
        (a) => `
      <tr class="selectable" data-id="${a.id}">
        <td>${a.name}<br><code class="muted">${a.id} v${a.version}</code></td>
        <td><span class="badge">${a.status}</span> <span class="badge">${a.risk_level}</span></td>
        <td class="muted">${Object.keys(a.input_schema?.properties ?? {}).join(', ')} →
            ${Object.keys(a.output_schema?.properties ?? {}).join(', ')}</td>
      </tr>`,
      )
      .join('') || `<tr><td colspan="3" class="muted">No capabilities recorded yet.</td></tr>`;
}

export function mount(root) {
  root.innerHTML = `
    <h2>Capabilities</h2>
    <table>
      <thead><tr><th>Capability</th><th>State</th><th>Contract</th></tr></thead>
      <tbody></tbody>
    </table>
    <pre style="display:none"></pre>
  `;

  const pre = root.querySelector('pre');
  root.addEventListener('click', async (event) => {
    const row = event.target.closest('tr[data-id]');
    if (!row) return;
    pre.style.display = '';
    pre.textContent = JSON.stringify(await fetchArtifact(row.dataset.id), null, 2);
  });

  const refresh = () => fetchArtifacts().then((a) => render(root, a)).catch(() => {});
  refresh();
  setInterval(refresh, 5000);
}
