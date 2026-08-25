/**
 * CLI entry for a discovery run.
 *
 *   npm run discover -- --app-id mock-bank \
 *     --goal "Look up member 10001 and read their savings account balance" \
 *     --param member_id=10001
 *
 * Flags: --app-id (required), --goal (required), --param k=v (repeatable),
 *        --max-turns N, --headless, --run-id <id>
 *
 * Exit codes: 0 recorded, 2 escalated (a handled outcome, not a crash), 1 failure.
 * Headed by default — watching Chromium do it live is the demo; pass --headless in CI.
 */

import { runDiscovery } from '../agent/discovery.js';

function parseArgs(argv) {
  const args = { params: {}, headless: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--app-id':
        args.appId = argv[++i];
        break;
      case '--goal':
        args.goal = argv[++i];
        break;
      case '--param': {
        const pair = argv[++i] ?? '';
        const eq = pair.indexOf('=');
        if (eq < 1) throw new Error(`--param expects name=value, got "${pair}"`);
        args.params[pair.slice(0, eq)] = pair.slice(eq + 1);
        break;
      }
      case '--max-turns':
        args.maxTurns = Number(argv[++i]);
        break;
      case '--headless':
        args.headless = true;
        break;
      case '--run-id':
        args.runId = argv[++i];
        break;
      default:
        throw new Error(`Unknown flag "${flag}"`);
    }
  }
  if (!args.appId || !args.goal) {
    throw new Error('Required: --app-id <folder under config/> --goal "<natural language goal>"');
  }
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Discovering: "${args.goal}" on ${args.appId}…`);

  const result = await runDiscovery(args);

  console.log(`\nStatus:   ${result.status}`);
  console.log(`Run:      ${result.runId} (${result.turns} model turns)`);
  console.log(`Evidence: ${result.evidenceDir}`);
  console.log(
    `Tokens:   in=${result.usage.input_tokens} out=${result.usage.output_tokens} ` +
      `cache_read=${result.usage.cache_read_input_tokens} cache_write=${result.usage.cache_creation_input_tokens}`,
  );
  if (result.artifact) {
    console.log(`Artifact: ${result.artifact.id} v${result.artifact.version} → ${result.artifact.path}`);
  }
  if (result.escalation) {
    console.log(`Escalated: ${result.escalation.reason}`);
  }

  process.exit(result.status === 'recorded' ? 0 : result.status === 'escalated' ? 2 : 1);
} catch (err) {
  console.error(`discover: ${err.message}`);
  process.exit(1);
}
