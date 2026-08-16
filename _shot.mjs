import { chromium } from 'playwright';
const dir = '/private/tmp/claude-501/-Users-nainicorn-Documents-interface-ai-cas-sk/28c6e999-3ba7-4eba-b995-3c9651d96a7c/scratchpad';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 760 } });
await p.goto('http://localhost:3000');
await p.waitForTimeout(1200);
// An app with runs, to prove the explainer is absent when rows exist.
await p.locator('#app-sidebar li, #app-sidebar [data-app-id]').first().click();
await p.waitForTimeout(1200);
for (const tab of ['caps', 'catalog']) {
  await p.click(`[data-tab=${tab}]`);
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${dir}/filled-${tab}.png` });
}
// An app with nothing recorded, to see all three empty states.
const apps = p.locator('#app-sidebar li, #app-sidebar [data-app-id]');
await apps.nth(await apps.count() - 1).click();
await p.waitForTimeout(1200);
for (const tab of ['runs', 'caps', 'catalog']) {
  await p.click(`[data-tab=${tab}]`);
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${dir}/empty-${tab}.png` });
}
await b.close();
