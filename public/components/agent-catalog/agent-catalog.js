/**
 * Agent catalog tab: the agent-facing surface, rendered as an agent would receive it.
 *
 * Reads /api/capabilities — a strictly narrower view than the Capabilities tab beside it,
 * because that one is the operator's and shows drafts. Approving a capability there makes
 * it appear here; demoting it makes it vanish. That visible move is the point of the tab.
 *
 * Each row carries the declared arguments as inputs and an Invoke button that POSTs to
 * /api/capabilities/:id/invoke, so this is not a description of the agent path — it is
 * the agent path, driven by hand.
 *
 * API: GET /api/capabilities, POST /api/capabilities/:id/invoke.
 */

import { hasSelection, onSelectedApp, selectedAppId } from '/global/selected-app.js';
import { esc, getJson, postJson } from '/global/ui.js';

/** One input per declared parameter — the recorded contract IS the form. */
function argsCell(entry) {
  const props = Object.entries(entry.input_schema?.properties ?? {});
  if (!props.length) return '<span class="muted dash">none</span>';

  const required = new Set(entry.input_schema?.required ?? []);
  return props
    .map(
      ([name, spec]) => `
      <label class="arg">
        <span class="arg-name mono">${esc(name)}${required.has(name) ? '' : ' · optional'}</span>
        <input data-arg="${esc(name)}" placeholder="${esc(spec?.description ?? spec?.type ?? 'string')}"
               title="${esc(spec?.description ?? name)}" />
      </label>`,
    )
    .join('');
}

/** Rolling reliability, written back by every invocation. */
function reliabilityText(entry) {
  const { runs = 0, successes = 0 } = entry.reliability ?? {};
  return runs ? `${successes}/${runs} replays ok` : 'no replays yet';
}

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
          <span class="state">
            <span class="badge ${esc(entry.risk_level)}">${esc(entry.risk_level)}</span>
            <span class="muted replays">${esc(reliabilityText(entry))}</span>
          </span>
        </td>
        <td class="args-cell">${argsCell(entry)}</td>
        <td class="invoke-cell">
          <button class="small" data-invoke="${esc(entry.id)}">Invoke</button>
          <span class="result-line" data-result="${esc(entry.id)}"></span>
        </td>
      </tr>`,
      )
      .join('') ||
    `<tr><td colspan="4" class="muted empty">
       Nothing here yet. Recordings start as drafts and stay invisible to agents until a
       human approves one, in the Capabilities tab.
     </td></tr>`;
}

/** The four-way result, said plainly. A business outcome is an answer, not a failure. */
function resultHtml(result) {
  if (result.outcome === 'SUCCESS') {
    const outputs = result.outputs && Object.keys(result.outputs).length ? JSON.stringify(result.outputs) : 'no outputs declared';
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
      const entries = (await getJson('/api/capabilities')).filter((e) => e.app_id === appId);
      const key = JSON.stringify([appId, entries.map((e) => [e.id, e.version, e.reliability?.runs ?? 0])]);
      if (key === lastKey) return; // don't clobber a half-typed argument while polling
      lastKey = key;
      render(root, entries);
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
      const outcome = await postJson(`/api/capabilities/${id}/invoke`, { params });
      result.innerHTML = resultHtml(outcome);
      window.dispatchEvent(new CustomEvent('replay-finished'));
      lastKey = ''; // the reliability counter just moved
    } catch (err) {
      result.innerHTML = `<span class="error">${esc(err.message)}</span>`;
    } finally {
      button.disabled = false;
    }
  });
}
