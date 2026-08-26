/**
 * CLI entry for route canonicalization — suggest reusable patterns behind a capability's
 * recorded routes. A suggestion only; nothing here rewrites the recording.
 *
 *   npm run canonicalize -- --id add-remove-elements-cycle
 */

import { suggestCapabilityPatterns } from '../schema/canonicalize.js';
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
      default:
        throw new Error(`Unknown flag "${argv[i]}"`);
    }
  }
  if (!args.id) throw new Error('Required: --id <capability id>');
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const capability = await loadCapability(args.id, args.version);
  const suggestions = suggestCapabilityPatterns(capability);

  if (!suggestions.length) {
    console.log(`${capability.id}: no route looks tenant-specific — already as canonical as it gets.`);
    process.exit(0);
  }

  console.log(`${capability.id} v${capability.version} — suggested route patterns:\n`);
  for (const { source, route, pattern } of suggestions) {
    console.log(`  ${source.padEnd(10)}  \x1b[2m${route}\x1b[0m  →  \x1b[36m${pattern}\x1b[0m`);
  }
  console.log('\nSuggestions only — nothing was changed.');
} catch (err) {
  console.error(`canonicalize: ${err.message}`);
  process.exit(1);
}
