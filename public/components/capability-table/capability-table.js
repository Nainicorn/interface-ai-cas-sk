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
import { deleteJson, reliabilityBadge } from '/global/ui.js';

/** Inline icons, so the table needs no icon font or network fetch. Matches run-list. */
const ICON = {
  replay:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"/><path d="M13.5 2v3.5H10"/></svg>',
  trash:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.75A.75.75 0 0 1 7.25 2h1.5a.75.75 0 0 1 .75.75V4"/><path d="M4 4.5v8A1.5 1.5 0 0 0 5.5 14h5a1.5 1.5 0 0 0 1.5-1.5v-8"/><path d="M6.75 7v4M9.25 7v4"/></svg>',
};

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
          <span class="state">
            <span class="badge ${a.status}">${a.status}</span>
            <span class="badge ${a.risk_level}">${a.risk_level}</span>
            ${reliabilityBadge(a.confidence)}
          </span>
        </td>
        <td class="approve-cell">
          ${
            a.status === 'draft'
              ? `<button class="small secondary" data-status="${a.id}" data-to="approved"
                         title="Admit to the agent-facing catalog">Approve</button>`
              : `<button class="small secondary revoke" data-status="${a.id}" data-to="draft"
                         title="Withdraw from the agent-facing catalog; the recording and its history are kept">Revoke</button>`
          }
        </td>
        <td class="replay-cell">
          <button class="icon replay" data-replay="${a.id}" type="button"
                  title="Replay this capability exactly as recorded — no LLM">
            ${ICON.replay}<span class="sr">Replay</span>
          </button>
          <span class="result-line" data-result="${a.id}"></span>
        </td>
        <td class="del-cell">
          <button class="icon del" data-delete="${a.id}" type="button"
                  title="Delete this recording. The run that produced it keeps its evidence.">
            ${ICON.trash}<span class="sr">Delete</span>
          </button>
        </td>
        <td class="expand-cell">
          <button class="chevron" data-expand="${a.id}" type="button"
                  aria-expanded="false" title="Show what this capability takes and does">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
            <span class="sr">Expand</span>
          </button>
        </td>
      </tr>
      <tr class="expand" data-details="${a.id}" hidden><td colspan="6"></td></tr>`,
      )
      .join('') ||
    // The explainer lives in the empty state and nowhere else: it is what a first-time
    // reader needs, and it would be noise above a table that already has rows.
    `<tr><td colspan="6" class="muted empty">
       The flows an AI has already worked out and recorded, replayable exactly as recorded
       with no AI involved. Record one with a run above.
     </td></tr>`;
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
  /** Re-read now rather than waiting out the poll. */
  const refreshNow = () => {
    lastKey = '';
    return refresh();
  };

  refresh();
  setInterval(refresh, 5000);
  onSelectedApp(refreshNow);
  // Approving, revoking, deleting, and invoking from the catalog all land here at once.
  window.addEventListener('capabilities-changed', refreshNow);

  root.addEventListener('click', async (event) => {
    const expand = event.target.closest('[data-expand]');
    if (expand) {
      const row = root.querySelector(`[data-details="${expand.dataset.expand}"]`);
      if (row.hidden) row.querySelector('td').innerHTML = detailsHtml(await fetchArtifact(expand.dataset.expand));
      row.hidden = !row.hidden;
      expand.setAttribute('aria-expanded', String(!row.hidden));
      return;
    }

    // Approve and Revoke are one control in two states. Demotion is deliberately as easy
    // as promotion: a capability whose replays start failing should be pullable from the
    // agent catalog immediately, without deleting the recording or its history.
    const promote = event.target.closest('[data-status]');
    if (promote) {
      promote.disabled = true;
      try {
        await setStatus(promote.dataset.status, promote.dataset.to);
        // Broadcast rather than refresh directly: this row changing is also the Agent
        // catalog gaining or losing an entry, and both should land in the same tick.
        window.dispatchEvent(new CustomEvent('capabilities-changed'));
      } catch (err) {
        promote.disabled = false;
        promote.textContent = err.message;
      }
      return;
    }

    // Delete removes the recording only; api/artifacts.js keeps the run's evidence and
    // refuses outright while the capability is still approved.
    const remove = event.target.closest('[data-delete]');
    if (remove) {
      const id = remove.dataset.delete;
      if (!confirm(`Delete the recording "${id}"?\n\nThe run that produced it keeps its screenshots and transcript.`)) return;
      remove.disabled = true;
      try {
        await deleteJson(`/api/artifacts/${encodeURIComponent(id)}`);
        window.dispatchEvent(new CustomEvent('capabilities-changed'));
      } catch (err) {
        remove.disabled = false;
        alert(err.message);
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
      // A replay IS a run: its result lives in the Runs tab; here only the replay
      // count in State moves. Refresh now so the count ticks immediately.
      window.dispatchEvent(new CustomEvent('replay-finished'));
      await refreshNow();
      const note = root.querySelector(`[data-result="${id}"]`);
      if (note) {
        note.innerHTML = '<span class="muted">Done — result is in Runs</span>';
        setTimeout(() => { if (note.isConnected) note.innerHTML = ''; }, 4000);
      }
    } catch (err) {
      result.innerHTML = `<span class="error">${err.message}</span>`;
      button.disabled = false;
    }
  });
}
