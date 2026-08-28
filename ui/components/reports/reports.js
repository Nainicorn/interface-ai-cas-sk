/**
 * Per-run report (opens in its own tab from the runs list): outcome banner, run
 * configuration, the step-by-step trail, the screenshot gallery, and — for discovery
 * runs — model token usage. Keeps polling while the run is live, then settles.
 * API: GET /api/runs/:id/report, GET /api/runs/:id/screenshots/:name.
 */

import { esc, getJson } from '/global/helpers.js';

const dt = (value) => (value ? new Date(value).toLocaleString() : '');

function configRows(report) {
  const { run, target, result } = report;
  const artifact = run.detail?.artifact ?? (run.detail?.capability ? { id: run.detail.capability, version: run.detail.version } : null);
  const persona = run.detail?.persona ?? result?.persona ?? report.events.find((e) => e.type === 'run_start')?.persona;
  // Discovery records the parameter NAMES it was given; replay records name and value,
  // already redacted. Both render as chips, so a reader sees what a run was asked for
  // without the report needing to know which kind of run it is looking at.
  const recorded = result?.params_supplied ?? report.events.find((e) => e.type === 'run_start')?.params ?? [];
  const params = Array.isArray(recorded)
    ? recorded.map((name) => String(name))
    : Object.entries(recorded).map(([name, value]) => `${name}=${value}`);
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
      `<a target="_blank" rel="noopener" href="/api/capabilities/${encodeURIComponent(artifact.id)}">${esc(artifact.id)} v${esc(artifact.version)}</a>`,
    ]);
  }
  // Which credential a run used is the difference between a hold that posts and one
  // that stops for a supervisor, so a run that swapped one says so rather than
  // reporting the app's default and leaving the outcome looking arbitrary.
  const overridden = run.detail?.secrets_overridden ?? [];
  if (overridden.length) {
    rows.push([
      'Credentials overridden',
      overridden.map((name) => `<span class="mono">${esc(name)}</span>`).join(', ') +
        ' <span class="hint">names only — values are never recorded</span>',
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

/**
 * What the run returned, as opposed to how it went.
 *
 * Exactly one of these is populated on any finished replay, and each answers a different
 * question the reader arrived with: outputs for a run that worked, the app's own words
 * for one that legitimately could not, what a person has to do for one that stopped, and
 * where it broke for one that did.
 *
 * Reads the run row rather than the result file so it works while a run is still being
 * written, and because that row is already the redacted copy — a report is a page anyone
 * with the link can open, and it has no business showing a value evidence itself refuses
 * to keep.
 */
function resultRows(run) {
  const detail = run.detail ?? {};
  const rows = [];

  for (const [name, value] of Object.entries(detail.outputs ?? {})) {
    rows.push([esc(name), `<span class="mono">${esc(String(value))}</span>`]);
  }

  const answer = detail.business_outcome;
  if (answer) {
    rows.push(['Outcome', `<span class="badge BUSINESS_OUTCOME">${esc(answer.code)}</span>`]);
    rows.push(['Meaning', esc(answer.message ?? '—')]);
    if (answer.detail) rows.push(['The app said', `<span class="mono">${esc(answer.detail)}</span>`]);
    // Shown only when the host's status is what classified the run, so a reviewer can
    // check the verdict rather than take it on trust.
    if (answer.http_status) rows.push(['Classified on', `<span class="mono">HTTP ${esc(answer.http_status)}</span>`]);
  }

  const handover = detail.escalation;
  if (handover) {
    rows.push(['Escalated', `<span class="badge ESCALATED">${esc(handover.code)}</span>`]);
    rows.push(['Needs', esc(handover.message ?? '—')]);
    if (handover.http_status) rows.push(['Classified on', `<span class="mono">HTTP ${esc(handover.http_status)}</span>`]);
    rows.push(['Stopped at', `step ${esc(handover.step)} — ${esc(handover.intent ?? '')}`]);
    if (handover.url) rows.push(['On page', `<span class="mono">${esc(handover.url)}</span>`]);
  }

  const broke = detail.failed_step;
  if (broke) {
    rows.push(['Failed at', `step ${esc(broke.step)} — ${esc(broke.intent ?? '')}`]);
    rows.push(['Because', esc(broke.message ?? '—')]);
    if (broke.url) rows.push(['On page', `<span class="mono">${esc(broke.url)}</span>`]);
  }

  return rows;
}

function render(root, runId, report) {
  const { run, result } = report;
  const outcome = run.status;
  root.querySelector('[data-outcome]').className = `badge big ${esc(outcome)}`;
  root.querySelector('[data-outcome]').textContent = outcome;
  root.querySelector('[data-run-id]').textContent = runId;
  // A replay is headlined by the capability that ran; its description is a paragraph
  // and already sits in the Goal row below. A discovery has only its goal.
  root.querySelector('[data-headline]').innerHTML = esc(run.detail?.capability ?? run.goal ?? '');
  root.querySelector('[data-when]').textContent = `${dt(run.created_at)}${run.updated_at ? ` → ${dt(run.updated_at)}` : ''}`;

  root.querySelector('[data-config]').innerHTML = configRows(report)
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');

  const outcomeRows = resultRows(run);
  root.querySelector('[data-result-card]').hidden = outcomeRows.length === 0;
  root.querySelector('[data-result]').innerHTML = outcomeRows
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
  root.innerHTML = await (await fetch('/components/reports/reports.html')).text();

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
