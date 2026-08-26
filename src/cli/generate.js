/**
 * CLI entry for code generation — turn a recorded capability into a standalone
 * Playwright script, for a human to read or hand-adapt outside this system.
 *
 *   npm run generate -- --id add-remove-elements-cycle
 *   npm run generate -- --id add-remove-elements-cycle --out ./add-remove-elements-cycle.spec.js
 *
 * Flags: --id (required), --version N (latest if omitted), --out <path> (stdout if omitted)
 */

import { writeFileSync } from 'node:fs';
import { generatePlaywrightTest } from '../agent/codegen.js';
import { loadCapability } from '../schema/store.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--id':
        args.id = argv[++i];
        break;
      case '--version':
        args.version = Number(argv[++i]);
        break;
      case '--out':
        args.out = argv[++i];
        break;
      default:
        throw new Error(`Unknown flag "${argv[i]}"`);
    }
  }
  if (!args.id) throw new Error('Required: --id <capability id> [--out <path>]');
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const capability = await loadCapability(args.id, args.version);
  const code = generatePlaywrightTest(capability);

  if (args.out) {
    writeFileSync(args.out, code, 'utf8');
    console.log(`\x1b[32mWrote ${args.out}\x1b[0m  (${code.split('\n').length} lines, ${capability.steps.length} steps)`);
    console.log(`Run it with:  BASE_URL=<target origin> node ${args.out}`);
  } else {
    process.stdout.write(code);
  }
} catch (err) {
  console.error(`generate: ${err.message}`);
  process.exit(1);
}
