/**
 * Capabilities tab: each recorded capability with a per-row Replay action,
 * replay-reliability (confidence), the Approve control that admits a draft to the
 * agent-facing catalog, and a chevron in the last column that expands the full detail
 * — contract, recorded steps, and the outcomes it can answer without failing.
 *
 * Each capability occupies exactly one row; everything that would stack lives inline.
 * Scoped to the sidebar's selected app, like the runs table beside it.
 * API: GET /api/capabilities, GET /api/capabilities/:id, POST /api/capabilities/:id/replay,
 *      PATCH /api/capabilities/:id/status.
 */

import { hasSelection, onSelectedApp, selectedAppId } from '/global/selected-app.js';
import { deleteJson, esc, getJson, postJson, reliabilityBadge, sendJson } from '/global/helpers.js';

/** Inline icons, so the table needs no icon font or network fetch. Matches discoveries. */
const ICON = {
  replay:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"/><path d="M13.5 2v3.5H10"/></svg>',
  trash:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.75A.75.75 0 0 1 7.25 2h1.5a.75.75 0 0 1 .75.75V4"/><path d="M4 4.5v8A1.5 1.5 0 0 0 5.5 14h5a1.5 1.5 0 0 0 1.5-1.5v-8"/><path d="M6.75 7v4M9.25 7v4"/></svg>',
};

/** Capability ids with assisted fallback armed for their next replay. Explicit, per-id,
 *  and never persisted — a fresh page load always starts with this empty. */
const fallbackEnabled = new Set();

const fetchArtifacts = () => getJson('/api/capabilities');
const fetchArtifact = (id) => getJson(`/api/capabilities/${encodeURIComponent(id)}`);
const setStatus = (id, status) => sendJson('PATCH', `/api/capabilities/${encodeURIComponent(id)}/status`, { status });
const replay = (id, params, assistedFallback) =>
  postJson(`/api/capabilities/${encodeURIComponent(id)}/replay`, { params, assisted_fallback: assistedFallback });
const checkStability = (id, params, runs) =>
  postJson(`/api/capabilities/${encodeURIComponent(id)}/stability`, { params, runs });

/** One side of the contract as a definition list; "none" reads better than an em dash. */
function schemaList(schema) {
  const props = Object.entries(schema?.properties ?? {});
  if (!props.length) return '<p class="none muted">none</p>';
  const required = new Set(schema?.required ?? []);
  return `<ul class="contract-list">${props
    .map(([name, spec]) => `
      <li>
        <span class="mono">${esc(name)}</span>
        <span class="muted">${esc(spec?.type ?? 'string')}${required.has(name) ? '' : ' · optional'}</span>
        ${spec?.description ? `<div class="muted desc">${esc(spec.description)}</div>` : ''}
      </li>`)
    .join('')}</ul>`;
}

/**
 * Readable summary for the expansion row: description, steps as intents, outcomes.
 *
 * Everything here is escaped because everything here is untrusted: names, intents,
 * and outcome messages were written by a model reading somebody else's web page, so
 * they are exactly as safe to interpolate as the page was.
 */
function detailsHtml(capability) {
  const steps = capability.steps
    .map((s) => `<li><span class="mono">${esc(s.action)}</span> — ${esc(s.intent)}</li>`)
    .join('');
  const outcomes = capability.steps
    .flatMap((s) => s.business_outcomes ?? [])
    .map((b) => `<li><b>${esc(b.code)}</b> — ${esc(b.message)}</li>`)
    .join('');
  return `
    <p class="lede">${esc(capability.description)}</p>

    <div class="contract">
      <div><h4>Takes</h4>${schemaList(capability.input_schema)}</div>
      <div><h4>Returns</h4>${schemaList(capability.output_schema)}</div>
    </div>

    <h4>Recorded steps</h4>
    <ol class="steps">${steps}</ol>
    ${outcomes ? `<h4>Also answers, without failing</h4><ol class="steps">${outcomes}</ol>` : ''}
    ${tenantOverridesHtml(capability.target.tenant_overrides)}

    <h4>Stability</h4>
    <div class="stability-check">
      <button class="small secondary" data-stability="${esc(capability.id)}" type="button">Replay 5×</button>
      <span class="stability-result" data-stability-result="${esc(capability.id)}"></span>
    </div>

    <h4>Assisted fallback <span class="hint">off by default</span></h4>
    <label class="fallback-check">
      <input type="checkbox" data-fallback="${esc(capability.id)}" ${fallbackEnabled.has(capability.id) ? 'checked' : ''} />
      Allow one bounded AI call on the next replay, only if a step's locator can't be found at all
    </label>

    <h4>Export</h4>
    <p class="muted export-line">
      <a class="small secondary button-like" href="/api/capabilities/${esc(capability.id)}/codegen" download
         title="A standalone Playwright script, generated from this recording">Generate test script</a>
    </p>

    <p class="muted provenance">Recorded by ${esc(capability.created_from.model ?? 'hand')} · run <span class="mono">${esc(capability.created_from.run_id)}</span></p>
  `;
}

/**
 * Declared tenant patches, if this recording has any. Empty is the common case — most
 * tenants running the same vendor product need no override at all — so nothing renders
 * when the list is empty rather than an always-visible "0 overrides" line.
 */
function tenantOverridesHtml(overrides) {
  if (!overrides?.length) return '';
  const items = overrides
    .map(
      (o) => `<li><span class="mono">${esc(o.tenant_id)}</span> —
        ${o.step_overrides.length} step${o.step_overrides.length === 1 ? '' : 's'} patched
        ${o.base_url ? `, different origin` : ''}
        ${o.note ? `<div class="muted desc">${esc(o.note)}</div>` : ''}</li>`,
    )
    .join('');
  return `<h4>Tenant overrides</h4><ul class="contract-list">${items}</ul>`;
}

/** A run per dot, colored by the same outcome badge tones the rest of the console uses. */
function stabilityResultHtml(summary) {
  const dots = summary.results
    .map((r) => `<span class="badge dot ${esc(r.outcome)}" title="${esc(r.outcome)}"></span>`)
    .join('');
  return `<span class="stability-dots">${dots}</span><b class="stability-pct">${summary.stability_pct}%</b>
    <span class="muted">held (${summary.held}/${summary.runs})</span>`;
}


function render(root, artifacts) {
  root.querySelector('tbody').innerHTML =
    artifacts
      .map(
        (a) => `
      <tr data-id="${esc(a.id)}">
        <td class="name-cell"><b class="cap-name" title="${esc(a.name)}">${esc(a.name)}</b></td>
        <td class="state-cell">
          <span class="state">
            <span class="badge ${esc(a.status)}">${esc(a.status)}</span>
            <span class="badge ${esc(a.risk_level)}">${esc(a.risk_level)}</span>
            ${reliabilityBadge(a.confidence)}
          </span>
        </td>
        <td class="approve-cell">
          ${
            a.status === 'draft'
              ? `<button class="small secondary" data-status="${esc(a.id)}" data-to="approved"
                         title="Admit to the agent-facing catalog">Approve</button>`
              : `<button class="small secondary revoke" data-status="${esc(a.id)}" data-to="draft"
                         title="Withdraw from the agent-facing catalog; the recording and its history are kept">Revoke</button>`
          }
        </td>
        <td class="replay-cell">
          <button class="icon replay" data-replay="${esc(a.id)}" type="button"
                  title="Replay this capability exactly as recorded — no LLM">
            ${ICON.replay}<span class="sr">Replay</span>
          </button>
          <span class="result-line" data-result="${esc(a.id)}"></span>
        </td>
        <td class="del-cell">
          <button class="icon del" data-delete="${esc(a.id)}" type="button"
                  title="Delete this recording. The run that produced it keeps its evidence.">
            ${ICON.trash}<span class="sr">Delete</span>
          </button>
        </td>
        <td class="expand-cell">
          <button class="chevron" data-expand="${esc(a.id)}" type="button"
                  aria-expanded="false" title="Show what this capability takes and does">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>
            <span class="sr">Expand</span>
          </button>
        </td>
      </tr>
      <tr class="expand" data-details="${esc(a.id)}" hidden><td colspan="6"></td></tr>`,
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
  root.innerHTML = await (await fetch('/components/capabilities/capabilities.html')).text();

  const paramsDialog = root.querySelector('[data-params-dialog]');
  const paramsFields = root.querySelector('[data-params-fields]');
  const paramsIntro = root.querySelector('[data-params-intro]');
  const paramsRun = root.querySelector('[data-params-run]');

  /**
   * Collect a capability's required inputs before replaying it. Resolves to a params
   * object, or null if the operator cancels. No dialog at all when nothing is required —
   * a capability with an empty input_schema should replay in one click, same as before.
   */
  function askForParams(capability) {
    const required = capability.input_schema?.required ?? [];
    if (!required.length) return Promise.resolve({});

    paramsIntro.textContent = `${capability.name} needs these to replay:`;
    paramsFields.innerHTML = required
      .map((name) => {
        const desc = capability.input_schema.properties?.[name]?.description;
        return `
          <label>${esc(name)}${desc ? ` <span class="hint">${esc(desc)}</span>` : ''}</label>
          <input name="param:${esc(name)}" autocomplete="off" />`;
      })
      .join('');

    return new Promise((resolve) => {
      let confirmed = false;
      const onRun = () => {
        confirmed = true;
        paramsDialog.close();
      };
      // The 'close' event is the single source of truth: it fires the same way whether
      // Run, Cancel, or Escape closed the dialog, so there is exactly one resolve path.
      const onClose = () => {
        paramsRun.removeEventListener('click', onRun);
        paramsDialog.removeEventListener('close', onClose);
        if (!confirmed) return resolve(null);
        const params = {};
        for (const name of required) params[name] = paramsFields.querySelector(`[name="param:${name}"]`).value;
        resolve(params);
      };
      paramsRun.addEventListener('click', onRun);
      paramsDialog.addEventListener('close', onClose);
      paramsDialog.showModal();
    });
  }

  root.querySelector('[data-params-cancel]').addEventListener('click', () => paramsDialog.close());

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
    const fallbackToggle = event.target.closest('[data-fallback]');
    if (fallbackToggle) {
      const id = fallbackToggle.dataset.fallback;
      if (fallbackToggle.checked) fallbackEnabled.add(id);
      else fallbackEnabled.delete(id);
      return;
    }

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

    // Delete removes the recording only; api/capabilities.js keeps the run's evidence and
    // refuses outright while the capability is still approved.
    const remove = event.target.closest('[data-delete]');
    if (remove) {
      const id = remove.dataset.delete;
      if (!confirm(`Delete the recording "${id}"?\n\nThe run that produced it keeps its screenshots and transcript.`)) return;
      remove.disabled = true;
      try {
        await deleteJson(`/api/capabilities/${encodeURIComponent(id)}`);
        window.dispatchEvent(new CustomEvent('capabilities-changed'));
      } catch (err) {
        remove.disabled = false;
        alert(err.message);
      }
      return;
    }

    const stabilityButton = event.target.closest('[data-stability]');
    if (stabilityButton) {
      const id = stabilityButton.dataset.stability;
      const resultEl = root.querySelector(`[data-stability-result="${id}"]`);
      const capability = await fetchArtifact(id);
      const params = await askForParams(capability);
      if (params === null) return; // cancelled

      stabilityButton.disabled = true;
      resultEl.textContent = 'Replaying 5×…';
      try {
        const summary = await checkStability(id, params, 5);
        resultEl.innerHTML = stabilityResultHtml(summary);
        window.dispatchEvent(new CustomEvent('replay-finished'));
      } catch (err) {
        resultEl.innerHTML = `<span class="error">${esc(err.message)}</span>`;
      } finally {
        stabilityButton.disabled = false;
      }
      return;
    }

    const button = event.target.closest('[data-replay]');
    if (!button) return;
    const id = button.dataset.replay;
    const result = root.querySelector(`[data-result="${id}"]`);

    // Required inputs need a value per replay — the recording has no memory of what
    // it was tried with. Optional ones stay unset unless the caller wants to override.
    const capability = await fetchArtifact(id);
    const params = await askForParams(capability);
    if (params === null) return; // cancelled

    button.disabled = true;
    try {
      const outcome = await replay(id, params, fallbackEnabled.has(id));
      if (outcome.assisted_fallbacks?.length) {
        result.innerHTML = `<span class="hint">AI-assisted fix used — see the run report</span>`;
      }
      // A replay IS a run: its result lives in the Runs tab; here only the replay
      // count in State moves. Refresh now so the count ticks immediately.
      window.dispatchEvent(new CustomEvent('replay-finished'));
      await refreshNow();
    } catch (err) {
      result.innerHTML = `<span class="error">${esc(err.message)}</span>`;
      button.disabled = false;
    }
  });
}
