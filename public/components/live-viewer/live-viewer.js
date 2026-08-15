/**
 * Live viewer: what the run's Chromium is looking at, refreshed every 2s.
 * Sits top-right. Quiet empty state when idle; fills with the live screenshot
 * while a run is active and empties again when the run finishes.
 * API: GET /api/runs (find the live one), GET /api/runs/:id/screenshot.
 */

const fetchRuns = () => fetch('/api/runs').then((r) => r.json());

export async function mount(root) {
  root.classList.add('idle');
  root.innerHTML = await (await fetch('/components/live-viewer/live-viewer.html')).text();

  const meta = root.querySelector('.meta');
  const img = root.querySelector('img');
  img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  img.addEventListener('load', () => { img.style.visibility = 'visible'; });

  const refresh = async () => {
    try {
      const live = (await fetchRuns()).find((r) => r.live);
      root.classList.toggle('idle', !live);
      if (!live) return;
      meta.innerHTML = `
        <span class="badge ${live.status}">${live.status}</span>
        <span class="badge">${live.owner === 'agent' ? 'agent driving' : live.owner === 'human' ? 'human driving' : 'awaiting operator'}</span>
        <span class="mono muted">${live.id}</span>`;
      img.src = `/api/runs/${live.id}/screenshot?t=${Date.now()}`;
    } catch {
      /* transient poll failure — next tick retries */
    }
  };
  refresh();
  setInterval(refresh, 2000);
  window.addEventListener('run-started', refresh);
}
