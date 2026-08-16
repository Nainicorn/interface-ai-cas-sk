# PLAN.md — Remaining Work

Done so far: safety layer restored (commit 338f3fd), stretch goals 1 and 3 finished
(e512331), console row styling and tab explainers (2956b97).

1. **Fix HITL so the handoff is natural language.** The operator console asks a human to
   hand-assemble a Playwright step: action type, locator kind, role, text, URL. The goal
   is written in plain English and the model reasons in plain English, so this inverts the
   premise. Most of the fix already exists: `resumeRun(runId, { note })` passes the note
   back into the model's context as language, and the loop re-observes the live page
   (src/agent/discovery.js:348). The run is headed Chromium, so the human can already take
   the window. So: make the note box the primary control, point the operator at the live
   browser window for manual work, and retire the locator form. Keep `performManualAction`
   in src/agent/escalation.js — human actions through the same five primitives, tagged
   `actor: "human"` in the evidence, is real design — it just stops being what the operator
   is asked to fill in.

2. **Clean up the codebase.** Delete dead code and stale docs (README still describes a
   `tests/` suite that was removed). One responsibility per file, with each file's header
   comment naming what it hands off to. Console components stay one folder each
   (.html/.js/.css) with `mount(root)`, delegated clicks, and window CustomEvents — no
   stragglers. Escape every interpolated value; use the shared helpers in
   public/global/ui.js rather than per-component copies. One error shape across all API
   routes. Temporary test scripts live in the scratchpad and get deleted once green; this
   repo ships no test directory and the README must not claim one.

3. **Expose the allowlist in the app form.** The API accepts `allowlist`,
   `risky_route_patterns`, and `redact_fields` (src/api/targets.js), but the console's app
   editor does not show them, so an operator cannot narrow permissions without a text
   editor. Small, and it makes the safety story demonstrable rather than asserted.

4. **Update the README.** It documents the demo path end to end and must match what the
   code actually does after 1–3: register an app, record a run, replay it, approve it,
   invoke it from the catalog, open the report.

5. **Re-record the evidence set.** Record fresh with the current code so /evidence/ shows
   the safety layer active (`redacted: true` lines) and the approval gate in the loop.
   Needs, each readable standalone: a discovery run, a replay SUCCESS, a replay
   BUSINESS_OUTCOME, and an escalation run (paused → human → resumed). Never hand-edit
   evidence.

6. **Write REPORT.md last, after everything above is built and tested.** One to three
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
