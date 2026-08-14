# PLAN.md — Build Plan

Detailed, phase-by-phase build plan for the interface.ai take-home (Assignment A —
Computer-Use Automation System). Design rationale and conventions live in
[CLAUDE.md](CLAUDE.md); this file is the sequencing, the file-by-file breakdown, and the
done-when criteria.

---

## 1. What we're building, in one sentence

> The model discovers once. The recording becomes a reusable, typed **capability**.
> Deterministic replay is how a production agent invokes that capability later — cheaply,
> safely, without the LLM anywhere near the decision loop.

Every phase below should visibly serve that sentence. If a piece doesn't serve
discover → artifact → replay → escalate → guardrails, it is stretch, and stretch is optional.

## 2. Reading of the brief

The PDF is explicit about how it is graded, and two things dominate:

1. **One real LLM-driven discovery run against a live surface, with evidence in `/evidence/`.**
   This is the only non-negotiable. "That's the heart of the project and we can't assess a
   description of it."
2. **A thin-but-real vertical slice through all six of §3**, not a polished subset. The brief
   says outright: *"Cut depth, not whole capabilities."* Every core requirement must be
   present and working, even if minimal, stubbed at a clean seam, or deliberately mocked.

Depth goes into the three load-bearing pieces the brief names: **artifact schema**,
**deterministic replay + error taxonomy**, and **the safety / escalation model**.

Things the brief actively penalizes: feature breadth, framework name-dropping, and building
scaling infrastructure (queues, clusters, multi-tenant plumbing) before it's needed. Designing
abstractions that *could* scale is rewarded; building the scaling is not.

The single most-called-out design trap, quoted from the glossary:

> **Business outcome vs. failure** — "no such member" is a legitimate answer the caller needs,
> not a crash. Conflating the two is the most common design mistake here.

That distinction gets its own outcome type in the replay contract (§7 below) and its own
evidence run.

## 3. Requirement → implementation map

| § | Requirement | Where it lands | Depth |
|---|---|---|---|
| 3.1 | Goal-driven agent loop | `src/agent/discovery.js` | Full — real LLM, real browser |
| 3.2 | Structured artifact | `src/schema/` | **Deep** — focal point |
| 3.3 | Deterministic replay + errors | `src/engine/replay.js` | **Deep** — focal point |
| 3.4 | Safety & policy guardrails | `src/policy/` | Full, small |
| 3.5 | Evidence / observability | `src/evidence/logger.js` | Full, small |
| 3.6 | Human-in-the-loop escalation | `src/agent/escalation.js` + operator UI | **Deep** on the seam, mocked UI |
| 3.7 | Heterogeneity & multi-tenant | REPORT.md §4 + schema shape | Design only — not built |

## 4. Tech stack

Plain JavaScript on Node — no TypeScript, no build step, no bundler. `node` runs the files
directly.

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node 20+, ESM, plain JS** (`"type": "module"`) | One `npm install`, zero transpile. "Easy to run" is a scored criterion. |
| Contract validation | **Zod** | Runtime validation *and* JSON Schema generation from one definition. Feeds four consumers — see below. |
| Browser control | **Playwright (Node)** | Reference implementation. `locator.ariaSnapshot()` gives the a11y tree; screenshots and DOM from the same API. |
| LLM | **`@anthropic-ai/sdk`**, model `claude-sonnet-5` | Native tool-use loop, vision input. Near-Opus quality on agentic work; the loop is UI navigation, not deep reasoning. |
| Target app | **Express 5 + EJS**, own process, port 3001 | Server-rendered, table layouts, no test IDs. Real network boundary. |
| Control plane | **Express 5**, port 3000 | Same framework, different app. |
| Storage | **`better-sqlite3`** (runs, interventions, confidence) + **JSON files** (artifacts) | Zero setup; artifacts stay human-reviewable in a diff. |
| Tests | **`node --test`** (built-in) | Zero extra deps, native ESM. |
| Operator UI | Vanilla JS/HTML/CSS, no framework | It's a control panel, not a product. |

**Why Zod carries its weight in a plain-JS project.** The brief asks for a *typed* artifact.
That means the artifact's contract is typed and validated — not the host language. One Zod
definition feeds all four consumers:

1. Artifact validation on save and load
2. Replay input-parameter validation
3. Claude tool-use `input_schema` (via `z.toJSONSchema()`)
4. The agent-facing capability catalog's published contract

Static types would be a fifth benefit; skipping them costs nothing on the graded criteria.

**Explicitly not using:** a queue engine or Redis (brief penalizes premature scaling infra),
a frontend framework or bundler, an ORM, TypeScript, and a second web framework.

### Anthropic API specifics

Model is **`claude-sonnet-5`**. Worth stating these explicitly because several changed
recently and the stale patterns hard-error rather than degrading:

- Thinking is **on by default** — omitting `thinking` runs adaptive. Keep it on: with thinking
  disabled Sonnet 5 is measurably less eager to reach for tools, which is the wrong trait for
  an agent loop.
- `budget_tokens` is **removed** (400). Depth is controlled by `output_config: { effort }`.
- `temperature` / `top_p` / `top_k` are **rejected** at non-default values (400). Steer with
  prompting.
- Assistant-turn prefill is **rejected** (400). Use structured outputs if we ever need a forced
  output shape.
- `max_tokens` caps thinking **plus** response text — size it with headroom.
- Starting point: `output_config: { effort: "medium" }`, `max_tokens: 16000`, non-streaming.
  `effort` defaults to `high`; `medium` is the cost step-down and is plenty for UI navigation.
  Sweep it once the loop works.
- **Vision cost is the thing to watch in this loop.** Sonnet 5 is high-resolution tier — up to
  2576px on the long edge and ~4784 image tokens per screenshot. At one screenshot per step
  across ~15 steps that dominates the bill, so cap the browser viewport (1024×768) rather than
  sending native-resolution captures. The a11y tree is the primary perception channel anyway;
  the screenshot is for visual grounding.
- Sonnet 5 uses a newer tokenizer (~30% more tokens for the same text than Sonnet 4.6), so
  don't reuse token or cost baselines measured against older Sonnet models.

## 5. Repository layout

**Two sibling repositories, not one project.** This repo is the deliverable; the mock bank
is a fixture that lives beside it. The separation is load-bearing and must not blur.

```
Documents/
├── mock-bank/           # SEPARATE REPO — the target, port 3001
│     server.js          # boot, view engine, 404
│     routes.js          # login / search / member / open-account
│     data.js            # member table + business rules; typed errors
│     session.js         # in-memory sessions, two TTLs
│     views/             # EJS, <table> layout, zero test IDs
└── interface-ai-cas-sk/ # THIS REPO — the system, port 3000
```

Why sibling repos rather than one tree: a reviewer may point this system at their own
stack instead of the fixture, and that has to be a config change. Keeping the target out
of the tree makes the claim visible rather than merely asserted — and `config/targets.json`
plus `tests/boundaries.test.js` make it enforced.

```
/src/                    # THE SYSTEM — port 3000
  schema/
    enums.js             # ActionType, RiskLevel, CapabilityStatus, OutcomeType
    capability.js        # Zod: LocatorCandidate, LocatorStrategy, Step, Capability
    store.js             # save / load / list → artifacts/{id}/v{n}.json
  engine/
    errors.js            # LocatorResolutionError, PolicyViolation, CheckpointFailed
    perception.js        # capture_state(page) → PageState
    locator.js           # resolveLocator() — ranked candidate fallback
    actions.js           # click / type / navigate / read / waitFor — THE shared primitives
    recovery-table.js    # small, explicit {detect, action} pairs
    replay.js            # no-LLM executor + 4-way outcome classification
  agent/
    tools.js             # tool defs (JSON Schema from Zod) + dispatch
    prompts.js           # system prompt
    discovery.js         # the observe → decide → act loop
    escalation.js        # SESSION_REGISTRY, ownership, pause/resume
  policy/
    allowlist.js         # AllowlistConfig per app_id + checkAllowed()
    risk.js              # classifyRisk(route|action)
    redact.js            # redact(value, fieldName, policy)
  evidence/
    logger.js            # RunLogger → transcript.jsonl, screenshots, result.json
  db/
    sqlite.js            # schema init + tiny query helpers
  api/
    server.js            # Express app, static /public, route mounting
    runs.js              # POST /api/runs, GET /api/runs/:id
    artifacts.js         # GET/PATCH artifacts, POST replay
    escalation.js        # list / context / manual-action / resume
    capabilities.js      # agent-facing catalog + invoke  [stretch]
  cli/
    discover.js  replay.js  invoke.js

/public/                 # operator console + demo UI (vanilla, no build)
  index.html  styles.css
  components/goal-form.js  run-status.js  artifact-viewer.js
             replay-panel.js  operator-console.js

/config/targets.json     # every automatable app, keyed by app_id — NO secrets
/artifacts/              # versioned capability JSON (recorded output only)
/evidence/               # per-run folders, committed
/tests/
  fixtures/              # hand-authored capability, for testing replay without the LLM
  boundaries.test.js     # architectural invariants, asserted not promised
package.json
.env.example  README.md  REPORT.md  PLAN.md  CLAUDE.md
```

The only channel between the two repos is HTTP through a real browser. This is **enforced by
tests**, not convention — `tests/boundaries.test.js` fails the suite if `src/` ever imports
from the sibling app, if anything on the replay path imports the LLM SDK, or if a target
hostname is hardcoded anywhere in `src/`.

Note `tests/fixtures/` versus `artifacts/`: the fixture is a hand-written capability used to
prove replay correct before the agent exists. `artifacts/` is reserved for genuine recorded
output — passing a hand-written file off as a recording would undercut the one claim the
submission rests on.

## 6. The artifact schema

The focal point. An artifact is a **capability an agent can call**, not a transcript.

```
Capability
├── id, name, version, status: draft | approved
├── description
├── target:
│     app_id            ← vendor product, NOT a tenant and NOT a raw URL
│     entry_route
│     tenant_overrides[] ← small diff layer (design-only)
├── input_schema         ← typed, JSON Schema (generated from Zod)
├── output_schema        ← typed
├── risk_level: safe | risky
├── steps[]:
│     intent                    ← human-readable "why"
│     action                    ← click | type | navigate | read | wait_for
│     locator_strategy:
│         candidates[]          ← RANKED fallbacks, never a single selector
│           { kind: role|text|label|structural, value, confidence }
│     expected_outcome          ← checkpoint condition, fixed vocabulary
│     business_outcome_pattern? ← how a legitimate non-happy-path looks here
│     extract_as?               ← name to bind an extracted value to
├── success_checkpoint
├── created_from         ← discovery run id (linked, but decoupled)
└── redaction_policy     ← field names whose values must never be logged
```

Design decisions to defend:

- **Typed I/O makes it callable, not just replayable.** A step list is a script; a schema is
  a contract. §3.2 asks for a capability "an AI agent can call."
- **Ranked locator candidates, never one selector.** The brief's stated norm is *no test IDs*.
  A single CSS/XPath is the brittle answer; a ranked list with a documented preference order
  (role+name → label → visible text → structural position) degrades instead of snapping.
- **`risk_level` on the capability, not only per step**, so replay can gate an entire
  capability behind approval without inspecting its internals.
- **`app_id` is the vendor product, not the tenant.** This is the hinge the whole multi-tenant
  story turns on (§3.7): one base recording, a small `tenant_overrides` diff, not N recordings.
- **`created_from` links the run but doesn't embed it.** §3.2 requires the artifact be
  "decoupled from the raw model transcript." The transcript lives in `/evidence/{run_id}/`.
- **Versioned, pretty-printed JSON on disk.** Human-reviewable in a code review, diffable
  between versions. A DB row is not reviewable without a client.

## 7. Determinism and the error taxonomy

Replay **never asks the LLM to decide**. It *detects* runtime state and classifies it into
exactly one of four outcomes, per step and overall:

| Outcome | Meaning | Caller action |
|---|---|---|
| `SUCCESS` | Checkpoint verified, outputs extracted | Use the outputs |
| `BUSINESS_OUTCOME` | Legitimate non-happy-path (e.g. "no such member") | **Not an error.** Handle as data. |
| `RECOVERABLE` | Known interstitial (cookie banner, slow load) | Bounded, declared recovery, then continue |
| `HARD_FAILURE` | Nothing matched | Stop. Return step + expected + observed + screenshot. |

Determinism comes from four mechanisms, not from hope:

1. **Ranked locator resolution.** Try candidates in order; accept the first that resolves to
   exactly one visible, enabled element. Zero matches or ambiguity → next candidate. All
   exhausted → `LocatorResolutionError`.
2. **Positive checkpoint assertion after every state-changing step.** Never infer success from
   "the click didn't throw." §3.3 and the glossary both call this out.
3. **Fixed-vocabulary condition matching**, deliberately not fuzzy: `text_visible: X`,
   `url_contains: Y`, `element_exists: <locator>`. A fuzzy matcher would smuggle
   nondeterminism back in.
4. **A small, hand-maintained recovery table** of `{detect, action}` pairs. Bounded and
   declared — never LLM improvisation. Recovery attempts are capped and logged.

The mock app seeds four failure modes deterministically (query param / seeded data, never
randomness) so `/evidence/` can *prove* each branch rather than assert it.

## 8. Safety model

- **Allowlist per `app_id`**: permitted route prefixes + permitted action types. Checked as the
  **first line of every action primitive** — so it applies to the LLM path, the replay path,
  and the human operator path identically. There is no privileged path.
- **Risk classification**: read / search / navigate = `safe`; create / modify / submit =
  `risky`. Risky steps require confirm-before-execute during discovery. Risky *capabilities*
  default to `draft` and cannot run unattended until `approved`.
- **Redaction**: `redaction_policy` names sensitive fields (member ID is PII here). Logs store
  field names and value *shapes*, never raw values. Credentials never touch the artifact or the
  log store — only the live browser context's cookie jar.
- **Minimal allowlist ships in phase 0.5, not 0.75** — the first real LLM run must be guarded
  from its very first action, not retrofitted afterwards.

A nice consequence for the demo: the operator console accepts a free-text URL, and entering one
outside the allowlist produces a logged `PolicyViolation` instead of a navigation. The guardrail
becomes a visible evidence artifact rather than a claim in the README.

## 9. Escalation and control transfer

The brief is specific: the human must operate **the same live session**, not a fresh one, and
control must hand back.

- `SESSION_REGISTRY: Map<runId, { browser, context, page, owner, goal, lock }>`
- `owner ∈ 'agent' | 'human' | 'paused'`
- Detect stuck: max steps, timeout, the model calls `escalate`, or a risky step needs
  confirmation.
- On escalation: **the Playwright context stays open.** Write an intervention row to SQLite with
  capability/goal id, current step, reason, screenshot, and a11y snapshot. Set `owner = 'paused'`.
- The operator console polls, renders the screenshot, and issues **the same action primitives**
  the agent uses — logged into the same evidence trail with `actor: 'human'`.
- Resume sets `owner = 'agent'`; the loop re-observes from the *current* page state and continues.

**Node's single thread does not make this safe by itself.** Two async handlers interleave freely
at every `await`, so an operator action and an agent action can both be mid-flight on the same
`page`. Ownership therefore needs an explicit owner check *plus* a small async mutex per run —
a promise-chain lock, ~15 lines, no dependency. This is the concurrency note worth writing down;
"it's single-threaded so it's fine" would be wrong.

## 10. Heterogeneity & multi-tenant — design only

Not building this. The brief says design credibly, don't implement.

- **Surface abstraction.** The `action` + `locator_strategy` vocabulary is already
  surface-agnostic — it speaks role/name/label/text, not CSS. The seam between "how we perceive
  and act on a surface" and "the recorded flow" is `perception.js` + `actions.js`: a legacy
  frameset needs frame-aware a11y traversal behind the same interface; a native desktop app
  swaps Playwright for an OS accessibility API. The artifact doesn't change.
- **Multi-tenant reuse.** `app_id` keys the vendor product. One base recording plus a
  `tenant_overrides` diff (branding, a renamed field, a route prefix) rather than a re-record
  per tenant. Canonicalizing concrete values into parameters (`/member/10001` → `/member/:id`)
  is what makes the base recording shareable.
- **Drift detection.** Rolling per-tenant success rate per capability. A sustained drop flags
  "this tenant diverged" without touching the others — and doubles as the confidence signal
  behind approval gating.

## 11. Phases

Roughly 70% of real coding effort is in 0.3, 0.5, and 0.6. Everything after 0.7 gets
progressively lighter; 1.0 is writing, not code. **Slow down and review every diff from 0.6
onward** — those are the pieces to defend in an interview.

### 0.1 — Environment
Node 20+, `npm init`, deps (`express`, `ejs`, `express-session`, `zod`, `playwright`,
`@anthropic-ai/sdk`, `better-sqlite3`), `npx playwright install chromium`, `.env` with
`ANTHROPIC_API_KEY` (gitignored), `.env.example` committed.
**Done when:** `npm install && npm run dev` starts both processes.

### 0.2 — Smoke tests
Three trivial scripts: Express `/health` responds; Playwright screenshots a page; one Claude
API call returns text.
**Done when:** all three pass. Don't build on an unverified key or an uninstalled browser.

### 0.3 — Mock bank app *(heavy)*
`mock-bank/`. `data.js`: dict-based fake member DB — `10001`/`10002` valid, `40000` locked
(→ permission denied), `99999` deliberately absent (→ not found); `createSubAccount()` validates
and throws on bad data or a locked member. `session.js`: in-memory store with **two TTLs** — a
generous 10-minute default so a normal discovery run never randomly expires, and a 5-second one
passed explicitly *only* to force the timeout demo. `routes.js`: login → search → member detail
→ open account → confirmation; each route checks session, runs logic, renders. Views: `<table>`
layout, no CSS classes, no ids, **no `data-testid` anywhere** — that's what makes it legacy, and
it's a styling choice, not extra code.

Four injectable failure modes, all deterministic: member not found, validation error (missing
field), permission denied (locked member), session expired mid-flow.

**Done when:** clicked through by hand end to end, and all four failure modes triggered by hand.

### 0.4 — Artifact schema
`src/schema/`. Zod models matching §6 exactly. `saveArtifact` / `loadArtifact` /
`listArtifacts` reading and writing pretty-printed JSON to `artifacts/{id}/v{n}.json`.
**Done when:** `tests/artifact-roundtrip.test.js` hand-constructs a Capability, saves it, loads
it back, and gets an identical object. This is what everything else depends on — it gets a real
test, not a manual check.

### 0.5 — Perception + actions + minimal guardrail *(heavy)*
`src/engine/` + `src/policy/allowlist.js`. The file both discovery and replay call into;
**neither gets a special path.**

- `perception.js`: `captureState(page)` → `{ url, title, ariaTree, screenshot, visibleText }`.
- `locator.js`: `resolveLocator(page, strategy)` tries ranked candidates, returns the first
  resolving to exactly one visible+enabled element, throws `LocatorResolutionError` if none do.
- `actions.js`: `click` / `typeText` / `navigate` / `read` / `waitFor`. **Every one calls
  `checkAllowed()` as its first line.**
- `allowlist.js`: `AllowlistConfig` (route prefixes + action types) and `checkAllowed()`
  throwing `PolicyViolation`. Minimal, but shipping now so 0.6 is guarded from its first action.

**Done when:** a hand-written script clicks through login → search → member detail with no LLM,
and `checkAllowed` demonstrably blocks a URL outside `/`.

### 0.6 — Discovery agent loop — THE REAL RUN *(heavy, non-negotiable)*
`src/agent/`. Model `claude-sonnet-5`.

`tools.js`: one tool per action primitive, plus `emit_artifact` (only callable once the success
checkpoint is visible) and `escalate` (with a reason). Schemas generated from Zod.

`discovery.js`: `runDiscovery({ goal, appId, entryRoute })` — launch Playwright, navigate, then
loop up to `maxSteps`: call Claude with tools → dispatch each `tool_use` block into the matching
`actions.js` function → `captureState()` → feed back as a `tool_result` (a11y tree + trimmed
text + screenshot image block) → repeat. `emit_artifact` validates and saves, returns success.
`escalate` or step exhaustion pauses (browser stays open), creates an intervention, and returns
`{ escalated: true }` — a handled outcome, not a crash.

**Manual loop, not the SDK's `toolRunner`** — a deliberate deviation from the SDK default, for
three reasons: escalation must suspend the loop and resume it from a *different* HTTP request
later, which doesn't fit the runner's iteration model; §3.1 grades the observe → decide → act
loop, so it should be visible as an actual loop in the code; and it avoids a beta dependency on
the one path that must work. The runner would be the right call if escalation weren't in scope.

**Done when:** run against 0.3's app with a real goal ("look up member 10001 and read their
savings balance"), watch Chromium do it live, and end with a saved `artifacts/.../v1.json`.
**Copy the transcript and screenshots into `/evidence/` immediately** — this is the run the
whole submission rests on.

### 0.7 — Replay executor (no LLM)
`src/engine/replay.js` + `recovery-table.js`. Pure composition of 0.4 and 0.5.
`replayCapability(capability, params)`: policy check (risky + draft → `HARD_FAILURE`) → validate
params against `input_schema` → walk `steps[]` calling **the same** `actions.js` functions →
classify each step into the §7 four-way outcome → extract declared outputs → final checkpoint.
**Done when:** replaying 0.6's artifact with the same member id succeeds; replaying with `99999`
returns a clean `BUSINESS_OUTCOME`, not a crash. These are two of the four required evidence runs.

### 0.75 — Guardrails, expanded
`src/policy/`. `AllowlistConfig` gains an `app_id` field (one config per app, not one global).
`classifyRisk(route)`. `redact(value, fieldName, policy)`.
**Done when:** a goal referencing a URL outside the allowlist is blocked with a logged
`PolicyViolation`, proving the 0.5 check still holds under a real per-app config.

### 0.8 — Escalation & handoff
`src/agent/escalation.js` + `src/api/escalation.js`. Session registry, per-run async mutex,
`createIntervention()` → SQLite, `performManualAction()` awaiting into the same `actions.js`
functions with `actor: 'human'`, `resume()`. Routes: list pending, get context + screenshot,
manual action, resume.
**Done when:** force an escalation, see the paused browser sitting untouched, drive it one step
manually, hit resume, and watch the run continue from that point.

### 0.85 — Evidence & logging
`src/evidence/logger.js`. `RunLogger(runId)`: `logStep({ actor, step, action, locatorUsed,
outcome, detail })` appending JSON lines to `transcript.jsonl`; `saveScreenshot()`;
`saveResult()` writing a summary `result.json`. One instance wired into `discovery.js`,
`replay.js`, and `escalation.performManualAction` — one format, three actors
(`llm` / `replay` / `human`).
**Done when:** any `evidence/{run_id}/` folder is readable standalone — `result.json` for the
summary, `transcript.jsonl` for the blow-by-blow, screenshots — with no code needed.

### 0.9 — Operator console + demo UI
`public/` + `src/api/`. One file per component, each with a documented header, one render
function, and one function that calls the API: `goal-form.js`, `run-status.js` (polls
`GET /api/runs/:id`), `artifact-viewer.js`, `replay-panel.js`, `operator-console.js`.
**Done when:** the whole demo runs from the browser with no terminal after startup — enter a
goal → watch it run → view the artifact → replay it (happy path and failure path) → an
escalation occurs and gets resolved.

### 0.95 — Stretch: capability interface + approval gating
`src/api/capabilities.js`. `GET /capabilities` (approved only, with typed schemas),
`POST /capabilities/:id/invoke` (thin wrapper: load → `replayCapability` → return),
`PATCH /capabilities/:id/status` (human-gated draft → approved), and `updateConfidence()`
(rolling success rate) called **from inside `replayCapability`** so it can't be forgotten.
**Done when:** `curl -X POST /capabilities/{id}/invoke -d '{"member_id":"10001"}'` returns a
clean structured result — no browser window, no LLM, no human.

### 1.0 — REPORT.md + final evidence pass
Write `/REPORT.md` with the seven exact headings. Mostly transcription from this file and
CLAUDE.md, plus screenshots. Confirm `/evidence/` has all four required runs. Re-check the
deliverables list top to bottom before pushing.

## 12. Stretch goals — picking two

The brief says pick at most one or two, depth over breadth.

1. **Agent-facing capability interface.** This is the actual point of the system per §1 —
   without it, "a capability an AI agent can call" is asserted but never demonstrated.
2. **Confidence & approval gating.** The safety complement to #1: don't expose a callable
   interface without proving that reliability gates unattended and risky capabilities.

**Deliberately not doing** — and saying so in REPORT.md §7:

- *Assisted LLM fallback on replay failure.* Pulls the model back into replay's decision loop,
  which is the exact opposite of the system's thesis. The brief offers it; we decline it on
  principle and explain why.
- *Full cross-tenant demo.* Designed in §3.7, not built.
- *Multi-run stability sweep.* The confidence field already captures the signal.
- *Code generation from an artifact.* Neat, but orthogonal to the through-line.

## 13. Deliverables checklist

- [ ] Public GitHub repo
- [ ] `/README.md` — setup, keys/config, exact demo commands (run agent on a goal → replay)
- [ ] `/REPORT.md` (~1–3 pages), headings **exactly**: Architecture; Artifact schema;
      Determinism & error handling; Heterogeneity & multi-tenant; Escalation & handoff;
      Safety; Cuts
- [ ] `/evidence/` — saved artifact + discovery log + replay log + one replay hitting an
      error/exceptional state
- [ ] At least one **real** LLM discovery run against a live surface
- [ ] Allowlist enforced, risky actions handled conservatively, no secrets or raw PII logged
- [ ] Human escalation operates on the **same live session**
- [ ] Email repo link (own line, no zip) to assignments@interface.ai from the address applied with

## 14. Risks

| Risk | Mitigation |
|---|---|
| Burning the time box on the mock app | It's a proxy, not a product. Table layouts, no CSS. Timebox 0.3 hard. |
| Discovery run flakes and eats the budget | 0.2 smoke-tests the key first. Cap `maxSteps`. Save evidence the moment it succeeds. |
| Replay quietly reimplementing actions | Single `actions.js`; assert in review that `replay.js` imports it and defines no primitives. |
| Escalation demo needs precise timing | Add a deterministic `?force_escalate` trigger so the demo doesn't rely on the model getting stuck. |
| Scope creep into the operator UI | It ships at 0.9, after the seam is real. One screenshot + one action form is enough. |
| Over-building for multi-tenant | It's design-only. If code appears for it, cut the code and keep the paragraph. |
