/**
 * Workspace tabs: one card, two views — Runs and Capabilities.
 * Owns nothing but the switch; each tab's content is its own component.
 */

import { mount as runStatus } from '/components/run-status.js';
import { mount as capabilityTable } from '/components/capability-table.js';

export function mount(root) {
  root.innerHTML = `
    <div class="tabbar">
      <button data-tab="runs" class="active">Runs</button>
      <button data-tab="caps">Capabilities</button>
    </div>
    <div data-pane="runs"></div>
    <div data-pane="caps" hidden></div>
  `;

  runStatus(root.querySelector('[data-pane=runs]'));
  capabilityTable(root.querySelector('[data-pane=caps]'));

  root.querySelector('.tabbar').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (!button) return;
    for (const b of root.querySelectorAll('.tabbar button')) b.classList.toggle('active', b === button);
    for (const pane of root.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== button.dataset.tab;
  });
}
