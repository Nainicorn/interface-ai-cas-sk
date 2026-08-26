/**
 * Turn a recorded capability into a standalone, runnable Playwright script.
 *
 * Deliberately raw Playwright (chromium.launch/newPage), not @playwright/test — the
 * project depends on nothing else, so the generated file runs with `node file.js` and
 * zero new dependencies, the same shape engine/replay.js itself already uses to drive a
 * browser.
 *
 * Only the FIRST (highest-confidence) locator candidate per step is emitted. Replay's
 * ranked-candidate fallback (engine/locator.js) is what makes the RECORDING itself
 * robust to drift; a generated script is a snapshot for a human to read or hand-adapt,
 * not a second replay engine, so the remaining candidates are left as a comment instead
 * of reimplemented.
 *
 * Hands off to: api/capabilities.js (GET .../codegen), cli/generate.js.
 */

const jsonLiteral = (value) => JSON.stringify(value);

/** One candidate as a Playwright locator expression, matching engine/locator.js exactly. */
function locatorExpr(strategy) {
  const [primary, ...rest] = strategy.candidates;
  const exactOpt = primary.exact ? ', { exact: true }' : '';

  let line;
  switch (primary.kind) {
    case 'role':
      line = `page.getByRole(${jsonLiteral(primary.role)}, { name: ${jsonLiteral(primary.value)}${primary.exact ? ', exact: true' : ''} })`;
      break;
    case 'label':
      line = `page.getByLabel(${jsonLiteral(primary.value)}${exactOpt})`;
      break;
    case 'placeholder':
      line = `page.getByPlaceholder(${jsonLiteral(primary.value)}${exactOpt})`;
      break;
    case 'text':
      line = `page.getByText(${jsonLiteral(primary.value)}${exactOpt})`;
      break;
    case 'css':
      line = `page.locator(${jsonLiteral(primary.value)})`;
      break;
    default:
      line = `page.locator(${jsonLiteral(primary.value)}) /* unknown locator kind "${primary.kind}" */`;
  }

  const fallback = rest.length
    ? `fallback if this breaks: ${rest.map((c) => `${c.kind} ${JSON.stringify(c.value)}`).join(', ')}`
    : null;
  return { line, fallback };
}

/** A checkpoint Condition as a Playwright wait, matching engine/perception.js's evaluateCondition. */
function conditionExpr(condition) {
  const { type, value, timeout_ms: timeoutMs } = condition;
  switch (type) {
    case 'url_contains':
      return `await page.waitForURL((u) => u.toString().includes(${jsonLiteral(value)}), { timeout: ${timeoutMs} });`;
    case 'text_visible':
      return `await page.getByText(${jsonLiteral(value)}).first().waitFor({ state: 'visible', timeout: ${timeoutMs} });`;
    case 'text_absent':
      return `await page.getByText(${jsonLiteral(value)}).waitFor({ state: 'detached', timeout: ${timeoutMs} }).catch(() => {});`;
    case 'element_exists':
      return `await page.locator(${jsonLiteral(value)}).first().waitFor({ state: 'visible', timeout: ${timeoutMs} });`;
    default:
      return `// unknown checkpoint type "${type}"`;
  }
}

/** Where a `type` step's value comes from, matching engine/replay.js's resolveStepValue. */
function typeValueExpr(step) {
  if (step.value_from !== undefined) return `INPUTS[${jsonLiteral(step.value_from)}]`;
  if (step.value_from_env !== undefined) return `process.env[${jsonLiteral(step.value_from_env)}]`;
  if (step.value_literal !== undefined) return jsonLiteral(step.value_literal);
  return `''`;
}

/** One step, as a block of generated lines. */
function stepLines(step) {
  const lines = [`  // Step ${step.index} — ${step.intent}`];

  switch (step.action) {
    case 'navigate':
      lines.push(`  await page.goto(new URL(${jsonLiteral(step.url)}, BASE_URL).toString(), { waitUntil: 'domcontentloaded' });`);
      break;

    case 'click': {
      const { line, fallback } = locatorExpr(step.locator);
      if (fallback) lines.push(`  // ${fallback}`);
      lines.push(`  await ${line}.click();`);
      break;
    }

    case 'type': {
      const { line, fallback } = locatorExpr(step.locator);
      if (fallback) lines.push(`  // ${fallback}`);
      lines.push(`  await ${line}.fill(String(${typeValueExpr(step)} ?? ''));`);
      break;
    }

    case 'read': {
      const { line, fallback } = locatorExpr(step.locator);
      if (fallback) lines.push(`  // ${fallback}`);
      lines.push(`  {`);
      lines.push(`    const raw = (await ${line}.innerText()).trim();`);
      if (step.extract_as) {
        const pattern = step.extract_pattern ? jsonLiteral(step.extract_pattern) : 'null';
        lines.push(`    outputs[${jsonLiteral(step.extract_as)}] = extractPattern(raw, ${pattern});`);
      }
      lines.push(`  }`);
      break;
    }

    case 'wait_for':
      // The condition IS the action here — nothing else to emit or check below it.
      lines.push(`  ${conditionExpr(step.expected_outcome)}`);
      return lines;

    default:
      lines.push(`  // unknown action "${step.action}"`);
  }

  lines.push(`  ${conditionExpr(step.expected_outcome)} // checkpoint`);
  for (const rule of step.business_outcomes ?? []) {
    lines.push(`  // also valid here: business outcome "${rule.code}" — ${rule.message}`);
  }
  return lines;
}

/**
 * @param {object} capability a validated Capability
 * @returns {string} a standalone .js file, runnable with `node <file>`
 */
export function generatePlaywrightTest(capability) {
  const inputProps = Object.entries(capability.input_schema?.properties ?? {});
  const inputsLiteral = inputProps.length
    ? `{\n${inputProps.map(([name]) => `  ${jsonLiteral(name)}: 'REPLACE_ME',`).join('\n')}\n}`
    : '{}';

  const stepBlocks = capability.steps.map((step) => stepLines(step).join('\n')).join('\n\n');

  return [
    '/**',
    ` * Auto-generated from capability "${capability.id}" v${capability.version}. Do not hand-edit —`,
    ` * regenerate with: npm run generate -- --id ${capability.id}`,
    ' *',
    ` * ${capability.description}`,
    ' *',
    ' * Raw Playwright, no @playwright/test — runnable standalone:',
    ` *   BASE_URL=https://your-app.example.com node ${capability.id}.spec.js`,
    ' *',
    ' * Only the highest-confidence locator per step is used here. The recorded capability',
    ' * carries a ranked fallback list per step for when a page changes slightly; replay',
    ' * (src/engine/replay.js) is what actually walks that list. This file is a snapshot',
    ' * for a human to read or hand-adapt, not a second replay engine.',
    ' */',
    '',
    "import { chromium } from 'playwright';",
    '',
    "const BASE_URL = process.env.BASE_URL ?? '';",
    `const INPUTS = ${inputsLiteral};`,
    '',
    'function extractPattern(raw, pattern) {',
    '  if (!pattern) return raw;',
    '  const match = new RegExp(pattern).exec(raw);',
    '  return match ? (match[1] ?? match[0]) : null;',
    '}',
    '',
    'async function main() {',
    '  if (!BASE_URL) throw new Error("Set the BASE_URL env var to the target app\'s origin.");',
    '',
    "  const browser = await chromium.launch({ headless: process.env.HEADED ? false : true });",
    '  const page = await browser.newPage();',
    '  const outputs = {};',
    '',
    '  try {',
    stepBlocks,
    '',
    `    ${conditionExpr(capability.success_checkpoint)} // overall goal checkpoint`,
    '  } finally {',
    '    await browser.close();',
    '  }',
    '',
    "  console.log('Outputs:', outputs);",
    '}',
    '',
    'main().catch((err) => {',
    '  console.error(err);',
    '  process.exit(1);',
    '});',
    '',
  ].join('\n');
}
