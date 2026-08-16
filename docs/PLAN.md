# PLAN.md — Remaining Work

1. **Write REPORT.md last, after everything above is built and tested.** One to three
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

