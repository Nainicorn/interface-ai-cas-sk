/**
 * Workspace: one card, two tabs — the run history and the recorded capabilities.
 * Mounts run-list and capability-table into its panes; the panes keep their ids so
 * each component's own CSS keeps applying.
 * API: none of its own — the panes poll their endpoints.
 */

import { mount as capabilityTable } from '/components/capability-table/capability-table.js';
import { mount as runList } from '/components/run-list/run-list.js';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/workspace/workspace.html')).text();

  runList(root.querySelector('[data-pane=runs]'));
  capabilityTable(root.querySelector('[data-pane=caps]'));

  root.querySelector('.tabbar').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (!tab) return;
    for (const button of root.querySelectorAll('[data-tab]')) button.classList.toggle('active', button === tab);
    for (const pane of root.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
  });
}
