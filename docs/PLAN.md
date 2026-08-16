# PLAN.md — Remaining Work

Conventions and non-negotiables in [CLAUDE.md](../CLAUDE.md).

## Where we stand

**The through-line works.** A goal in natural language → a real LLM run against a live
browser → a typed `goal.json` capability → deterministic no-LLM replay with the four-way
outcome contract → same-session human handoff → evidence for every run. Any app can be
registered from the console by URL.

**What the MVP restructure (`bfbd11e`) removed and what came back.** That commit dropped
the whole `src/policy/` layer — allowlist, redaction, risk — plus the capability catalog
and the test suite. The safety layer is restored (§1, done). The catalog is §3 below.

**Status against the brief's Section 3 (must-haves):**

| Requirement | State |
|---|---|
| 3.1 Goal-driven agent loop | Done |
| 3.2 Structured artifact | Done — typed, versioned, Zod-validated |
| 3.3 Deterministic replay + error taxonomy | Done — four-way contract, no LLM on the path |
| 3.4 Safety & policy guardrails | **Done (§1)** — was missing, now restored |
| 3.5 Evidence / observability | Done — transcript, screenshots, result.json per run |
| 3.6 Human-in-the-loop escalation | Works, but the operator surface is wrong (§4) |
| 3.7 Heterogeneity & scale (design) | Schema seams exist; the argument goes in REPORT.md |

---

## 1. Safety layer — DONE (commit `338f3fd`)

`src/policy/` restored and wired at one seam:

- **allowlist.js** — `checkAllowed()` opens every action primitive in
  [actions.js](../src/engine/actions.js), so the LLM path, the replay path, and the human
  operator path all pass the same gate. The app's own origin is not widenable by any
  prefix; a mid-run redirect off the allowlist stops the next action.
- **redact.js** — field-aware redaction at the point of logging. Sensitive fields log a
  shape (`<string:13>`), everything else logs its value, and an explicit `redacted` flag
  is written either way. Suffix match, so a derived env name (`EDORA_PASSWORD`) hits the
  `password` rule.
- **risk.js** — safe/risky classification plus the two approval predicates
  (`checkUnattendedAllowed`, `checkAgentInvocable`).
- Permissions are resolved onto the target in
  [app-config.js](../src/config/app-config.js) and written literally into every new config
  file, so an app's permissions are readable rather than inferred.

Remaining thread: the console's app form does not yet expose the allowlist fields (the API
accepts them). Small; fold into §5.

---

## 2. Stretch goal #3 — confidence & approval (finish it)

Already built: capabilities are born `draft`; `PATCH /api/artifacts/:id/status` promotes to
`approved`; the console has an Approve button; every replay folds its outcome into a
rolling `confidence: { runs, successes, last_outcome, updated_at }`
([store.js](../src/schema/store.js)).

Missing: **nothing consults `status` before replaying**, so "approved" is currently a label
rather than a gate. The enforcement point left with `src/api/capabilities.js`.

- Call `checkUnattendedAllowed()` in the replay entry path. A safe capability replays from
  the console freely (a human is watching); a **risky** one stays refused until approved.
- Refusal is a 403 carrying the predicate's reason, not a HARD_FAILURE — the run never
  started, so it says nothing about the recording's reliability.

## 3. Stretch goal #1 — agent-facing capability interface (finish it)

Already built: `GET /api/artifacts` returns `name`, `description`, `input_schema`,
`output_schema` — a tool definition in all but name — and `POST /api/artifacts/:id/replay`
invokes one with typed params.

Missing: the agent-facing surface itself, deleted in `bfbd11e`.

- `src/api/capabilities.js` — `GET /api/capabilities` (the catalog: **approved only**, via
  `checkAgentInvocable`) and `POST /api/capabilities/:id/invoke` (typed args in, four-way
  result out). Strictly narrower than the operator's `/api/artifacts` surface: what an
  autonomous agent can discover and call is an explicit human grant.
- `src/cli/invoke.js` + an `invoke` npm script — the demo the brief asks for ("show one
  being invoked").
- Console: a Catalog view showing what an agent would see, so approving a capability
  visibly moves it from invisible to callable.
- README currently documents `npm run invoke`, which does not exist. Fixed by this work.

## 4. HITL is the wrong shape — make the handoff natural language

**The problem.** The goal is written in plain English and the model reasons in plain
English, but the operator console asks a human to hand-assemble a Playwright-shaped step:
action type, locator kind, role, text, URL
([operator-console.html](../public/components/operator-console/operator-console.html)).
That inverts the premise. If a login needs a code from an email, the operator should not be
building locators — they should either drive the browser themselves or say *"the code is
481920, type it into the verification field"* and let the model do what it already knows
how to do.

**Most of this already works.** `resumeRun(runId, { note })` passes the note straight back
into the model's context as natural language, and the loop re-observes the live page from
whatever state it is in ([discovery.js:348](../src/agent/discovery.js#L348)). The run is
headed Chromium, so a human can already take the window and click.

**The fix is mostly deletion:**

- Make the note the primary control: a plain-English box — "tell the agent what you did, or
  what it should do next" — then Resume.
- Point the operator at the live Chromium window for manual work. It is the same session by
  construction, which is exactly what 3.6 asks for. Say so in the UI.
- Retire the locator/action/role/kind form. Keep `performManualAction` in
  [escalation.js](../src/agent/escalation.js) — human actions through the same five
  primitives, tagged `actor: "human"` in the evidence trail, is a real part of the design —
  but it stops being what the operator is asked to fill in.
- REPORT.md §5 argues the control-transfer model: owner flag + per-run mutex, and *why* the
  human's channel back is language, not selectors.

## 5. Codebase cleanup

- Delete dead code and stale docs. README documents commands that no longer exist
  (`npm run invoke`) and a `tests/` suite that was removed.
- One responsibility per file; each file's header comment states what it hands off to —
  hold that convention everywhere.
- Console components: one folder per component (`.html`/`.js`/`.css`), `mount(root)`,
  delegated clicks, `window` CustomEvents. No stragglers outside the pattern.
- HTML-escape interpolated values in components (goals and error strings are user text).
- Consistent error shape across API routes.
- Temporary test scripts live in the scratchpad and are deleted once green — this repo
  ships no test directory, and the README must not claim one.

## 6. Final evidence pass

Re-record the committed evidence set with the current code, so `/evidence/` shows the
safety layer active (`redacted: true` lines) and the approval gate in the loop. Each run
readable standalone: a discovery run, a replay SUCCESS, a replay BUSINESS_OUTCOME, and an
escalation run (paused → human → resumed). Never hand-edit evidence.

## 7. REPORT.md — last, after everything is built and tested

~1–3 pages, these exact seven headings: Architecture, Artifact schema, Determinism & error
handling, Heterogeneity & multi-tenant, Escalation & handoff, Safety, Cuts.

**Cuts to defend explicitly.** The brief says pick at most one or two stretch goals. Two
are implemented — the catalog and the approval gate — and they are one idea: *a human
approves a recording, then an agent can call it by name, and the system tracks whether it
keeps working.*

| Stretch goal | Decision |
|---|---|
| Agent-facing capability interface | **Built** (§3) |
| Confidence & approval | **Built** (§2) |
| Code generation from an artifact | Cut — a generated script is a second thing that can click, and it drifts from the engine. It also loses the ranked-locator fallbacks, the outcome contract, and the evidence trail. |
| Assisted LLM fallback on replay | Cut on principle — it puts the model back in the replay loop, which is the one thing determinism forbids. Human escalation covers the same failure honestly. |
| Canonicalization / cross-tenant reuse | Designed, not built. `tenant_overrides` is in the schema; 3.7 asks for the design, not the build. The real seam to point at: `base_url` lives in the app config, not the recording, so aiming one `app_id` at another deployment replays the same capability against a different tenant. |
| Multi-run stability sweep | Cut — the rolling `confidence` counter already accumulates the same signal across real replays; a sweep would only report it more loudly. |

Also for Cuts: the console does not yet expose allowlist editing; multi-tenant and desktop
surfaces are design-only, as the brief permits.
