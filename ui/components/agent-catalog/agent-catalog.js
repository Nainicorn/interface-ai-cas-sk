/**
 * Agent catalog tab: the agent-facing surface, rendered as an agent would receive it.
 *
 * Reads /api/catalog — a strictly narrower view than the Capabilities tab beside it,
 * because that one is the operator's and shows drafts. Approving a capability there makes
 * it appear here; revoking it makes it vanish. That visible move is the point of the tab.
 *
 * One row per capability, callable in place: the declared arguments are the form, and
 * Invoke POSTs to /api/catalog/:id/invoke. So this is not a description of the agent
 * path — it is the agent path, driven by hand.
 *
 * API: GET /api/catalog, POST /api/catalog/:id/invoke.
 */

import { hasSelection, onSelectedApp, selectedAppId } from '/global/selected-app.js';
import { esc, getJson, postJson, reliabilityBadge } from '/global/helpers.js';

/**
 * One control per declared parameter — the recorded contract IS the form.
 *
 * The parameter name is a prefix inside the control rather than a label stacked above it.
 * Stacking made every row two lines tall and ragged against the badges beside it, and a
 * placeholder-as-label vanishes the moment you type, which is precisely when a capability
 * with several arguments still needs it.
 */
function argsCell(entry) {
  const props = Object.entries(entry.input_schema?.properties ?? {});
  if (!props.length) return '<span class="muted dash">none</span>';

  const required = new Set(entry.input_schema?.required ?? []);
  return props
    .map(
      ([name, spec]) => `
      <label class="arg${required.has(name) ? ' required' : ''}"
             title="${esc(spec?.description ?? name)}${required.has(name) ? '' : ' (optional)'}">
        <span class="arg-name mono">${esc(name)}</span>
        <input data-arg="${esc(name)}" placeholder="${esc(spec?.type ?? 'string')}" />
      </label>`,
    )
    .join('');
}

/** Risk and replay record. Its own function because invoking updates it in place. */
const stateHtml = (entry) =>
  `<span class="badge ${esc(entry.risk_level)}">${esc(entry.risk_level)}</span>${reliabilityBadge(entry.reliability)}`;

function render(root, entries) {
  root.querySelector('tbody').innerHTML =
    entries
      .map(
        (entry) => `
      <tr data-entry="${esc(entry.id)}">
        <td class="name-cell">
          <b class="cap-name" title="${esc(entry.description)}">${esc(entry.name)}</b>
          <span class="muted cap-id mono">${esc(entry.id)}</span>
        </td>
        <td class="state-cell">
          <span class="state">${stateHtml(entry)}</span>
        </td>
        <td class="args-cell">${argsCell(entry)}</td>
        <td class="invoke-cell">
          <button class="small" data-invoke="${esc(entry.id)}">Invoke</button>
          <span class="result-line" data-result="${esc(entry.id)}"></span>
        </td>
      </tr>`,
      )
      .join('') ||
    // The explainer lives in the empty state and nowhere else: it is what a first-time
    // reader needs, and it would be noise above a table that already has rows.
    '<tr><td colspan="4" class="muted empty">Approve a capability to allow an outside AI agent to invoke it.</td></tr>';
}

/** The four-way result, said plainly. A business outcome is an answer, not a failure. */
function resultHtml(result) {
  if (result.outcome === 'SUCCESS') {
    const outputs =
      result.outputs && Object.keys(result.outputs).length ? JSON.stringify(result.outputs) : 'no outputs declared';
    return `<span class="badge SUCCESS">SUCCESS</span> <span class="mono">${esc(outputs)}</span>`;
  }
  if (result.outcome === 'BUSINESS_OUTCOME') {
    const answer = result.business_outcome?.message ?? result.business_outcome?.code ?? '';
    return `<span class="badge BUSINESS_OUTCOME">BUSINESS_OUTCOME</span> ${esc(answer)}`;
  }
  return `<span class="badge ${esc(result.outcome)}">${esc(result.outcome)}</span> ${esc(result.failure?.message ?? '')}`;
}

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/agent-catalog/agent-catalog.html')).text();

  let lastKey = '';

  const refresh = async () => {
    // Same rule as the tables beside it: nothing selected means render nothing, never all.
    const appId = selectedAppId();
    if (!hasSelection() || !appId) {
      if (lastKey === 'none') return;
      lastKey = 'none';
      render(root, []);
      return;
    }
    try {
      const entries = (await getJson('/api/catalog')).filter((e) => e.app_id === appId);
      const key = JSON.stringify([appId, entries.map((e) => [e.id, e.version, e.reliability?.runs ?? 0])]);
      if (key === lastKey) return; // don't clobber a half-typed argument while polling
      lastKey = key;
      render(root, entries);
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
  // Approving or revoking happens in the Capabilities tab, and this table is the thing
  // it visibly changes — so it must land here at once, not up to a poll later.
  window.addEventListener('capabilities-changed', refreshNow);

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-invoke]');
    if (!button) return;

    const id = button.dataset.invoke;
    const row = root.querySelector(`[data-entry="${id}"]`);
    const result = row.querySelector(`[data-result="${id}"]`);

    // Blank inputs are omitted rather than sent as "": the parameter validator should see
    // a missing required argument as missing, which is a clearer error than empty.
    const params = {};
    for (const input of row.querySelectorAll('[data-arg]')) {
      if (input.value.trim()) params[input.dataset.arg] = input.value.trim();
    }

    button.disabled = true;
    result.innerHTML = '<span class="muted">Invoking…</span>';
    try {
      const outcome = await postJson(`/api/catalog/${id}/invoke`, { params });
      result.innerHTML = resultHtml(outcome);

      // The replay record just moved, so update that one cell in place. A full re-render
      // would be simpler and wrong: it would wipe the result the caller is reading and
      // the arguments they typed to get it.
      const fresh = await getJson(`/api/catalog/${id}`).catch(() => null);
      if (fresh) row.querySelector('.state').innerHTML = stateHtml(fresh);
      lastKey = ''; // and let the next poll re-sync the rest

      window.dispatchEvent(new CustomEvent('replay-finished')); // an invocation IS a run
      window.dispatchEvent(new CustomEvent('capabilities-changed'));
    } catch (err) {
      result.innerHTML = `<span class="error">${esc(err.message)}</span>`;
    } finally {
      button.disabled = false;
    }
  });
}
