# PLAN.md — Remaining Work

1. **Update the README.** It is the most out-of-date file in the repo and describes a
   system that no longer exists: `npm test` and "81 tests" (the suite was removed),
   `src/db/` and SQLite (replaced by the filesystem — a run IS its folder), `config/` and
   `targets.json` (apps live in `artifacts/<app>/config.json`), `data/creds/` and personas
   (removed). It must match what the code actually does now: register an app, record a
   run, replay it, approve it, invoke it from the catalog or from an agent
   (`npm run agent-demo`), open the report. Also document the caller badge and the
   Permissions section on the app form.

2. **Re-record the evidence set.** Record fresh with the current code so /evidence/ shows
   the safety layer active (`redacted: true` lines) and the approval gate in the loop.
   Needs, each readable standalone: a discovery run, a replay SUCCESS, a replay
   BUSINESS_OUTCOME, and an escalation run (paused → human → resumed). Never hand-edit
   evidence.

   The committed `login-and-open-study-space` recording is currently broken and must be
   re-recorded: its step-1 checkpoint is `element_exists "input[value]"`, a selector that
   means "an input with a value attribute" and matches nothing, so every replay is a
   HARD_FAILURE. The engine caught it and now reports the reason — but the recording
   itself is the demo, so it has to be a good one.

3. **Write REPORT.md last, after everything above is built and tested.** One to three
   pages under these exact seven headings: Architecture, Artifact schema, Determinism &
   error handling, Heterogeneity & multi-tenant, Escalation & handoff, Safety, Cuts.

   Cuts to defend: the brief allows one or two stretch goals. Two are built — the agent
   catalog and the approval gate — and they are one idea: a human approves a recording,
   an agent can then call it by name, and the system tracks whether it keeps working.
   Cut on purpose: code generation (a generated script is a second thing that can click,
   and it drifts from the engine while losing the ranked locators, the outcome contract,
   and the evidence trail); assisted LLM fallback on replay (it puts the model back in the
   replay loop, which is the one thing determinism forbids, and human escalation covers
   the same failure honestly); canonicalization / cross-tenant reuse (designed not built —
   `tenant_overrides` is in the schema, and 3.7 asks for the design; the seam worth
   pointing at is that `base_url` lives in the app config rather than the recording, so
   aiming one `app_id` at another deployment replays the same capability against a
   different tenant); multi-run stability sweep (the rolling `confidence` counter already
   accumulates the same signal across real replays). Also disclose that multi-tenant and
   desktop surfaces are design-only, as the brief permits.

   Also for Cuts, both found while building: the control plane has **no authentication at
   all** — approval controls which capabilities an agent sees, never who may ask, so a
   real deployment needs a key on `/api/capabilities`. And a **capability lives inside the
   run folder that produced it**, so deleting that run deletes the recording; approved
   capabilities are refused deletion for exactly that reason.

---

## Done

- Safety layer restored — allowlist gate, redaction, risk (`338f3fd`)
- Stretch goals 1 and 3 — agent catalog + an approval gate that bites (`e512331`)
- Console: one row grammar, chips, per-action columns, removal model (`2956b97`, `f914e3c`, `e89dedc`)
- An agent actually calling the catalog, in `examples/` (`112d101`)
- Caller badge on runs, and a failure reason that is never blank (`50f478c`)
- HITL: the human's channel back is language, not selectors (`a98efdb`)
- Escaped untrusted text; components share the fetch/error helpers (`c854e86`)
- Allowlist editable from the console app form (`c9dd6c1`)
- README rewritten to describe the system that exists (`d238290`)
- DESIGN.md: Mermaid diagrams whose boxes name the files that do the work
