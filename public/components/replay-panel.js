/**
 * Replay panel: invoke a recorded capability with typed params — the production path.
 * No model anywhere; the result is one of the four declared outcomes.
 * API: GET /api/artifacts (for the picker), POST /api/artifacts/:id/replay.
 */

async function replay(id, params) {
  const res = await fetch(`/api/artifacts/${id}/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

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
    <h2>Replay a capability (no LLM)</h2>
    <label>Capability</label>
    <select></select>
    <label>Params (name=value)</label>
    <input name="params" placeholder="member_id=10001" />
    <button>Replay</button>
    <div data-result></div>
  `;

  const select = root.querySelector('select');
  const refreshOptions = () =>
    fetch('/api/artifacts')
      .then((r) => r.json())
      .then((artifacts) => {
        select.innerHTML = artifacts
          .map((a) => `<option value="${a.id}">${a.name} (v${a.version})</option>`)
          .join('');
      });
  refreshOptions();
  setInterval(refreshOptions, 10000);

  const result = root.querySelector('[data-result]');
  root.querySelector('button').addEventListener('click', async () => {
    const button = root.querySelector('button');
    button.disabled = true;
    result.innerHTML = `<p class="muted">Replaying…</p>`;
    try {
      const out = await replay(select.value, parseParams(root.querySelector('[name=params]').value));
      const body = out.outputs ?? out.business_outcome ?? out.failure ?? {};
      result.innerHTML = `
        <p><span class="badge ${out.outcome}">${out.outcome}</span>
           <span class="muted">run ${out.run_id}</span></p>
        <pre>${JSON.stringify(body, null, 2)}</pre>`;
    } catch (err) {
      result.innerHTML = `<p class="error">${err.message}</p>`;
    } finally {
      button.disabled = false;
    }
  });
}
