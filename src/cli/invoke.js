/**
 * CLI demo of the agent-facing surface: discover the catalog, then invoke a capability
 * by name with typed args — over HTTP, exactly as an external AI agent would. This is
 * deliberately NOT a shortcut into the engine: it exercises the same endpoint an agent
 * integration would call, approval gate included.
 *
 *   npm run invoke                                          # list the catalog
 *   npm run invoke -- --id lookup-member-savings-account --param member_id=10001
 *
 * Flags: --id <capability>, --param k=v (repeatable), --version N, --base-url <url>.
 * No hostname lives in this file — the boundary tests forbid it, so the local default
 * (http://localhost:3000) is supplied by the npm script, which is configuration.
 *
 * Requires the control plane running (npm start). Exit codes mirror replay: 0 for
 * SUCCESS and BUSINESS_OUTCOME (both are answers), 1 for HARD_FAILURE or a refusal.
 */

function parseArgs(argv) {
  const args = { params: {} };
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
      case '--base-url':
        args.baseUrl = argv[++i];
        break;
      default:
        throw new Error(`Unknown flag "${argv[i]}"`);
    }
  }
  if (!args.baseUrl) {
    throw new Error('--base-url is required (use "npm run invoke", which supplies the local default)');
  }
  return args;
}

async function getJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error(`Could not reach the control plane at ${url} — is it running? (npm start)`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  return body;
}

try {
  const args = parseArgs(process.argv.slice(2));

  if (!args.id) {
    // No --id: the discovery half of the story. Print the catalog as an agent sees it.
    const catalog = await getJson(`${args.baseUrl}/api/capabilities`);
    if (catalog.length === 0) {
      console.log('Catalog is empty — no capability has been approved yet.');
      console.log('A human approves one via the console, or: PATCH /api/artifacts/<id>/status {"status":"approved"}');
      process.exit(0);
    }
    console.log(`${catalog.length} agent-invocable capabilit${catalog.length === 1 ? 'y' : 'ies'}:\n`);
    for (const entry of catalog) {
      const inputs = Object.keys(entry.input_schema?.properties ?? {}).join(', ') || '—';
      const outputs = Object.keys(entry.output_schema?.properties ?? {}).join(', ') || '—';
      const conf = entry.confidence?.runs
        ? `${entry.confidence.successes}/${entry.confidence.runs} replays ok`
        : 'no replays yet';
      console.log(`  ${entry.name} (v${entry.version}, ${entry.risk_level}, ${conf})`);
      console.log(`    ${entry.description}`);
      console.log(`    args: ${inputs}  →  returns: ${outputs}\n`);
    }
    process.exit(0);
  }

  console.log(`Invoking ${args.id} via the agent-facing surface…`);
  const result = await getJson(`${args.baseUrl}/api/capabilities/${args.id}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params: args.params, ...(args.version ? { version: args.version } : {}) }),
  });

  console.log(`\nOutcome:  ${result.outcome}`);
  if (result.outputs && Object.keys(result.outputs).length) console.log(`Outputs:  ${JSON.stringify(result.outputs)}`);
  if (result.business_outcome) console.log(`Business: ${JSON.stringify(result.business_outcome)}`);
  if (result.failure) console.log(`Failure:  ${JSON.stringify(result.failure, null, 2)}`);
  console.log(`Run:      ${result.run_id}`);

  process.exit(result.outcome === 'HARD_FAILURE' ? 1 : 0);
} catch (err) {
  console.error(`invoke: ${err.message}`);
  process.exit(1);
}
