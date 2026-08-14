# Computer-Use Automation System

An LLM drives a legacy web application once to work out how a task is done. That run is
recorded as a **typed, versioned capability**. From then on, an AI agent invokes the
capability through deterministic replay — no model in the decision loop, at a fraction of
the cost, with a result contract that distinguishes *"no such member"* from *"something
broke"*.

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is
> how a production agent invokes it.

**Status: in progress.** Replay, the artifact schema, and the guardrails are built and
tested. The discovery agent is next — see [Build status](#build-status).

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
cd ../mock-bank && npm install && npm start    # http://localhost:3001
```

Or, from this repo, `npm run target` does the same thing.

### Pointing it at a different application

Nothing in `src/` hardcodes a hostname, a route, or a credential — a test enforces that.
Add a block to [`config/targets.json`](config/targets.json) with your `base_url`,
`entry_route`, allowlist, and the **names** of the env vars holding your credentials, then
pass `--app-id <your key>`. Secrets are referenced by env var name and never enter this
file, an artifact, a transcript, or the database.

---

## Demo path

```bash
# 1. Start the target (separate terminal)
npm run target

# 2. Discover: one real LLM-driven run against the live surface  [not yet built]
npm run discover -- --app-id mock-bank \
  --goal "Look up member 10001 and read their savings balance"

# 3. Replay the recorded artifact — no LLM, deterministic          [not yet built]
npm run replay -- --id lookup-savings-balance --params '{"member_id":"10001"}'

# 4. The same capability against a member who does not exist.
#    Returns BUSINESS_OUTCOME, not an error.
npm run replay -- --id lookup-savings-balance --params '{"member_id":"99999"}'
```

Until the CLI lands, the replay path is exercised end to end by `npm test` against a
hand-authored capability in `tests/fixtures/`.

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
not silently `.first()`-ed — on this app `tr:has-text("Savings") td:nth-child(4)` matches
three elements because the layout nests tables, and picking one at random is how automation
quietly does the wrong thing to the wrong record.

**One shared action layer.** The LLM path, the replay path, and the human operator all call
the same five primitives in `src/engine/actions.js`. The model never "just clicks" — it
chooses which primitive to invoke, exactly as replay does. `checkAllowed()` runs as the first
line of each, so policy is not something a caller can forget.

**The accessibility tree is the primary perception channel**, not the DOM and not the
screenshot. It exists on legacy web apps and native desktop apps alike, and it survives the
markup churn that breaks CSS selectors. Swapping Playwright for an OS accessibility API
later changes one file.

**Artifacts are files, not rows.** "Reviewable" is a requirement; a JSON file is diffable in
a code review, a SQLite row is not. Operational state (runs, interventions) does use SQLite.

---

## Tests

```bash
npm test          # 49 tests; replay tests skip cleanly if the target isn't running
```

Four of them are architectural invariants that fail the suite if a structural claim in this
README ever stops being true — replay importing an LLM SDK, `src/` importing the target app,
a hardcoded hostname, or a second caller of the policy gate.

---

## Layout

```
src/schema/     Zod capability schema, artifact store, parameter validation
src/engine/     perception, ranked locator resolution, action primitives, replay, recovery
src/policy/     allowlist, risk classification, redaction
src/agent/      discovery loop and escalation          [in progress]
src/api/        control plane + operator endpoints      [in progress]
src/cli/        discover / replay / invoke              [in progress]
config/         targets.json — every automatable app, no secrets
artifacts/      recorded capabilities, versioned JSON
evidence/       per-run transcripts, screenshots, results
```

Full design rationale in [PLAN.md](PLAN.md); working conventions in [CLAUDE.md](CLAUDE.md).

## Build status

| Phase | State |
|---|---|
| Mock bank target (sibling repo) | ✅ all five runtime states reachable deterministically |
| Artifact schema + store | ✅ roundtrip-tested |
| Perception, locators, action primitives | ✅ |
| Guardrails — allowlist, risk, redaction | ✅ config-driven |
| Deterministic replay + outcome contract | ✅ verified against the live target |
| **Discovery agent (real LLM run)** | ⏳ next |
| Escalation & handoff | ⏳ |
| Evidence logging | ⏳ |
| Operator console | ⏳ |
| REPORT.md | ⏳ |
