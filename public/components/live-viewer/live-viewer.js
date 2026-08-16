/**
 * Live viewer: what the run's Chromium is looking at, refreshed every 2s.
 * Sits top-right. Quiet empty state when idle; fills with the live screenshot
 * while a run is active and empties again when the run finishes.
 * Shows only the SELECTED app's live run — another app's browser under this app's
 * heading would be a lie about what you are watching.
 * A Stop button ends the run — it closes the browser and releases any pending pause.
 * API: GET /api/runs, GET /api/runs/:id/screenshot, POST /api/runs/:id/stop.
 */

import { onSelectedApp, selectedAppId } from '/lib/selected-app.js';

const fetchRuns = () => fetch('/api/runs').then((r) => r.json());

export async function mount(root) {
  root.classList.add('idle');
  root.innerHTML = await (await fetch('/components/live-viewer/live-viewer.html')).text();

  const meta = root.querySelector('.meta');
  const stopButton = root.querySelector('[data-stop]');
  const img = root.querySelector('img');
  let liveId = null;
  img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  img.addEventListener('load', () => { img.style.visibility = 'visible'; });

  const refresh = async () => {
    try {
      const appId = selectedAppId();
      const live = appId ? (await fetchRuns()).find((r) => r.live && r.app_id === appId) : null;
      root.classList.toggle('idle', !live);
      stopButton.hidden = !live;
      liveId = live?.id ?? null;
      if (!live) return;
      meta.innerHTML = `
        <span class="badge ${live.status}">${live.status}</span>
        <span class="badge">${live.owner === 'agent' ? 'agent driving' : live.owner === 'human' ? 'human driving' : 'awaiting operator'}</span>
        <span class="mono muted">${live.id}</span>`;
      img.src = `/api/runs/${encodeURIComponent(live.id)}/screenshot?t=${Date.now()}`;
    } catch {
      /* transient poll failure — next tick retries */
    }
  };
  stopButton.addEventListener('click', async () => {
    if (!liveId || !confirm('Stop this run? Its browser closes and the run is marked stopped.')) return;
    stopButton.disabled = true;
    try {
      await fetch(`/api/runs/${encodeURIComponent(liveId)}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Stopped from the console' }),
      });
      await refresh();
    } finally {
      stopButton.disabled = false;
    }
  });

  refresh();
  setInterval(refresh, 2000);
  onSelectedApp(refresh);
  window.addEventListener('run-started', refresh);
}
