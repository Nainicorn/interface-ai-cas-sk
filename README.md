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
```

The target application is a **separate sibling repository**, [`../mock-bank`](../mock-bank) —
an intentionally dated, server-rendered "core banking admin" with table layouts, no element
ids, and no test IDs anywhere. It is a fixture, not part of this system.

```bash
cd ../mock-bank && npm install && npm start    # port 3001
```

Or, from this repo, `npm run target` does the same thing.

**Running without live services:** replay and the operator console need no LLM key —
`ANTHROPIC_API_KEY` is used only by `npm run discover`. Schema, policy, and boundary tests
run with nothing else up; replay and escalation tests expect the mock bank on port 3001.

### Pointing it at a different application

Nothing in `src/` hardcodes a hostname, a route, or a credential — a test enforces that.
Add a block to [`config/targets.json`](config/targets.json) with your `base_url`,
`entry_route`, allowlist, and the **names** of the env vars holding your credentials, then
pass `--app-id <your key>`. Secrets are referenced by env var name and never enter that
file, an artifact, a transcript, or the database.

---

## Demo path

```bash
# 0. Start the target (separate terminal)
npm run target

# 1. Discover: one real LLM-driven run against the live surface (~1 min, headed Chromium)
npm run discover -- --app-id mock-bank \
  --goal "Look up member 10001 and read their savings account number and balance" \
  --param member_id=10001

# 2. Replay the recorded artifact — no LLM, deterministic, ~5s
npm run replay -- --id lookup-member-savings-account --param member_id=10001

# 3. The same capability against a member who does not exist → BUSINESS_OUTCOME, not an error
npm run replay -- --id lookup-member-savings-account --param member_id=99999

# 4. A member who exists but holds no savings account → a different BUSINESS_OUTCOME
npm run replay -- --id lookup-member-savings-account --param member_id=10002
```

### Escalation & handoff (the operator console)

```bash
npm start                 # control plane + operator console on port 3000
```

Open the console in a browser. Start a run from the goal form with a small max-turns
budget (or wait for a genuine escalation): the run **pauses with the browser session held
open**, an intervention appears in the operator panel with the reason and a screenshot,
and the operator drives the *same live page* through the same action primitives the agent
uses — then hits **Resume**, and the agent continues from whatever state the human left.
Every human step lands in the same evidence trail, tagged `actor: "human"`.

The same handoff is scriptable over HTTP (`/api/escalations`), which is how the committed
evidence run `evidence/*-discovery` with `paused`/`resumed` events was produced.

---

## The result contract

Every replay resolves to exactly one of four outcomes. The second one is the reason this
contract exists:

| Outcome | Meaning | Caller does |
|---|---|---|
| `SUCCESS` | Checkpoint verified, typed outputs extracted | Use the outputs |
| `BUSINESS_OUTCOME` | A legitimate answer — "no such member", "no savings account" | **Handle as data, not an error** |
| `RECOVERABLE` | A known interstitial was cleared, execution continued | Nothing |
| `HARD_FAILURE` | Nothing matched | Debug: step, expectation, observation, every locator tried, screenshot |

Collapsing `BUSINESS_OUTCOME` into `HARD_FAILURE` is the most common way this problem gets
got wrong, so business outcomes are **declared in the artifact** and checked *before* the
success checkpoint — and again if a locator resolves to nothing, because a missing element
is sometimes the answer rather than a fault.

---

## Design decisions worth defending

**Ranked locator candidates, never one selector.** The target has no test IDs, so any single
selector is a guess. Each step carries an ordered candidate list; the first that resolves to
exactly **one** visible element wins. A candidate matching several elements is *rejected*,
not silently `.first()`-ed — and the rejection reports each match's ancestor path, which is
how the discovery model (blind to the DOM) finds the attribute that scopes its next attempt.

**One shared action layer.** The LLM path, the replay path, and the human operator all call
the same five primitives in `src/engine/actions.js`. The model never "just clicks" — it
chooses which primitive to invoke, exactly as replay does. The policy gate runs as the first
line of each, so no caller can forget it.

**The model never sees a secret.** Credentials are referenced by env var *name*; the harness
resolves values after the model has chosen where to type. Caller data is typed via named
parameters (`value_from`), which is also what keeps recordings parameterized.

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
npm test          # 57 tests; needs the mock bank on port 3001 for replay + escalation suites
```

Four are architectural invariants that fail the suite if a structural claim in this README
ever stops being true — replay importing an LLM SDK, `src/` importing the target app, a
hardcoded hostname, or a second caller of the policy gate.

---

## Layout

```
src/schema/     Zod capability schema, artifact store, parameter validation
src/engine/     perception, ranked locator resolution, action primitives, replay, recovery
src/policy/     allowlist, risk classification, redaction
src/agent/      discovery loop, tools, artifact writer, escalation & session ownership
src/api/        control plane: runs, artifacts, escalations
src/evidence/   RunLogger — one transcript format for llm / replay / human actors
src/db/         SQLite: runs + interventions
src/cli/        discover, replay
public/         operator console (vanilla JS, no build step)
config/         targets.json — every automatable app, no secrets
artifacts/      recorded capabilities, versioned JSON (genuine model output only)
evidence/       per-run transcripts, screenshots, results
```

`artifacts/lookup-member-savings-account/` v1→v4 is the honest history of the recording:
v1's weak locator was caught by replay as a `HARD_FAILURE`, v2 fixed locator scoping after
the engine learned to report ambiguity samples, v4 declares business outcomes the model
*foresaw* rather than encountered. The evidence folders tell the same story.

Working agreement in [CLAUDE.md](CLAUDE.md); remaining work in [PLAN.md](PLAN.md).
