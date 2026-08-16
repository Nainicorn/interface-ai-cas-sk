/**
 * Agent catalog tab: the agent-facing surface, rendered as an agent would receive it.
 *
 * Reads /api/capabilities — a strictly narrower view than the Capabilities tab beside it,
 * because that one is the operator's and shows drafts. Approving a capability there makes
 * it appear here; demoting it makes it vanish. That visible move is the point of the tab.
 *
 * Each entry carries a typed-argument form and an Invoke button that POSTs to
 * /api/capabilities/:id/invoke, so the catalog is not a description of the agent path —
 * it is the agent path, driven by hand.
 *
 * API: GET /api/capabilities, POST /api/capabilities/:id/invoke.
 */

import { hasSelection, onSelectedApp, selectedAppId } from '/global/selected-app.js';

const fetchCatalog = () => fetch('/api/capabilities').then((r) => r.json());

/** Goals, descriptions, and error strings are user text; never interpolate them raw. */
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`);

async function invoke(id, params) {
  const res = await fetch(`/api/capabilities/${id}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

/** One input per declared parameter — the contract is the form. */
function argsForm(entry) {
  const props = Object.entries(entry.input_schema?.properties ?? {});
  if (!props.length) return '<p class="muted no-args">Takes no arguments.</p>';

  const required = new Set(entry.input_schema?.required ?? []);
  return props
    .map(
      ([name, spec]) => `
      <label class="arg">
        <span class="arg-name mono">${esc(name)}${required.has(name) ? '' : '<span class="muted"> optional</span>'}</span>
        <input data-arg="${esc(name)}" placeholder="${esc(spec?.description ?? spec?.type ?? 'string')}" />
      </label>`,
    )
    .join('');
}

function render(root, entries) {
  const host = root.querySelector('.catalog-entries');
  if (!entries.length) {
    host.innerHTML = `
      <p class="empty muted">
        Nothing here yet. Recordings start as <b>drafts</b> and stay invisible to agents
        until a human approves one — use <b>Approve</b> in the Capabilities tab.
      </p>`;
    return;
  }

  host.innerHTML = entries
    .map((entry) => {
      const { runs, successes } = entry.reliability ?? { runs: 0, successes: 0 };
      return `
      <article class="entry" data-entry="${esc(entry.id)}">
        <header>
          <b class="mono">${esc(entry.id)}</b>
          <span class="badge ${esc(entry.risk_level)}">${esc(entry.risk_level)}</span>
          <span class="muted">v${esc(entry.version)}</span>
          <span class="muted reliability">${runs ? `${successes}/${runs} replays ok` : 'no replays yet'}</span>
        </header>
        <p class="lede">${esc(entry.description)}</p>
        <div class="args">${argsForm(entry)}</div>
        <div class="invoke-row">
          <button class="small" data-invoke="${esc(entry.id)}">Invoke</button>
          <span class="result-line" data-result="${esc(entry.id)}"></span>
        </div>
      </article>`;
    })
    .join('');
}

/** The four-way result, said plainly. A business outcome is an answer, not a failure. */
function resultHtml(result) {
  if (result.outcome === 'SUCCESS') {
    const outputs = result.outputs && Object.keys(result.outputs).length ? JSON.stringify(result.outputs) : 'no outputs declared';
    return `<span class="ok">SUCCESS</span> <span class="mono">${esc(outputs)}</span>`;
  }
  if (result.outcome === 'BUSINESS_OUTCOME') {
    return `<span class="badge BUSINESS_OUTCOME">BUSINESS_OUTCOME</span> ${esc(result.business_outcome?.message ?? result.business_outcome?.code ?? '')}`;
  }
  return `<span class="error">${esc(result.outcome)}</span> ${esc(result.failure?.message ?? '')}`;
}

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/agent-catalog/agent-catalog.html')).text();

  let lastKey = '';

  const refresh = async () => {
    const appId = selectedAppId();
    if (!hasSelection() || !appId) {
      if (lastKey === 'none') return;
      lastKey = 'none';
      render(root, []);
      return;
    }
    try {
      const entries = (await fetchCatalog()).filter((e) => e.app_id === appId);
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
    const entry = root.querySelector(`[data-entry="${id}"]`);
    const result = entry.querySelector(`[data-result="${id}"]`);

    // Blank inputs are omitted rather than sent as "": the parameter validator should
    // see a missing required argument as missing, which is a clearer error than empty.
    const params = {};
    for (const input of entry.querySelectorAll('[data-arg]')) {
      if (input.value.trim()) params[input.dataset.arg] = input.value.trim();
    }

    button.disabled = true;
    result.innerHTML = '<span class="muted">Invoking…</span>';
    try {
      const outcome = await invoke(id, params);
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
