# CLAUDE.md — Working Agreement

**Assignment:** interface.ai take-home — Computer-Use Automation System (the PDF in the
repo root is the source of truth). **Deliverables:** public repo + `/README.md` +
`/REPORT.md` (7 fixed headings) + `/evidence/`.

> The model discovers once. The recording becomes a reusable, typed **capability**.
> Deterministic replay is how a production agent invokes it later — no LLM in the loop.

## Two apps, two repos — never conflate them

`../mock-bank` (port 3001) is the **target** being automated: a sibling repo, ugly on
purpose, reached only over HTTP through a real browser. This repo (port 3000) is the
**system**. `tests/boundaries.test.js` enforces the separation: no SDK on the replay path,
no cross-repo imports, no hardcoded hostnames (targets live in `config/targets.json`),
and only `engine/actions.js` calls the policy gate.

## Stack

Plain JS on Node 20+ (ESM, no build step). Zod (contracts), Playwright (browser),
`@anthropic-ai/sdk` with `claude-sonnet-5` (discovery only), Express 5 (control plane),
better-sqlite3 (runs/interventions) + JSON files (artifacts), `node --test`, vanilla JS
console in `public/`. API baseline: `output_config: { effort: "medium" }`,
`max_tokens: 16000`, thinking left on (Sonnet 5 default), viewport capped at 1024×768.

## Conventions

- One file per unit, one job each; 2–3 line header saying what it does and hands off to.
- Ridiculously simple over clever — every line defensible out loud in an interview.
- **One shared action layer**: agent, replay, and human all act through
  `src/engine/actions.js`. A second implementation of "click" anywhere breaks the thesis.
- Session handoff needs the explicit `owner` flag AND the per-run mutex
  (`src/agent/escalation.js`) — single-threaded Node does not make interleaving safe.

## Non-negotiables (check before claiming anything done)

1. Discovery runs are real LLM calls against a live surface; evidence in `/evidence/`.
2. Replay never calls the LLM — not for recovery, fallback, or classification.
3. `BUSINESS_OUTCOME` ≠ `HARD_FAILURE`, and `/evidence/` proves it.
4. Every action — agent, replay, human — passes the policy gate first.
5. Escalation operates on the same live session.
6. No credentials or raw PII in artifacts, logs, or the repo — names and shapes only.
7. Artifacts are genuine recorded output. Never hand-edit one; fix the recorder and re-run.

## Status

**Built and verified (57 tests):** mock bank, artifact schema/store, perception + ranked
locators + primitives, guardrails (allowlist/risk/redaction), deterministic replay with the
four-way contract, the real discovery runs (artifact v1–v4 + evidence), evidence logging,
escalation & handoff (pause → human on same session → resume, live-demoed), operator
console, CLIs (`discover`, `replay`).

**Remaining:** see [PLAN.md](PLAN.md) — stretch-goal decision, then REPORT.md + final
evidence pass + submission.
