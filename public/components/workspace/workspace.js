/**
 * Workspace: one card, three tabs — the run history, the recorded capabilities, and the
 * catalog an agent sees. The last two read the same recordings through different
 * surfaces on purpose: the operator's shows drafts and can approve them, the agent's
 * shows only what a human has already approved.
 *
 * Mounts run-list, capability-table, and agent-catalog into its panes; the panes keep
 * their ids so each component's own CSS keeps applying.
 * API: none of its own — the panes poll their endpoints.
 */

import { mount as agentCatalog } from '/components/agent-catalog/agent-catalog.js';
import { mount as capabilityTable } from '/components/capability-table/capability-table.js';
import { mount as runList } from '/components/run-list/run-list.js';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/workspace/workspace.html')).text();

  runList(root.querySelector('[data-pane=runs]'));
  capabilityTable(root.querySelector('[data-pane=caps]'));
  agentCatalog(root.querySelector('[data-pane=catalog]'));

  root.querySelector('.tabbar').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (!tab) return;
    for (const button of root.querySelectorAll('[data-tab]')) button.classList.toggle('active', button === tab);
    for (const pane of root.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
    // One sentence per tab, swapped with it: three tabs of tables need saying what
    // each one IS, and saying it once at the top beats a tooltip nobody opens.
    for (const lede of root.querySelectorAll('[data-lede]')) lede.hidden = lede.dataset.lede !== tab.dataset.tab;
  });
}
