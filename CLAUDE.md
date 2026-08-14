# CLAUDE.md — Working Agreement

**Assignment:** interface.ai take-home — Computer-Use Automation System (agentic hands for
legacy bank software).
**Deliverables:** public repo + `/README.md` + `/REPORT.md` (7 fixed headings) + `/evidence/`.
**No deadline — time-box it.** Judged on judgment and integration, not feature count.

Read this before touching code. Phase-by-phase detail, file breakdowns, and done-when criteria
live in **[PLAN.md](PLAN.md)** — this file is the framing, the stack, the conventions, and the
status board. Update §9 as phases complete.

---

## 1. The one-sentence framing

> The model discovers once. The recording becomes a reusable, typed **capability**.
> Deterministic replay is how a production agent invokes that capability later — cheaply,
> safely, without the LLM anywhere near the decision loop.

If a piece of work doesn't serve discover → artifact → replay → escalate → guardrails, it's
stretch, and stretch is optional.

## 2. What the ask actually is

- **Not "build a browser agent."** Build the **integration layer under** an agent product — the
  thing that turns "AI figured out how to do X once" into "any agent can safely invoke X
  forever, without an LLM."
- Legacy bank apps have no API and no clean DOM, but their **UI is stable over time**. The hard
  problem is therefore *not* drift — it's **handling real runtime states correctly on replay**:
  not-found, validation error, permission denial, session timeout, unexpected dialogs.
- Multi-tenant reality (hundreds of tenants, ~20 apps each, many sharing a vendor product)
  means the artifact schema has to be designed so it *could* generalize — even though only one
  surface gets built.
- The deliverable is a **thin-but-real vertical slice through all six core requirements**, not a
  polished subset. The brief says it outright: *cut depth, not whole capabilities.*
- **One hard rule:** the discovery run must be a real LLM call against a real live surface, with
  evidence saved. Everything else may be mocked or designed-only, as long as the seam is real
  and documented.

**The single biggest trap, quoted from the brief's glossary:** *"'no such member' is a
legitimate answer the caller needs, not a crash. Conflating the two is the most common design
mistake here."* This is why replay has a four-way outcome contract, not try/catch.

## 3. Two apps, two repos — never conflate them

| | `../mock-bank` (port 3001) | this repo (port 3000) |
|---|---|---|
| Role | **The target** being automated | **The system** doing the automating |
| Analogue | The legacy bank app | interface.ai's integration layer |
| Style | Ugly on purpose — `<table>`, no CSS classes, no test IDs | Clean, componentized |
| Talks to | Nothing. It just serves HTML. | Any configured target, **only through a real browser** |

They are **separate sibling repositories on disk**, not one project. This repo is the
deliverable; the mock bank is a fixture that happens to be convenient for local testing.
A reviewer may well point this system at *their* stack instead — which is the real test of
whether it's an integration layer or a demo welded to one app.

That property is enforced, not asserted. Three invariants in `tests/boundaries.test.js`
fail the suite if it ever stops being true:

1. Nothing on the replay path imports the Anthropic SDK.
2. Nothing in `src/` imports from the sibling app.
3. No target hostname or port appears anywhere in `src/` — targets live in
   `config/targets.json`, resolved by `app_id`. Adding one is a config change.

Credentials follow the same rule: `config/targets.json` names the **env var**, never the
secret, so the same recorded capability runs against a different deployment with different
credentials and nothing sensitive ever reaches an artifact, a transcript, or the database.

The operator console lives in `public/`, served by the control plane. It is **not** part of the
mock bank app. Folding them together would make the demo incoherent: the agent would be
operating the same app that's orchestrating it.

## 4. Tech stack

Plain JavaScript on Node — **no TypeScript, no build step, no bundler.** One `npm install`, two
processes, `node` runs the files directly.

| Layer | Choice |
|---|---|
| Runtime | Node 20+, ESM, plain JS (`"type": "module"`) |
| Contracts | **Zod** — runtime validation + JSON Schema generation |
| Browser | **Playwright (Node)** — `ariaSnapshot()`, screenshots, DOM from one API |
| LLM | `@anthropic-ai/sdk`, model **`claude-sonnet-5`** |
| Target app | Express 5 + EJS, separate process |
| Control plane | Express 5 |
| Storage | `better-sqlite3` (runs, interventions) + JSON files (artifacts) |
| Tests | `node --test` (built-in) |
| UI | Vanilla JS/HTML/CSS, one file per component |

**Why Zod earns its place in plain JS.** The brief asks for a *typed artifact* — meaning the
artifact's contract is typed and validated, not the host language. One Zod definition feeds
four consumers: artifact validation, replay parameter validation, Claude's tool `input_schema`,
and the agent-facing capability catalog. Static types would be a fifth benefit; skipping them
costs nothing that's graded.

**Not using, deliberately:** a queue engine or Redis (the brief penalizes premature scaling
infrastructure), a frontend framework or bundler, an ORM, TypeScript, a second web framework.

### Anthropic API — current syntax, not the training-data version

Several of these changed recently and the old patterns **hard-error** rather than degrading:

- Thinking is **on by default** on Sonnet 5. Keep it on — with thinking disabled the model is
  measurably less eager to call tools, which is the wrong trait for an agent loop.
- `budget_tokens` → **400**. Control depth with `output_config: { effort }`.
- Non-default `temperature` / `top_p` / `top_k` → **400**. Steer with prompting.
- Assistant-turn prefill → **400**. Use structured outputs if a forced shape is ever needed.
- `max_tokens` caps thinking **plus** response text together.
- Baseline: `output_config: { effort: "medium" }`, `max_tokens: 16000`, non-streaming.
- Cap the browser viewport at 1024×768. Sonnet 5 is high-res-vision tier (~4784 image tokens
  per full-size screenshot); one screenshot per step across a 15-step loop would otherwise
  dominate cost. The a11y tree is the primary perception channel; the screenshot is grounding.

## 5. Coding principles

- **Component-based even in plain JS.** One file or folder per meaningful unit, one job each.
  A function that needs "and" to describe it is two functions.
- **Documented at the point of use.** 2–3 lines at the top of each file: what it does, why it
  exists, what it hands off to. Docstrings on non-obvious functions explaining *why*, not what.
- **Ridiculously simple over clever.** The depth lives in the design decisions, not in dense
  code. Every line has to be defensible out loud in an interview.
- **One framework per job.** No duplicates.
- **One shared action layer.** The LLM path and the no-LLM replay path call the *same*
  `src/engine/actions.js` primitives. The model only ever *chooses* which primitive to call —
  there is no trusted path that replay doesn't also use. If a reviewer can find a second
  implementation of `click`, the design claim is false.

## 6. Architecture

```
 goal (natural language) + target
        │
        ▼
   control plane  ──── allowlist / policy guardrail (checked on EVERY action)
        │
        ▼
  Agent Controller (owns the loop + the live Playwright session)
    │                                   │
    ▼                                   ▼
  Claude (tool-calling)           Browser surface (Playwright)
    │  decide next action              │  execute action
    └──────► observe (a11y tree + screenshot + text) ◄─────┘
        loop until: goal met | checkpoint hit | max steps | stuck → escalate

  on success → Artifact Writer → versioned capability (JSON + SQLite)

  ── separate path, NO LLM ──
  Replay Executor: artifact + params → same action primitives → checkpoint assertions
                   → structured result (SUCCESS | BUSINESS_OUTCOME | RECOVERABLE | HARD_FAILURE)

  ── escalation path ──
  Controller detects stuck → pauses (Playwright context stays alive)
                          → intervention queued
                          → operator console drives the SAME page via the SAME primitives
                          → "resume" hands control back; controller re-observes and continues
```

Full schema, outcome taxonomy, safety model, and escalation mechanics: **PLAN.md §6–§10.**

## 7. Non-negotiables

Check these before claiming any phase is done:

1. The discovery run is a **real** LLM call against a **live** surface, evidence in `/evidence/`.
2. Replay **never** calls the LLM. Not for recovery, not for fallback, not for classification.
3. `BUSINESS_OUTCOME` is a distinct result from `HARD_FAILURE`, and `/evidence/` proves it.
4. Every action — agent, replay, or human — passes through `checkAllowed()` first.
5. Escalation operates on the **same live session**, not a fresh one.
6. No credentials, tokens, or raw PII in artifacts, logs, or the repo. Field names and value
   shapes only.
7. `mock-bank/` and `src/` share no imports.

## 8. Concurrency note worth writing down

Node's single thread does **not** make session ownership safe by itself. Async handlers
interleave at every `await`, so an operator action and an agent action can both be mid-flight
on the same Playwright `page`. Ownership needs an explicit `owner` flag *plus* a small
per-run async mutex (a promise chain, ~15 lines, no dependency). "It's single-threaded so it's
fine" would be wrong, and is the kind of thing an interviewer will probe.

## 9. Build status

Detail and done-when criteria for each phase: **[PLAN.md §11](PLAN.md).**

- [x] **0.1 Environment** — Node 26, deps, Chromium, `config/targets.json`
- [x] 0.2 Smoke tests — mock bank verified end to end via curl; Claude call still unrun
- [x] 0.3 Mock bank app — sibling repo, all 5 states reachable deterministically
- [x] 0.4 Artifact schema — Zod, roundtrip-tested
- [x] 0.5 Perception + actions + guardrail — ranked locators, `checkAllowed()` in every primitive
- [x] 0.6 **Real discovery run** — `claude-sonnet-5` recorded `lookup-member-savings-account`
      v2 against the live mock bank; replay-verified (10001 → SUCCESS, 99999 →
      BUSINESS_OUTCOME); evidence committed, incl. the v1 HARD_FAILURE and an escalated run
- [x] 0.7 Replay executor — 4-way outcome contract, verified against the live target
- [x] 0.75 Guardrails, expanded — allowlist / risk / redaction, config-driven
- [ ] 0.8 Escalation & handoff
- [~] 0.85 Evidence & logging — `RunLogger` built in 0.6, wired into discovery + replay;
      escalation wiring remains
- [ ] 0.9 Operator console + demo UI
- [ ] 0.95 Stretch: capability interface + approval gating
- [ ] 1.0 REPORT.md + final evidence pass

**49 tests passing** (`npm test`). Replay was built and verified *before* discovery, on
purpose: it needs no LLM, so proving it correct first means the real discovery run has
exactly one new variable in it. Phases 0.6 and 0.7 are therefore out of numeric order.

~70% of real coding effort is in 0.3, 0.5, and 0.6. Everything after 0.7 gets progressively
lighter; 1.0 is writing, not code. **Slow down and review every diff from 0.6 onward** — those
are the pieces to defend in an interview.
