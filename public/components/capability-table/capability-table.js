/**
 * Capabilities tab: each recorded capability with its contract in plain words, a
 * per-row Replay action, replay-reliability (confidence), the Approve control that
 * admits a draft to the agent-facing catalog, and a click-to-expand summary.
 * API: GET /api/artifacts, GET /api/artifacts/:id, POST /api/artifacts/:id/replay,
 *      PATCH /api/artifacts/:id/status.
 */

const fetchArtifacts = () => fetch('/api/artifacts').then((r) => r.json());
const fetchArtifact = (id) => fetch(`/api/artifacts/${id}`).then((r) => r.json());

async function setStatus(id, status) {
  const res = await fetch(`/api/artifacts/${id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

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

/** Rolling reliability, written back by every replay. */
function confidenceText(artifact) {
  const c = artifact.confidence ?? {};
  return c.runs ? `${c.successes}/${c.runs} replays ok` : 'no replays yet';
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


function render(root, artifacts) {
  root.querySelector('tbody').innerHTML =
    artifacts
      .map(
        (a) => `
      <tr data-id="${a.id}">
        <td><a href="#" data-expand="${a.id}"><b>${a.name}</b></a><br><span class="mono muted">${a.id} v${a.version}</span></td>
        <td class="state-cell">
          <div class="badges">
            <span class="badge ${a.status}">${a.status}</span>
            <span class="badge ${a.risk_level}">${a.risk_level}</span>
          </div>
          <div class="muted mono replays">${confidenceText(a)}</div>
          ${a.status === 'draft' ? `<button class="small secondary" data-approve="${a.id}" title="Admit to the agent-facing catalog">Approve</button>` : ''}
        </td>
        <td class="muted mono">${contractText(a)}</td>
        <td class="replay-cell">
          <div class="row">
            <input class="mono" data-params="${a.id}" placeholder="${paramsPlaceholder(a)}" />
            <button class="small" data-replay="${a.id}" style="flex:0 0 auto">Replay</button>
          </div>
          <div class="result-line" data-result="${a.id}"></div>
        </td>
      </tr>
      <tr class="expand" data-details="${a.id}" hidden><td colspan="4"></td></tr>`,
      )
      .join('') || `<tr><td colspan="4" class="muted">No capabilities for this app yet — record one with a run above.</td></tr>`;
}

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/capability-table/capability-table.html')).text();

  let lastKey = '';
  let selectedApp = null;
  const refresh = async () => {
    try {
      const artifacts = await fetchArtifacts();
      // The catalog is scoped to the app selected in the sidebar.
      const scoped = selectedApp ? artifacts.filter((a) => a.app_id === selectedApp) : artifacts;
      const key = JSON.stringify([selectedApp, scoped.map((a) => [a.id, a.version, a.status, a.confidence?.runs ?? 0])]);
      if (key === lastKey) return; // don't clobber inputs/results while the user works
      lastKey = key;
      render(root, scoped);
    } catch {
      /* transient poll failure */
    }
  };
  refresh();
  setInterval(refresh, 5000);
  window.addEventListener('app-selected', (event) => {
    selectedApp = event.detail.target.app_id;
    refresh();
  });

  root.addEventListener('click', async (event) => {
    const expand = event.target.closest('[data-expand]');
    if (expand) {
      event.preventDefault();
      const row = root.querySelector(`[data-details="${expand.dataset.expand}"]`);
      if (row.hidden) row.querySelector('td').innerHTML = detailsHtml(await fetchArtifact(expand.dataset.expand));
      row.hidden = !row.hidden;
      return;
    }

    const approve = event.target.closest('[data-approve]');
    if (approve) {
      approve.disabled = true;
      try {
        await setStatus(approve.dataset.approve, 'approved');
        lastKey = ''; // force a re-render on the next poll
        refresh();
      } catch (err) {
        approve.disabled = false;
        approve.textContent = err.message;
      }
      return;
    }

    const button = event.target.closest('[data-replay]');
    if (!button) return;
    const id = button.dataset.replay;
    const result = root.querySelector(`[data-result="${id}"]`);
    button.disabled = true;
    result.innerHTML = `<span class="muted">Replaying…</span>`;
    try {
      await replay(id, parseParams(root.querySelector(`[data-params="${id}"]`).value));
      // A replay IS a run: its result lives in the Test runs tab; here only the
      // replays count in State moves. Refresh now so the count ticks immediately.
      window.dispatchEvent(new CustomEvent('replay-finished'));
      lastKey = '';
      await refresh();
      const note = root.querySelector(`[data-result="${id}"]`);
      if (note) {
        note.innerHTML = `<span class="muted">Done — result is in Test runs</span>`;
        setTimeout(() => { if (note.isConnected) note.innerHTML = ''; }, 4000);
      }
    } catch (err) {
      result.innerHTML = `<span class="error">${err.message}</span>`;
      button.disabled = false;
    }
  });
}
