/**
 * The agent's-eye view, from a terminal.
 *
 *   npm run invoke                                    # list the catalog
 *   npm run invoke -- --id lookup-savings --param member_id=10001
 *
 * Deliberately over HTTP rather than in-process: this is the only entry point that
 * pretends to be somebody else's software. An AI agent calling this system reaches it
 * across a network boundary with no access to the store, the policy modules, or the
 * browser — so the CLI that demonstrates that path must not quietly import them.
 *
 * Flags: --id (omit to list), --param k=v (repeatable), --url (default localhost:3000)
 *
 * Exit codes: 0 for SUCCESS and BUSINESS_OUTCOME (both are answers), 1 for HARD_FAILURE
 * and for a refusal.
 */

function parseArgs(argv) {
  const args = { params: {}, base: process.env.CONTROL_PLANE_URL ?? 'http://localhost:3000' };
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
      case '--url':
        args.base = argv[++i];
        break;
      default:
        throw new Error(`Unknown flag "${argv[i]}"`);
    }
  }
  return args;
}

async function call(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new Error(`No control plane at ${new URL(url).origin} — start it with: npm start`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/** Print the catalog the way a tool list reads: what it does, what it needs. */
function printCatalog(entries) {
  if (!entries.length) {
    console.log('The catalog is empty.\n');
    console.log('Capabilities are recorded as drafts and stay invisible to agents until a');
    console.log('human approves one — in the console, or:');
    console.log("  curl -X PATCH localhost:3000/api/artifacts/<id>/status \\");
    console.log("    -H 'content-type: application/json' -d '{\"status\":\"approved\"}'");
    return;
  }

  console.log(`${entries.length} callable capabilit${entries.length === 1 ? 'y' : 'ies'}:\n`);
  for (const entry of entries) {
    const { runs, successes } = entry.reliability;
    const record = runs ? `${successes}/${runs} replays ok` : 'no replays yet';
    console.log(`  ${entry.id}  v${entry.version}  [${entry.risk_level}]  ${record}`);
    console.log(`    ${entry.description}`);

    const props = Object.entries(entry.input_schema?.properties ?? {});
    const required = new Set(entry.input_schema?.required ?? []);
    const args = props.length
      ? props.map(([n, s]) => `${n}: ${s.type ?? 'string'}${required.has(n) ? '' : '?'}`).join(', ')
      : 'none';
    console.log(`    args: ${args}\n`);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));

  if (!args.id) {
    printCatalog(await call(`${args.base}/api/capabilities`));
    process.exit(0);
  }

  console.log(`Invoking ${args.id} over HTTP…`);
  const result = await call(`${args.base}/api/capabilities/${args.id}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params: args.params }),
  });

  console.log(`\nOutcome:  ${result.outcome}`);
  if (result.outputs) console.log(`Outputs:  ${JSON.stringify(result.outputs)}`);
  if (result.business_outcome) console.log(`Business: ${JSON.stringify(result.business_outcome)}`);
  if (result.failure) console.log(`Failure:  ${JSON.stringify(result.failure, null, 2)}`);
  console.log(`Run:      ${result.run_id}`);

  process.exit(result.outcome === 'HARD_FAILURE' ? 1 : 0);
} catch (err) {
  console.error(`invoke: ${err.message}`);
  process.exit(1);
}
