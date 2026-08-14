/**
 * CLI entry for deterministic replay — the production path, no LLM anywhere.
 *
 *   npm run replay -- --id lookup-member-savings-account --param member_id=10001
 *
 * Flags: --id (required), --param k=v (repeatable), --version N (latest if omitted),
 *        --headed (watch it), --run-id <id>
 *
 * Exit codes: 0 for SUCCESS and BUSINESS_OUTCOME (both are answers), 1 for HARD_FAILURE.
 */

import { replayCapability } from '../engine/replay.js';
import { loadCapability } from '../schema/store.js';
import { createRun, updateRun } from '../db/sqlite.js';
import { RunLogger, newRunId } from '../evidence/logger.js';

function parseArgs(argv) {
  const args = { params: {}, headless: true };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--id':
        args.id = argv[++i];
        break;
      case '--param': {
        const pair = argv[++i] ?? '';
        const eq = pair.indexOf('=');
        if (eq < 1) throw new Error(`--param expects name=value, got "${pair}"`);
        args.params[pair.slice(0, eq)] = pair.slice(eq + 1);
        break;
      }
      case '--version':
        args.version = Number(argv[++i]);
        break;
      case '--headed':
        args.headless = false;
        break;
      case '--run-id':
        args.runId = argv[++i];
        break;
      default:
        throw new Error(`Unknown flag "${argv[i]}"`);
    }
  }
  if (!args.id) throw new Error('Required: --id <capability id> [--param name=value]…');
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const capability = await loadCapability(args.id, args.version);
  console.log(`Replaying ${capability.id} v${capability.version} (no LLM)…`);

  const runId = args.runId ?? newRunId('replay');
  createRun({ id: runId, kind: 'replay', appId: capability.target.app_id, status: 'running' });
  const logger = new RunLogger(runId);

  const result = await replayCapability({ capability, params: args.params, headless: args.headless, logger });

  logger.saveResult({ run_id: runId, capability: capability.id, version: capability.version, ...result });
  updateRun(runId, {
    status: result.outcome,
    detail: {
      capability: capability.id,
      version: capability.version,
      outcome: result.outcome,
      outputs: result.outputs && Object.keys(result.outputs).length ? result.outputs : null,
      business_outcome: result.business_outcome ?? null,
      failed_step: result.failure ? { step: result.failure.step, message: result.failure.message } : null,
    },
  });

  console.log(`\nOutcome:  ${result.outcome}`);
  if (result.outputs) console.log(`Outputs:  ${JSON.stringify(result.outputs)}`);
  if (result.business_outcome) console.log(`Business: ${JSON.stringify(result.business_outcome)}`);
  if (result.failure) console.log(`Failure:  ${JSON.stringify(result.failure, null, 2)}`);
  console.log(`Evidence: ${logger.dir}`);

  process.exit(result.outcome === 'HARD_FAILURE' ? 1 : 0);
} catch (err) {
  console.error(`replay: ${err.message}`);
  process.exit(1);
}
