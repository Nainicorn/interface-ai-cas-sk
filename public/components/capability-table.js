/**
 * Capabilities tab: each recorded capability with its contract in plain words, a
 * per-row Replay action, and a click-to-expand summary of what it does — steps as
 * readable intents, never a schema dump.
 * API: GET /api/artifacts, GET /api/artifacts/:id, POST /api/artifacts/:id/replay.
 */

const fetchArtifacts = () => fetch('/api/artifacts').then((r) => r.json());
const fetchArtifact = (id) => fetch(`/api/artifacts/${id}`).then((r) => r.json());

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

/** "member_id=…" placeholder built from the capability's own input schema. */
function paramsPlaceholder(artifact) {
  const names = Object.keys(artifact.input_schema?.properties ?? {});
  return names.map((n) => `${n}=…`).join(' ') || 'no params';
}

function contractText(artifact) {
  const inputs = Object.keys(artifact.input_schema?.properties ?? {}).join(', ') || '—';
  const outputs = Object.keys(artifact.output_schema?.properties ?? {}).join(', ') || '—';
  return `${inputs} → ${outputs}`;
}

/** Readable summary for the expansion row: description, steps as intents, outcomes. */
function detailsHtml(capability) {
  const steps = capability.steps
    .map((s) => `<li><span class="mono">${s.action}</span> — ${s.intent}</li>`)
    .join('');
  const outcomes = capability.steps
    .flatMap((s) => s.business_outcomes ?? [])
    .map((b) => `<li><b>${b.code}</b> — ${b.message}</li>`)
    .join('');
  return `
    <p style="margin:0 0 6px">${capability.description}</p>
    <ol class="steps">${steps}</ol>
    ${outcomes ? `<p class="muted" style="margin:8px 0 2px">Also answers, without failing:</p><ol class="steps">${outcomes}</ol>` : ''}
    <p class="muted" style="margin:8px 0 0">Recorded by ${capability.created_from.model ?? 'hand'} · run <span class="mono">${capability.created_from.run_id}</span></p>
  `;
}

function outputsHtml(out) {
  const body = out.outputs && Object.keys(out.outputs).length ? out.outputs : out.business_outcome ?? out.failure ?? {};
  const lines = Object.entries(body)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
  return `<span class="badge ${out.outcome}">${out.outcome}</span>
          <span class="muted mono">run ${out.run_id}</span>
          ${lines ? `<pre>${lines}</pre>` : ''}`;
}

function render(root, artifacts) {
  root.querySelector('tbody').innerHTML =
    artifacts
      .map(
        (a) => `
      <tr data-id="${a.id}">
        <td><a href="#" data-expand="${a.id}"><b>${a.name}</b></a><br><span class="mono muted">${a.id} v${a.version}</span></td>
        <td><span class="badge ${a.status}">${a.status}</span> <span class="badge ${a.risk_level}">${a.risk_level}</span></td>
        <td class="muted mono">${contractText(a)}</td>
        <td style="min-width:260px">
          <div class="row">
            <input class="mono" data-params="${a.id}" placeholder="${paramsPlaceholder(a)}" />
            <button class="small" data-replay="${a.id}" style="flex:0 0 auto">Replay</button>
          </div>
          <div class="result-line" data-result="${a.id}"></div>
        </td>
      </tr>
      <tr class="expand" data-details="${a.id}" hidden><td colspan="4"></td></tr>`,
      )
      .join('') || `<tr><td colspan="4" class="muted">No capabilities recorded yet — run a discovery first.</td></tr>`;
}

export function mount(root) {
  root.innerHTML = `
    <table>
      <thead><tr><th>Capability</th><th>State</th><th>Contract (in → out)</th><th>Replay (no LLM)</th></tr></thead>
      <tbody></tbody>
    </table>
  `;

  let lastKey = '';
  const refresh = async () => {
    try {
      const artifacts = await fetchArtifacts();
      const key = JSON.stringify(artifacts.map((a) => [a.id, a.version, a.status]));
      if (key === lastKey) return; // don't clobber inputs/results while the user works
      lastKey = key;
      render(root, artifacts);
    } catch {
      /* transient poll failure */
    }
  };
  refresh();
  setInterval(refresh, 5000);

  root.addEventListener('click', async (event) => {
    const expand = event.target.closest('[data-expand]');
    if (expand) {
      event.preventDefault();
      const row = root.querySelector(`[data-details="${expand.dataset.expand}"]`);
      if (row.hidden) row.querySelector('td').innerHTML = detailsHtml(await fetchArtifact(expand.dataset.expand));
      row.hidden = !row.hidden;
      return;
    }

    const button = event.target.closest('[data-replay]');
    if (!button) return;
    const id = button.dataset.replay;
    const result = root.querySelector(`[data-result="${id}"]`);
    button.disabled = true;
    result.innerHTML = `<span class="muted">Replaying…</span>`;
    try {
      const out = await replay(id, parseParams(root.querySelector(`[data-params="${id}"]`).value));
      result.innerHTML = outputsHtml(out);
    } catch (err) {
      result.innerHTML = `<span class="error">${err.message}</span>`;
    } finally {
      button.disabled = false;
    }
  });
}
