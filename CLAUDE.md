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

**Built and verified (63 tests):** mock bank, artifact schema/store, perception + ranked
locators + primitives, guardrails (allowlist/risk/redaction), deterministic replay with the
four-way contract, the real discovery runs (artifact v1–v4 + evidence), evidence logging,
escalation & handoff (pause → human on same session → resume, live-demoed), operator
console, CLIs (`discover`, `replay`, `invoke`), and both stretch goals: the agent-facing
capability catalog (approved-only, invoke-by-name) and confidence & approval gating
(replay writes reliability back into the artifact; humans promote draft → approved).
Second target: `../mock-bank-spa` (modern SPA fixture, port 3002).

**Also built (75 tests):** the evaluator flow — targets start empty and are registered at
runtime (sidebar + Add-app modal, `POST /api/targets`; env-name credentials derived, persona
values in gitignored `data/creds/`), multi-login personas end-to-end (`persona` on every run
path + `--persona` CLI flags), per-run reports over HTTP (`/api/runs/:id/report`,
screenshots by name with traversal guards) and the standalone `report.html`, plus the
redaction suffix-match fix (env-var field names like `MOCK_BANK_PASSWORD` now redact).

**Remaining:** see [PLAN.md](PLAN.md) — REPORT.md, re-record the evidence folders that
predate the redaction fix, final evidence pass, submission. The evaluator gets only this
repo: bring-your-own target, no bundled fixture.
