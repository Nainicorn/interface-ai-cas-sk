/**
 * CLI entry for a multi-run stability check — replay a capability N times in a row and
 * report how many held. Same replay path as `npm run replay`, just looped and totalled.
 *
 *   npm run stability -- --id lookup-member-savings-account --runs 5 --param member_id=10001
 *
 * Flags: --id (required), --runs (default 5), --param k=v (repeatable), --version N,
 *        --headed (watch it)
 *
 * Exit codes: 0 if at least one run held, 1 if every run was a HARD_FAILURE.
 */

import { runStabilityCheck } from '../api/stability.js';
import { loadCapability } from '../schema/store.js';

function parseArgs(argv) {
  const args = { params: {}, headless: true, runs: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--id':
        args.id = argv[++i];
        break;
      case '--runs':
        args.runs = Number(argv[++i]);
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
      default:
        throw new Error(`Unknown flag "${argv[i]}"`);
    }
  }
  if (!args.id) throw new Error('Required: --id <capability id> [--runs N] [--param name=value]…');
  return args;
}

// Minimal ANSI, no dependency: colors degrade to plain text on a terminal that ignores them.
const color = (code, text) => `\x1b[${code}m${text}\x1b[0m`;
const OUTCOME_STYLE = {
  SUCCESS: { mark: '✓', code: '32' }, // green
  BUSINESS_OUTCOME: { mark: '◆', code: '34' }, // blue
  RECOVERABLE: { mark: '✓', code: '33' }, // yellow
  HARD_FAILURE: { mark: '✗', code: '31' }, // red
};

try {
  const args = parseArgs(process.argv.slice(2));
  const capability = await loadCapability(args.id, args.version);
  console.log(`Stability check: ${capability.id} v${capability.version} × ${args.runs} (no LLM)\n`);

  const summary = await runStabilityCheck(capability, args.params, { runs: args.runs, headless: args.headless });

  summary.results.forEach((r, i) => {
    const style = OUTCOME_STYLE[r.outcome] ?? { mark: '?', code: '0' };
    const label = `run ${String(i + 1).padStart(String(summary.runs).length)}/${summary.runs}`;
    console.log(`  ${label}  ${color(style.code, `${style.mark} ${r.outcome}`)}`);
  });

  const pctColor = summary.stability_pct === 100 ? '32' : summary.stability_pct === 0 ? '31' : '33';
  console.log(`\n${color(pctColor, `${summary.stability_pct}% held`)}  (${summary.held}/${summary.runs})`);

  const breakdownLine = Object.entries(summary.breakdown)
    .filter(([, n]) => n > 0)
    .map(([outcome, n]) => color(OUTCOME_STYLE[outcome]?.code ?? '0', `${outcome} ${n}`))
    .join('  ·  ');
  console.log(breakdownLine);

  process.exit(summary.held > 0 ? 0 : 1);
} catch (err) {
  console.error(`stability: ${err.message}`);
  process.exit(1);
}
