# Computer-Use Automation System

An LLM drives a legacy web application once to work out how a task is done. That run is
recorded as a **typed, versioned capability**. From then on, an AI agent invokes the
capability through deterministic replay — no model in the decision loop, at a fraction of
the cost, with a result contract that distinguishes *"no such member"* from *"something
broke"*. When either path gets stuck, a human takes over the **same live browser session**
and hands control back.

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is
> how a production agent invokes it.

---

## Setup

Requires **Node 20.12+** (developed on 26).

```bash
npm install
npx playwright install chromium
cp .env.example .env      # then add your ANTHROPIC_API_KEY
npm start                 # control plane + console on port 3000
```

No target application ships with this repo — you point the system at **your own** web app
and record against it live. Use a sandbox or demo application you are permitted to
automate, and never real credentials or real PII (this is the assignment's ground rule and
ours).

**Running without live services:** replay and the console need no LLM key —
`ANTHROPIC_API_KEY` is used only by discovery. Schema, policy, and boundary tests run with
nothing else up.

---

## 1. Register your application

In the console sidebar, hit **+ Add app**: friendly name, URL, and optionally saved
goals (named tests), allowed paths, and one or more logins. That's the whole form. Each
app row's **⋯ menu** edits or deletes it later. The same thing over HTTP:

```bash
curl -X POST localhost:3000/api/targets -H 'content-type: application/json' -d '{
  "display_name": "The Internet",
  "base_url": "https://the-internet.herokuapp.com",
  "entry_route": "/login",
  "goals": { "login test": "Log in and read the message shown in the secure area" },
  "personas": { "tom": { "username": "tomsmith", "password": "SuperSecretPassword!" } }
}'
```

(`PUT /api/targets/<app_id>` edits, `DELETE /api/targets/<app_id>` removes.)

Where everything lives — registration is dynamic, but nothing lives in code:

- [`config/targets.json`](config/targets.json) gets the target's *shape*: name, URL,
  allowlist, risky routes, saved goals, and the **names** of the env vars that will hold
  credentials (derived from the app id — the payload cannot carry a `credentials` key).
  This file is the reviewable safety surface: a boundary test fails the suite if a secret
  value ever appears in it, and the writer re-asserts that same shape before every write.
- `data/creds/<app_id>.json` gets the personas (the logins) — **gitignored**, written
  `0600`. Values are injected into the env names at browser launch and redacted from
  every transcript, artifact, and log.
- Runs and interventions live in a local SQLite database under `data/` (gitignored);
  recordings land in `artifacts/`, per-run evidence in `evidence/`.
- The agent can never leave your app's origin — that's structural. Allowed paths default
  to `/` (the whole app) for a friction-free start; narrow them whenever you want, and
  mark risky paths to require confirmation. Action types default to the five primitives
  (`navigate`, `click`, `type`, `read`, `wait_for`).

**Why several logins?** Each run picks a `persona`. Different logins carry different
app-side permissions, so the same capability can surface *"permission denied"* as a
`BUSINESS_OUTCOME` — a legitimate, typed answer the caller handles as data — rather than
a crash.

## 2. Record a test run

From the console: pick a saved goal and a login in the prompt box, add params if the
task needs them, hit **Run** — and watch it happen in the live viewer.

One real LLM-driven run (`claude-sonnet-5`, headed Chromium, ~1 min). The recording is the
typed artifact at `artifacts/<capability-id>/v1.json` — ordered steps, ranked locator
candidates, typed inputs and outputs, a success checkpoint. That file **is** the script;
no code is generated from it.

## 3. Replay it — deterministically

Capabilities tab → **Replay** (params + login are per-replay choices). The result lands
in Test runs; the capability's replays count ticks up in place.

No model in the loop — stable locators, explicit waits, checkpoint verification, ~5s.
Every replay resolves to one of the four outcomes below, stores a full report, and writes
a rolling reliability signal (`confidence`) back into the artifact.

## 4. Review every run

The console's **Test runs** table lists every run — discovery and replay, newest first,
with its outcome and what it produced. Each row's **Report** link opens the run in a new
tab: outcome banner, configuration (app, goal, login, params, capability), the
step-by-step trail, the screenshot gallery, and token usage for discovery runs. The page
is a read-only projection of `evidence/<run-id>/` — the transcript, screenshots, and
result written as the run happened — and keeps updating while a run is live.

## Prefer the terminal? The same flow, CLI end to end

The CLI drives the same engine through the same gates — runs made here appear in the
console too. Worked example against a public practice site:

```bash
npm start                                  # control plane (registration + catalog are HTTP)

# 1. Register (same payload the modal sends — see section 1 for the curl)

# 2. Record: one real LLM run, headed Chromium. The CLI takes any free-text goal.
npm run discover -- --app-id the-internet \
  --goal "Log in and read the message shown in the secure area" \
  --persona tom
#    → prints status, run id, evidence folder, token usage, and the capability id

# 3. Inspect the recording and the evidence
cat artifacts/<capability-id>/v1.json
ls evidence/<run-id>/                      # transcript.jsonl, screenshots, result.json

# 4. Replay — no LLM. Exit 0 = SUCCESS or BUSINESS_OUTCOME, 1 = HARD_FAILURE.
npm run replay -- --id <capability-id> --persona tom --headed

# 5. The agent's-eye view: approve, then invoke by name over HTTP
npm run invoke                             # catalog — empty until something is approved
curl -X PATCH localhost:3000/api/artifacts/<capability-id>/status \
  -H 'content-type: application/json' -d '{"status":"approved"}'
npm run invoke -- --id <capability-id>     # typed args in, four-way result out

# 6. The report for any run, CLI-made or not:
#    open localhost:3000/report.html?run=<run-id> — or read evidence/<run-id>/result.json
```

### Proof of work

`artifacts/` and `evidence/` ship empty and fill as you use the system — every run writes
its own folder. The development history is preserved in git: the
`lookup-member-savings-account` v1→v4 story (a weak locator caught by replay as a
`HARD_FAILURE`, fixed after the engine learned to report ambiguity samples, business
outcomes declared from foresight by v4) and the original discovery / replay / escalation
evidence all live in this repo's earlier commits. The evidence set that ships at
submission is recorded fresh — see [PLAN.md](PLAN.md).

### Escalation & handoff (the operator console)

Start a run with a small max-turns budget (or wait for a genuine escalation): the run
**pauses with the browser session held open**, an intervention appears in the operator
panel with the reason and a screenshot, and the operator drives the *same live page*
through the same action primitives the agent uses — then hits **Resume**, and the agent
continues from whatever state the human left. Every human step lands in the same evidence
trail, tagged `actor: "human"`.

The same handoff is scriptable over HTTP (`/api/escalations`), which is how the committed
evidence run with `paused`/`resumed` events was produced.

### Stretch goals: the agent-facing catalog & confidence gating

Recorded capabilities are exposed to AI agents as a **catalog of callable tools** — but
only after a human approves them.

```bash
# The catalog an agent sees. Empty until something is approved — drafts are invisible
# to agents no matter how safe they are.
npm run invoke

# The one human act the system never grants itself (also a button in the console):
curl -X PATCH localhost:3000/api/artifacts/<capability-id>/status \
  -H 'content-type: application/json' -d '{"status":"approved"}'

# Invoke by name with typed args — over HTTP, as an agent would:
npm run invoke -- --id <capability-id> --param member_id=12345
```

Catalog entries are deliberately shaped like tool definitions (`name`, `description`,
`input_schema`) — what a function-calling agent needs to decide whether and how to call.
After two clean invokes the artifact reads `"confidence": { "runs": 2, "successes": 2 }`
and the catalog line shows `2/2 replays ok`.

---

## The result contract

Every replay resolves to exactly one of four outcomes. The second one is the reason this
contract exists:

| Outcome | Meaning | Caller does |
|---|---|---|
| `SUCCESS` | Checkpoint verified, typed outputs extracted | Use the outputs |
| `BUSINESS_OUTCOME` | A legitimate answer — "no such member", "permission denied" | **Handle as data, not an error** |
| `RECOVERABLE` | A known interstitial was cleared, execution continued | Nothing |
| `HARD_FAILURE` | Nothing matched | Debug: step, expectation, observation, every locator tried, screenshot |

Collapsing `BUSINESS_OUTCOME` into `HARD_FAILURE` is the most common way this problem gets
got wrong, so business outcomes are **declared in the artifact** and checked *before* the
success checkpoint — and again if a locator resolves to nothing, because a missing element
is sometimes the answer rather than a fault.

---

## Design decisions worth defending

**Ranked locator candidates, never one selector.** Legacy targets have no test IDs, so any
single selector is a guess. Each step carries an ordered candidate list; the first that
resolves to exactly **one** visible element wins. A candidate matching several elements is
*rejected*, not silently `.first()`-ed — and the rejection reports each match's ancestor
path, which is how the discovery model (blind to the DOM) finds the attribute that scopes
its next attempt.

**One shared action layer.** The LLM path, the replay path, and the human operator all call
the same five primitives in `src/engine/actions.js`. The model never "just clicks" — it
chooses which primitive to invoke, exactly as replay does. The policy gate runs as the first
line of each, so no caller can forget it.

**The model never sees a secret.** Credentials are referenced by env var *name*; the
harness resolves values after the model has chosen where to type. Personas extend this,
not replace it: the chosen login's values are injected into those same env names at
launch, so the prompt, the artifact, and the replay path are identical whichever persona
runs. Caller data is typed via named parameters (`value_from`), which is also what keeps
recordings parameterized.

**Ownership + a mutex, not vibes.** A paused run keeps its Playwright session open. An
explicit `owner` flag says who *should* act; a per-run async mutex says who *is* acting —
because Node's single thread does not stop two async handlers interleaving on one page.

**The accessibility tree is the primary perception channel**, not the DOM and not the
screenshot. It exists on legacy web apps and native desktop apps alike. Swapping Playwright
for an OS accessibility API later changes one file.

**Artifacts are files, not rows.** "Reviewable" is a requirement; a JSON file is diffable in
a code review. Operational state (runs, interventions) uses SQLite.

---

## Tests

```bash
npm test
```

81 tests. The replay and escalation suites drive a live fixture on port 3001 and skip
cleanly unless that fixture is registered *and* running; every other suite — schema,
policy, registration, personas, reports, capabilities, boundaries — runs with nothing
else up. Several are architectural invariants that fail the suite if a structural claim
in this README ever stops being true — replay importing an LLM SDK, `src/` importing a
target app, a hardcoded hostname, a secret in `targets.json`, or a second caller of the
policy gate.

---

## Layout

```
src/schema/     Zod capability schema, artifact store, parameter validation
src/engine/     perception, ranked locator resolution, action primitives, replay, recovery
src/policy/     allowlist, risk, redaction, personas, runtime target registration
src/agent/      discovery loop, tools, artifact writer, escalation & session ownership
src/api/        control plane: targets, runs, artifacts, capabilities, escalations
src/evidence/   RunLogger + the report projection the report page reads
src/db/         SQLite: runs + interventions
src/cli/        discover, replay, invoke (the agent's-eye view, over HTTP)
public/         console: sidebar + add-app modal + runs + report page (vanilla JS)
config/         targets.json — starts empty; registration fills it, never with a secret
data/creds/     your logins per app, written at registration (gitignored)
artifacts/      recorded capabilities, versioned JSON (genuine model output only)
evidence/       per-run transcripts, screenshots, results
```

Working agreement in [CLAUDE.md](CLAUDE.md); remaining work in [PLAN.md](PLAN.md).
