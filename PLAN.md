# PLAN.md — Remaining Work

Conventions and non-negotiables in [CLAUDE.md](CLAUDE.md).

**The pivot:** the evaluator receives *only this repo* — no target app ships with it. The
submission flow is bring-your-own URL: register a target (friendly name, base URL, goal,
credentials file), record a fresh run, replay it, review every run in the console.
Decisions locked: no generated Playwright script (the typed artifact **is** the recording;
code generation stays a declined stretch goal), and credentials are a gitignored
multi-login personas file — different logins can surface different app-side permissions as
`BUSINESS_OUTCOME`s. The committed `/evidence/` runs (recorded against the local dev
fixtures) remain the assignment-required proof of real LLM discovery.

## 0. Where we stand vs. the brief

**Met (§3 must-haves):** real LLM discovery loop; typed/versioned/Zod-validated artifact;
deterministic no-LLM replay with the four-way contract (`/evidence/` proves
`BUSINESS_OUTCOME ≠ HARD_FAILURE`); allowlist/risk/redaction guardrails enforced by
boundary tests; per-run evidence; same-session escalation with resume.
**Exceeded:** a real operator console (the brief allows a mock), live viewer, both
permitted stretch goals (agent catalog + confidence gating), two dev fixtures, 63 tests.
**Gaps:** REPORT.md — the highest-weighted unmet deliverable — still unwritten; a redaction
bug leaks credential values into evidence transcripts (§1 — found during planning, one-line
fix); no permission-denied `BUSINESS_OUTCOME` in evidence yet (personas make one
recordable); and the evaluator cannot yet register a target, browse runs, or open a run
report — phases 2–4.
**Scope guard:** the brief explicitly does not reward breadth. Every UI item below is a
thin projection over data that already exists on disk, built on existing components and
conventions — nothing new is invented on the replay path.

## 1. Redaction hardening — DONE (suffix match shipped, leak closed)

**A real leak:** committed evidence transcripts contain credential values in the clear —
e.g. `evidence/20260814-202419-replay/transcript.jsonl`:
`{"field":"MOCK_BANK_PASSWORD","value":"demo-password","redacted":false}` (10+
transcripts). Root cause: `isSensitive()` (`src/policy/redact.js:24`) compares normalized
names for *equality*, so the env-var name `MOCK_BANK_PASSWORD` (`mockbankpassword`) never
matches the rule `password` — and the replay path passes the env name as the field name,
so the typed value logs unredacted. Today's leaked values are fake fixture creds already
public in `.env.example`; once personas hold real logins this becomes a genuine leak.

- Fix: suffix match in `isSensitive()` —
  `norm(candidate) === target || target.endsWith(norm(candidate))`. Existing
  `tests/policy.test.js` assertions hold; add cases for `MOCK_BANK_PASSWORD` and
  `<APP>_USERNAME`.
- Defense-in-depth (lands with §2): registration unions the derived env names into the
  target's `redact_fields`.
- Evidence: per non-negotiable #7, never hand-edit — after the fix, re-record the affected
  evidence runs (§6) so the committed set shows `redacted: true`; REPORT.md's Safety
  section discloses the bug as found-and-fixed (more credible than rewriting history).

## 2. Target registration & personas (backend) — DONE

- `POST /api/targets` (new `src/api/targets.js`): validate, write `config/targets.json`,
  then `loadTargets({ reload: true })` (cache in `src/policy/allowlist.js`). The file gets
  env-var *names* only (`<APP_ID>_USERNAME` / `<APP_ID>_PASSWORD`, derived from the app
  id) — boundary test 4 already enforces the shape: `base_url`, non-empty
  `allowlist.route_prefixes` (caller must supply them — no silent allow-everything),
  non-empty `action_types` (default: the standard five), env-shaped credentials. The
  writer runs that same predicate on the composed block and refuses to write otherwise —
  it structurally cannot produce a config the suite rejects. A `credentials` key in the
  payload is explicitly rejected (secrets go to the personas file, never targets.json).
- Persona values land in gitignored `data/creds/<app_id>.json`, mode 0600
  (`{ "personas": { "<name>": { "username": "…", "password": "…", "note?": "…" } } }`);
  commit a `.example`. Secrets never enter targets.json, artifacts, transcripts, or the
  DB — the existing redaction path (post-§1) is unchanged.
- `persona` run parameter end-to-end: `POST /api/runs`, `POST /api/artifacts/:id/replay`,
  `POST /api/capabilities/:id/invoke`, and `--persona` on the `discover` / `replay` CLIs.
  A small resolver (new `src/policy/personas.js`) injects the chosen persona's values
  into the target's declared env names immediately before browser launch — discovery
  prompt, artifact (`value_from_env`), replay, and redaction all keep working untouched
  (`process.env` is read at time-of-use on both paths). No persona given → first declared
  persona if a creds file exists, else `.env` values exactly as today. An unknown persona
  name fails synchronously at `POST /api/runs` (400 listing known *names*), never as a
  background run failure. Known limitation, documented: env injection assumes one run at a
  time per process — fine for a single-operator console, called out in REPORT.md.
- **No `register-target` CLI.** The console form plus a README `curl` covers both
  audiences; a third CLI is exactly the feature breadth the brief punishes.
- Widen the `GET /api/targets` projection: add `base_url`, `default_goal` (new optional
  target field), and persona *names*. Never values.
- Tests: registration validation (including boundary-shape + cache reload), persona
  resolution, and a leak test — after a persona run, the value appears nowhere in
  targets.json, the artifact, or the transcript.

## 3. Run reports over HTTP — DONE

Evidence (`evidence/<run-id>/`: `transcript.jsonl`, numbered PNGs, `result.json`) is rich
but currently unreachable except a latest-screenshot route. Report building lives in a
pure, HTTP-free module (new `src/evidence/report.js`) so it tests without a server.

- `GET /api/runs/:id/report`: run row + target summary + `result.json` + ordered step list
  (replay: from `result.json` steps; discovery: projected from `transcript.jsonl` `action`
  / `model_turn` lines) + screenshot filename list + token usage. The transcript
  projection drops the size bombs (`ariaTree`, `visibleText`), truncates long strings,
  and caps event count — the page renders fast even for a long discovery.
- `GET /api/runs/:id/screenshots/:file`: PNG by name — run id and filename strictly
  pattern-matched (`^\d{3}-[A-Za-z0-9._-]+\.png$`, matching the logger's naming) plus a
  resolved-path prefix assert: no traversal. Harden the existing `GET /:id/screenshot`
  with the same run-id guard while touching the file (it currently joins `req.params.id`
  raw).
- Tests: report shape for one committed discovery and one replay folder; traversal guard
  (`../`, `a/b.png`, encoded dots).

## 4. Console redesign (the evaluator UI) — DONE

Header + left/right panels + a report page. Existing conventions throughout: one directory
per component (`.html`/`.js`/`.css`), `mount(root)`, polling with a change-key guard,
delegated clicks, `window` CustomEvents.

- `run-list` (left panel): every run newest-first with status badges (the `.badge` CSS
  already covers lifecycle *and* outcome vocabularies); click fires `run-selected`.
  Replaces the inert `run-status` table.
- `run-detail` (right panel): target friendly name, base URL, goal, params, persona,
  artifact link; actions: replay (with params) and **open report in a new tab**.
- `target-form`: register a target (name, URL, entry route, default goal, allowlist
  prefixes — required, the form says why — risky patterns, repeatable persona rows).
  Collapsed `<details>` card; on 201 it clears secrets from the DOM and emits a
  `targets-changed` event. `goal-form` gains a persona select and `default_goal` prefill,
  refetching targets on `targets-changed`.
- `public/report.html?run=<id>`: standalone read-only page — outcome banner, run config,
  steps with timings, screenshot gallery, discovery token usage. Pure projection of
  `/api/runs/:id/report`.
- `public/lib/api.js` (fetch + error unwrap) and an HTML-escape helper; apply the escape
  fix to components as they are touched (goals/errors are interpolated unescaped today).
- Keep as-is: `live-viewer`, `operator-console`, `capability-table` (catalog + approve).
  Delete `tabs/` and `run-status/` once superseded — nothing else imports them, and the
  boundary tests scan `src/` only.

## 5. REPORT.md (~1–3 pages, these EXACT seven headings)

1. **Architecture** — decisions + trade-offs.
2. **Artifact schema** — the shape and why.
3. **Determinism & error handling** — four-way contract, ranked locators, checkpoints,
   recovery table; drift secondarily.
4. **Heterogeneity & multi-tenant** — a11y-first perception seam; app_id = vendor product;
   tenant_overrides; drift detection via confidence. Target registration is the working
   demonstration of "point it at another app". Design-only parts, say so.
5. **Escalation & handoff** — stuck detection, owner flag + mutex, same-session control
   transfer, resume.
6. **Safety** — allowlist / risk / redaction / personas model and its limits, including
   the §1 transcript-redaction bug as found-and-fixed (with the re-recorded evidence).
7. **Cuts** — what was left out and why; what's next.

Material to mine: the v1→v4 artifact history (weak locator → HARD_FAILURE → ambiguity
samples → foreseen business outcomes), the escalation evidence run, the boundary tests.

Declined stretch options, for the Cuts section:

| Option | Why declined |
|---|---|
| Code generation from an artifact | Orthogonal to the through-line; a second executable "click" breaks the one-action-layer thesis. |
| Assisted LLM fallback on replay failure | On principle: it puts the model back in the replay loop. |
| Canonicalization / cross-tenant demo | Designed (tenant_overrides in the schema), not built. |
| Multi-run stability sweep | The confidence field already captures the signal. |

## 6. Final evidence pass

Re-record every evidence folder whose transcript contains an unredacted credential line
(post-§1 fix): same goals, same outcomes, now `redacted: true` — the recorder was fixed
and re-run, never the files (non-negotiable #7). Then confirm `/evidence/` contains, each
readable standalone: a discovery run (transcript, screenshots, result), a replay SUCCESS,
a replay BUSINESS_OUTCOME (not-found and no-savings), the escalation run (paused → human
actions → resumed → recorded), and the v1 HARD_FAILURE replay that motivated the locator
feedback. Optionally: one permission-denied `BUSINESS_OUTCOME` recorded with a restricted
persona (needs a fixture login with fewer rights; otherwise document it in Cuts as
designed-not-demoed).

## 7. Submission

README demo path re-verified from a fresh clone — register → record → replay → report must
work exactly as written — then push → email the repo URL (own line, application address,
no zip) to assignments@interface.ai.
