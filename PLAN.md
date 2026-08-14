# PLAN.md — Remaining Work

Everything below is what's left. Completed phases live in git history and the README;
conventions and non-negotiables in [CLAUDE.md](CLAUDE.md).

## 1. Stretch goals — pick at most one or two (pending decision)

The brief's options, with the two that fit this system best marked:

| Option | Fit |
|---|---|
| **Agent-facing capability interface** ★ | `GET /capabilities` (approved only, typed schemas) + `POST /capabilities/:id/invoke` — the system's stated purpose, demonstrated. Thin: load → replay → return. Plus `npm run invoke`. |
| **Confidence & approval gating** ★ | The safety complement: `updateConfidence()` called from inside replay (rolling success rate — the schema field already exists), `PATCH /capabilities/:id/status` for human draft→approved promotion. Risky drafts already refuse unattended replay. |
| Code generation from an artifact | Orthogonal to the through-line — decline in REPORT.md. |
| Assisted LLM fallback on replay failure | Decline on principle: it puts the model back in the replay loop. Say so in REPORT.md. |
| Canonicalization / cross-tenant demo | Designed (tenant_overrides in the schema), not built. |
| Multi-run stability sweep | The confidence field already captures the signal. |

## 2. REPORT.md (~1–3 pages, these EXACT seven headings)

1. **Architecture** — decisions + trade-offs.
2. **Artifact schema** — the shape and why.
3. **Determinism & error handling** — four-way contract, ranked locators, checkpoints, recovery table; drift secondarily.
4. **Heterogeneity & multi-tenant** — a11y-first perception seam; app_id = vendor product; tenant_overrides; drift detection via confidence. Design-only, say so.
5. **Escalation & handoff** — stuck detection, owner flag + mutex, same-session control transfer, resume.
6. **Safety** — allowlist / risk / redaction model and its limits.
7. **Cuts** — what was left out and why; what's next.

Material to mine: the v1→v4 artifact history (weak locator → HARD_FAILURE → ambiguity
samples → foreseen business outcomes), the escalation evidence run, the boundary tests.

## 3. Final evidence pass

Confirm `/evidence/` contains, each readable standalone: a discovery run (transcript,
screenshots, result), a replay SUCCESS, a replay BUSINESS_OUTCOME (not-found and
no-savings), the escalation run (paused → human actions → resumed → recorded), and the
v1 HARD_FAILURE replay that motivated the locator feedback.

## 4. Submission

README demo path re-verified from a fresh clone → push → email the repo URL (own line,
application address, no zip) to assignments@interface.ai.
