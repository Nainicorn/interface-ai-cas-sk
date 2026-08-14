/**
 * Goal form: start a discovery run — natural-language goal + target + params.
 * API: GET /api/targets (once), POST /api/runs.
 */

async function startRun(body) {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json();
}

/** "member_id=10001 branch=riverside" → { member_id: '10001', branch: 'riverside' } */
function parseParams(text) {
  const params = {};
  for (const pair of text.split(/[\s,]+/).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq > 0) params[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return params;
}

export function mount(root) {
  root.innerHTML = `
    <h2>New discovery run</h2>
    <label>Target app</label>
    <select name="app"></select>
    <label>Goal (natural language)</label>
    <input name="goal" placeholder="Look up member 10001 and read their savings balance" />
    <label>Run parameters (name=value, space-separated)</label>
    <input name="params" placeholder="member_id=10001" />
    <button>Run agent</button>
    <p class="muted" data-status></p>
  `;

  const select = root.querySelector('select');
  fetch('/api/targets')
    .then((r) => r.json())
    .then((targets) => {
      select.innerHTML = targets
        .map((t) => `<option value="${t.app_id}">${t.display_name}</option>`)
        .join('');
    });

  const status = root.querySelector('[data-status]');
  root.querySelector('button').addEventListener('click', async () => {
    try {
      status.textContent = 'Starting…';
      const { run_id: runId } = await startRun({
        app_id: select.value,
        goal: root.querySelector('[name=goal]').value,
        params: parseParams(root.querySelector('[name=params]').value),
      });
      status.textContent = `Started ${runId} — watch it under Runs.`;
      window.dispatchEvent(new CustomEvent('run-started', { detail: { runId } }));
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });
}
