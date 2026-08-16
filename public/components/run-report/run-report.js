/**
 * Per-run report (opens in its own tab from the runs list): outcome banner, run
 * configuration, the step-by-step trail, the screenshot gallery, and — for discovery
 * runs — model token usage. Keeps polling while the run is live, then settles.
 * API: GET /api/runs/:id/report, GET /api/runs/:id/screenshots/:name.
 */

import { esc, getJson } from '/ui.js';

const dt = (value) => (value ? new Date(value).toLocaleString() : '');

function configRows(report) {
  const { run, target, result } = report;
  const artifact = run.detail?.artifact ?? (run.detail?.capability ? { id: run.detail.capability, version: run.detail.version } : null);
  const persona = run.detail?.persona ?? result?.persona ?? report.events.find((e) => e.type === 'run_start')?.persona;
  const params = result?.params_supplied ?? report.events.find((e) => e.type === 'run_start')?.params ?? [];
  const rows = [
    ['App', target ? `${esc(target.display_name)} <span class="mono muted">${esc(target.base_url)}</span>` : esc(run.app_id ?? '—')],
    ['Kind', esc(run.kind)],
    ['Goal', esc(run.goal ?? target?.goal ?? '—')],
    ['Login (persona)', esc(persona ?? 'environment default')],
    ['Parameters', params.length ? params.map((p) => `<span class="mono">${esc(p)}</span>`).join(', ') : '—'],
  ];
  if (artifact) {
    rows.push([
      'Capability',
      `<a target="_blank" rel="noopener" href="/api/artifacts/${encodeURIComponent(artifact.id)}">${esc(artifact.id)} v${esc(artifact.version)}</a>`,
    ]);
  }
  if (result?.model) rows.push(['Model', `<span class="mono">${esc(result.model)}</span>`]);
  if (result?.duration_ms) rows.push(['Duration', `${esc(result.duration_ms)} ms`]);
  return rows;
}

/** One table row per thing that happened, whichever kind of run this was. */
function stepRows(report) {
  const { run, result, events } = report;

  if (run.kind === 'replay' && result?.steps?.length) {
    return result.steps.map(
      (s) => `
        <tr>
          <td class="mono">${esc(s.index)}</td>
          <td>replay</td>
          <td class="mono">${esc(s.action)}</td>
          <td>${esc(s.intent ?? '')}${s.extracted_to ? ` <span class="muted mono">→ ${esc(s.extracted_to)}</span>` : ''}</td>
          <td><span class="badge ${esc(s.outcome)}">${esc(s.outcome)}</span> <span class="muted">${esc(s.duration_ms ?? '')} ms</span></td>
        </tr>`,
    );
  }

  const interesting = new Set(['action', 'risk_refusal', 'escalation', 'paused', 'resumed', 'artifact_recorded']);
  let n = 0;
  return events
    .filter((e) => interesting.has(e.type))
    .map((e) => {
      n += 1;
      if (e.type !== 'action') {
        return `
          <tr>
            <td class="mono">${n}</td>
            <td colspan="3"><span class="badge ${esc(e.type)}">${esc(e.type)}</span> ${esc(e.reason ?? e.note ?? e.id ?? '')}</td>
            <td></td>
          </tr>`;
      }
      const what = e.detail?.description ?? e.detail?.url ?? e.detail?.condition?.type ?? '';
      return `
        <tr>
          <td class="mono">${n}</td>
          <td>${esc(e.actor ?? '')}</td>
          <td class="mono">${esc(e.action ?? '')}</td>
          <td>${esc(what)}${e.landedOn ? ` <span class="muted mono">${esc(e.landedOn)}</span>` : ''}</td>
          <td>${esc(e.result ?? '')}</td>
        </tr>`;
    });
}

function render(root, runId, report) {
  const { run, result } = report;
  const outcome = run.status;
  root.querySelector('[data-outcome]').className = `badge big ${esc(outcome)}`;
  root.querySelector('[data-outcome]').textContent = outcome;
  root.querySelector('[data-run-id]').textContent = runId;
  root.querySelector('[data-headline]').innerHTML = esc(run.goal ?? run.detail?.capability ?? '');
  root.querySelector('[data-when]').textContent = `${dt(run.created_at)}${run.updated_at ? ` → ${dt(run.updated_at)}` : ''}`;

  root.querySelector('[data-config]').innerHTML = configRows(report)
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');

  const rows = stepRows(report);
  root.querySelector('[data-steps]').innerHTML =
    rows.join('') || `<tr><td colspan="5" class="muted">Nothing recorded yet.</td></tr>`;

  const gallery = root.querySelector('[data-gallery]');
  root.querySelector('[data-no-shots]').hidden = report.screenshots.length > 0;
  gallery.innerHTML = report.screenshots
    .map((name) => {
      const url = `/api/runs/${encodeURIComponent(runId)}/screenshots/${encodeURIComponent(name)}`;
      return `
        <a class="shot" target="_blank" rel="noopener" href="${url}">
          <img loading="lazy" src="${url}" alt="${esc(name)}" />
          <span class="mono">${esc(name)}</span>
        </a>`;
    })
    .join('');

  const usage = result?.usage;
  root.querySelector('[data-usage-card]').hidden = !usage;
  if (usage) {
    root.querySelector('[data-usage]').innerHTML = Object.entries(usage)
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`)
      .join('');
  }
}

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/run-report/run-report.html')).text();

  const status = root.querySelector('[data-status]');
  const runId = new URLSearchParams(location.search).get('run');
  if (!runId) {
    status.textContent = 'No run specified — open a report from the runs list.';
    return;
  }
  document.title = `Run report — ${runId}`;

  const refresh = async () => {
    let report;
    try {
      report = await getJson(`/api/runs/${encodeURIComponent(runId)}/report`);
    } catch (err) {
      status.textContent = `Could not load report: ${err.message}`;
      return;
    }
    render(root, runId, report);
    const settled = !['running', 'paused'].includes(report.run.status);
    status.textContent = settled ? '' : 'Run in progress — this report updates live.';
    if (!settled) setTimeout(refresh, 3000);
  };
  refresh();
}
