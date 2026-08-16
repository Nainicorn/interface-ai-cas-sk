/**
 * Capabilities tab: each recorded capability with a per-row Replay action,
 * replay-reliability (confidence), the Approve control that admits a draft to the
 * agent-facing catalog, and a chevron in the last column that expands the full detail
 * — contract, recorded steps, and the outcomes it can answer without failing.
 *
 * Each capability occupies exactly one row; everything that would stack lives inline.
 * Scoped to the sidebar's selected app, like the runs table beside it.
 * API: GET /api/artifacts, GET /api/artifacts/:id, POST /api/artifacts/:id/replay,
 *      PATCH /api/artifacts/:id/status.
 */

import { hasSelection, onSelectedApp, selectedAppId } from '/global/selected-app.js';

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

/** One side of the contract as a definition list; "none" reads better than an em dash. */
function schemaList(schema) {
  const props = Object.entries(schema?.properties ?? {});
  if (!props.length) return '<p class="none muted">none</p>';
  const required = new Set(schema?.required ?? []);
  return `<ul class="contract-list">${props
    .map(([name, spec]) => `
      <li>
        <span class="mono">${name}</span>
        <span class="muted">${spec?.type ?? 'string'}${required.has(name) ? '' : ' · optional'}</span>
        ${spec?.description ? `<div class="muted desc">${spec.description}</div>` : ''}
      </li>`)
    .join('')}</ul>`;
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
    <p class="lede">${capability.description}</p>

    <div class="contract">
      <div><h4>Takes</h4>${schemaList(capability.input_schema)}</div>
      <div><h4>Returns</h4>${schemaList(capability.output_schema)}</div>
    </div>

    <h4>Recorded steps</h4>
    <ol class="steps">${steps}</ol>
    ${outcomes ? `<h4>Also answers, without failing</h4><ol class="steps">${outcomes}</ol>` : ''}
    <p class="muted provenance">Recorded by ${capability.created_from.model ?? 'hand'} · run <span class="mono">${capability.created_from.run_id}</span></p>
  `;
}


function render(root, artifacts) {
  root.querySelector('tbody').innerHTML =
    artifacts
      .map(
        (a) => `
      <tr data-id="${a.id}">
        <td class="name-cell"><b class="cap-name" title="${a.name}">${a.name}</b></td>
        <td class="state-cell">
          <span class="badge ${a.status}">${a.status}</span>
          <span class="badge ${a.risk_level}">${a.risk_level}</span>
          <span class="muted replays">${confidenceText(a)}</span>
        </td>
        <td class="approve-cell">
          ${
            a.status === 'draft'
              ? `<button class="small secondary" data-approve="${a.id}" title="Admit to the agent-facing catalog">Approve</button>`
              : '<span class="muted dash">—</span>'
          }
        </td>
        <td class="replay-cell">
          <button class="small" data-replay="${a.id}">Replay</button>
          <span class="result-line" data-result="${a.id}"></span>
        </td>
        <td class="expand-cell">
          <button class="chevron" data-expand="${a.id}" type="button"
                  aria-expanded="false" title="Show what this capability takes and does">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
            <span class="sr">Expand</span>
          </button>
        </td>
      </tr>
      <tr class="expand" data-details="${a.id}" hidden><td colspan="5"></td></tr>`,
      )
      .join('') || `<tr><td colspan="5" class="muted">No capabilities for this app yet — record one with a run above.</td></tr>`;
}

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/capability-table/capability-table.html')).text();

  let lastKey = '';

  const refresh = async () => {
    // Same rule as the runs table: nothing decided yet means render nothing, never all.
    const appId = selectedAppId();
    if (!hasSelection() || !appId) {
      if (lastKey === 'none') return;
      lastKey = 'none';
      render(root, []);
      return;
    }
    try {
      const artifacts = await fetchArtifacts();
      const scoped = artifacts.filter((a) => a.app_id === appId);
      const key = JSON.stringify([appId, scoped.map((a) => [a.id, a.version, a.status, a.confidence?.runs ?? 0])]);
      if (key === lastKey) return; // don't clobber inputs/results while the user works
      lastKey = key;
      render(root, scoped);
    } catch {
      /* transient poll failure */
    }
  };
  refresh();
  setInterval(refresh, 5000);
  onSelectedApp(() => {
    lastKey = '';
    refresh();
  });

  root.addEventListener('click', async (event) => {
    const expand = event.target.closest('[data-expand]');
    if (expand) {
      const row = root.querySelector(`[data-details="${expand.dataset.expand}"]`);
      if (row.hidden) row.querySelector('td').innerHTML = detailsHtml(await fetchArtifact(expand.dataset.expand));
      row.hidden = !row.hidden;
      expand.setAttribute('aria-expanded', String(!row.hidden));
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
      await replay(id, {}); // recorded capabilities replay as recorded
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
