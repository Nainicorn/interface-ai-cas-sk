# plan.md — remaining stretch goals + 1 unique feature

Goal: finish the 4 stretch goals not built in the original submission, plus one new
feature (UI drift detector) not in the assignment at all. Each phase is small, tested,
documented, and committed on its own before the next starts.

Every feature gets: the core engine piece, a CLI entry (visually clear terminal output —
colored outcome marks, no new deps), an operator-console UI piece (reuses existing
badge/token system in ui/global/styles.css, no new design language), a test, and doc
updates (README demo command, REPORT.md stretch-goals paragraph, DESIGN.md if it touches
architecture).

## Phase 1 — Multi-run stability
- `src/api/stability.js`: `runStabilityCheck()` loops the existing `runReplay()` N times
  (same approval gate, same evidence trail, same confidence signal — no special-cased
  path) and `summarizeStability()` rolls the N results into `{runs, held, stability_pct,
  breakdown, run_ids}`.
- API: `POST /api/artifacts/:id/stability` in `api/artifacts.js`.
- CLI: `src/cli/stability.js` — `npm run stability -- --id <id> --runs 5 --param k=v`.
- UI: a "Run Nx" control in the capabilities row's expanded detail, rendering each run as
  an existing `.badge.SUCCESS/BUSINESS_OUTCOME/RECOVERABLE/HARD_FAILURE` chip.
- Test: unit-test `summarizeStability()` on canned outcome arrays (no browser needed).

## Phase 2 — Code generation
- `src/agent/codegen.js`: `generatePlaywrightTest(capability)` — walks recorded steps,
  emits a runnable `.spec.js` using the same locator-candidate fallback order replay uses,
  as a string.
- API: `GET /api/artifacts/:id/codegen` returns the file as text.
- CLI: `src/cli/generate.js` — `npm run generate -- --id <id> [--out file.spec.js]`.
- UI: a "Generate test" action in the expanded detail that downloads/shows the snippet.
- Test: generated output is syntactically valid JS (parseable) and contains one line per
  step.

## Phase 3 — Cross-tenant reuse (canonicalization)
- `TenantOverrideSchema` already exists in `schema/capability.js` but nothing applies it.
  Wire it into `engine/replay.js`: when a capability is replayed for a tenant that has an
  override entry, merge `step_overrides` (locator/url swaps) onto the base steps before
  executing.
- Add a `normalizeRoute()` helper (e.g. `/item/12345` → `/item/:id`) used at recording
  time to suggest a pattern — read-only suggestion, not automatic rewriting.
- A second demo app config (variant of an existing fixture) to prove one recording +
  one override replays against two slightly different targets.
- Test: replay the same capability against base and variant target, both succeed.

## Phase 4 — Assisted fallback
- Highest-risk of the four: `engine/replay.js` must keep importing zero AI (that
  invariant is tested in `tests/invariants.test.js` and must stay true). So this is a
  NEW file, `src/agent/assisted-fallback.js`, that WRAPS a replay: on a single step's
  HARD_FAILURE, it may make exactly one bounded, policy-checked LLM call scoped to just
  that step's locator resolution — never open-ended, never more than once, logged as its
  own evidence event distinguishable from a normal recovery.
- Off by default; opt-in per replay call (`{ assistedFallback: true }`), because this is
  the one piece of the system that reintroduces non-determinism, and turning it on must
  be a deliberate, visible choice — never silent.
- Test: invariants.test.js still passes unmodified (replay.js itself never imports the
  SDK); a fallback test with a stubbed model confirms it fires at most once and is logged.

## Phase 5 — Extra feature: UI drift detector
- At discovery time, each step's checkpoint state (the accessibility-tree snapshot from
  `perception.js`) already gets captured. Save a compact fingerprint of it alongside the
  step in the capability.
- At replay time, after a step succeeds, diff the current fingerprint against the
  recorded one. Meaningful drift (not just success/fail) gets logged as a `DRIFT_WARNING`
  evidence event — capability still reports SUCCESS, this is an early-warning signal, not
  a new failure mode.
- UI: a small drift indicator badge on a capability row when its last replay had drift.
- Test: two fingerprints of clearly different pages flag drift; two near-identical ones
  don't.

## Docs (rolling, updated as each phase lands)
- README: demo command per new feature.
- REPORT.md: rewrite the "Cuts" section paragraph for whichever of the 4 stretch goals
  just got un-cut; add the drift detector under "Beyond the core requirements."
- docs/DESIGN.md: only if a phase changes an architectural boundary (Phase 3 and 4 do;
  1, 2, 5 mostly don't).

## Order & rationale
Smallest/lowest-risk first so there's always a working, committed state to fall back to:
1 (stability) → 2 (codegen) → 3 (cross-tenant) → 5 (drift) → 4 (assisted fallback, riskiest).
