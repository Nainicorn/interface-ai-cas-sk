/**
 * Workspace: one card, three tabs — the run history, the recorded capabilities, and the
 * catalog an agent sees. The last two read the same recordings through different
 * surfaces on purpose: the operator's shows drafts and can approve them, the agent's
 * shows only what a human has already approved.
 *
 * Each pane says what it is in its own empty state rather than in a standing line here,
 * so the explanation appears exactly when a reader has nothing else to go on.
 *
 * Mounts discoveries, capabilities, and agent-catalog into its panes; the panes keep
 * their ids so each component's own CSS keeps applying.
 * API: none of its own — the panes poll their endpoints.
 */

import { mount as agentCatalog } from '/components/agent-catalog/agent-catalog.js';
import { mount as capabilities } from '/components/capabilities/capabilities.js';
import { mount as discoveries } from '/components/discoveries/discoveries.js';

export async function mount(root) {
  root.innerHTML = await (await fetch('/components/tabs/tabs.html')).text();

  discoveries(root.querySelector('[data-pane=runs]'));
  capabilities(root.querySelector('[data-pane=caps]'));
  agentCatalog(root.querySelector('[data-pane=catalog]'));

  root.querySelector('.tabbar').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (!tab) return;
    for (const button of root.querySelectorAll('[data-tab]')) button.classList.toggle('active', button === tab);
    for (const pane of root.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
  });
}
