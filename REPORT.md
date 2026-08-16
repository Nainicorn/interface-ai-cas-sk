# REPORT.md

A computer-use system for back-office apps that expose no API. An LLM drives the app once
to work out how a task is done; that run is recorded as a typed, versioned capability; from
then on an AI agent invokes it through deterministic replay with no model in the decision
loop. When either path gets stuck, a human takes the same live session and hands it back.

Diagrams of every flow, with the file that does each job, are in [docs/DESIGN.md](docs/DESIGN.md).

---

## 1. Architecture

Node 20+, Express, Playwright, Zod, `@anthropic-ai/sdk`. One process. No database.

The load-bearing decision is that **there is exactly one action layer**. The LLM discovery
loop, the deterministic replay executor, and the human operator all call the same five
primitives in `src/engine/actions.js` — `navigate`, `click`, `type`, `read`, `wait_for` —
and there is no privileged variant. The model does not get to "just click"; it chooses
which primitive to invoke, exactly as replay does. If a reviewer finds a second
implementation of "click" in this repo, the design claim is false.

That one seam is what makes the rest cheap. The policy gate is the first line of each
primitive rather than something each caller remembers to call, so no caller can forget it.
Evidence is written at the same point, so agent, replay, and human actions land in one
trail in one format — an evidence trail that needed three readers would prove nothing.

**A run is a folder, not a row.** `evidence/<app>/<kind>/<stamp>/` holds `transcript.jsonl`,
screenshots, `result.json`, and — if the run produced one — the recording itself as
`goal.json`. I removed SQLite during the build: "reviewable" is an explicit requirement that a
database row does not satisfy without a client, and folder names sort chronologically, so the
history needs no index that could disagree with it. The recording sitting *inside* the run
folder is deliberate — the capability and the proof it once ran are one artifact, and a
discovery folder with a `goal.json` is by definition one that passed its gates.

**Two API surfaces over one store.** `api/artifacts.js` is the operator's: it shows drafts
and can promote, demote, replay, and delete. `api/capabilities.js` is the agent's, and is
strictly narrower — approved capabilities only, projected as tool definitions. Both funnel
into `api/run-replay.js`, so the approval gate, the run row, and the evidence cannot differ
by which door a caller came in.

**Known limits.** One process suits a single-operator console and not production: env-var
credential injection assumes one run at a time, and the session registry is in-memory, so a
restart orphans live runs (there is a boot reconciler for exactly that). Queued per-tenant
workers are the next step — and the brief explicitly says not to build that now.

## 2. Artifact schema

`src/schema/capability.js`, Zod, validated on write *and* on read. A capability is a
contract an agent can call, not a step list:

```
id, name, version, status: draft|approved, description
target:          { app_id, entry_route, tenant_overrides[] }
input_schema     JSON Schema — the typed args a caller supplies
output_schema    JSON Schema — the typed shape a caller gets back
risk_level:      safe|risky
steps[]:         { index, intent, action, locator, expected_outcome,
                   value_from | value_from_env | value_literal,
                   business_outcomes[], extract_as, risk }
success_checkpoint
created_from:    { run_id, model, recorded_at }
redaction_policy, confidence: { runs, successes, last_outcome }
```

Choices worth defending:

**`target.app_id` names the vendor product, not a tenant and not a URL.** The base URL lives
in the app's config, not in the recording. That single indirection is what lets one recording
serve many institutions running the same software.

**Every step carries `intent` in plain language.** The reviewability requirement is about
humans: `intent` is what makes a diff of a recording legible in a code review, and it costs
nothing at replay time.

**`expected_outcome` is per-step and mandatory.** A recorded click that isn't asserted is a
guess. The checkpoint vocabulary is deliberately tiny and exact-match — a fuzzy or
model-scored matcher would smuggle nondeterminism back into the no-LLM path.

**Three mutually exclusive value sources.** `value_from` binds a typed input parameter,
`value_literal` is a non-sensitive constant, `value_from_env` names a credential env var.
The third is why the model never learns a secret: it decides *where* a password goes and the
harness resolves *what it is* afterwards, so the recording is publishable as written.

**`business_outcomes` are declared on the step, not inferred at runtime** — see below.

**`confidence` is written back by replay.** The recording accumulates its own track record,
which is what the approval gate and the catalog read.

## 3. Determinism & error handling

Replay imports no LLM SDK. That is the invariant the whole claim rests on, and it is a
property of the file rather than a promise.

Determinism comes from three things. **Ranked locator candidates** — several ways to find
each control, ordered by expected robustness (role → label → placeholder → text → css), each
with a confidence and a note on when it should break; `engine/locator.js` tries them in
order. **Explicit waits** — a declared condition, never a sleep. **Checkpoints** — asserted
after every step and again at the end, so replay never assumes a click worked.

Every replay resolves to exactly one of four outcomes, and the second is the reason the
contract exists:

| Outcome | Meaning | Caller does |
|---|---|---|
| `SUCCESS` | Checkpoint verified, typed outputs extracted | Use the outputs |
| `BUSINESS_OUTCOME` | A legitimate answer — "no such member", "permission denied" | **Handle as data** |
| `RECOVERABLE` | A declared interstitial was cleared, execution continued | Nothing |
| `HARD_FAILURE` | Nothing matched | Debug: step, expectation, observation, locators tried, screenshot |

Collapsing "no such member" into a crash is the most common way this problem gets got wrong,
so business outcomes are **declared in the recording** and checked *before* the success
checkpoint — and again when a locator resolves to nothing, because a missing element is
sometimes the answer rather than a fault. The committed evidence shows this end to end: the
same capability returns `SUCCESS` for a known username and `BUSINESS_OUTCOME:
INVALID_USERNAME` for an unknown one, both HTTP 200.

Recoverable conditions live in a small declared table (`engine/recovery-table.js`) rather
than in a retry loop, because "dismiss the cookie banner" is knowledge about the app, not
control flow.

**A refusal is not a failure.** The approval gate runs before anything is written, so a
refused capability leaves no run row, no evidence folder, and no mark on its confidence.

**UI drift, secondarily.** Ranked candidates degrade rather than snap — losing a `data-*`
attribute falls through to role or label. Real drift surfaces as confidence decaying across
replays, which is the trigger to re-record or revoke; the evidence set shows a recording
whose record reached 0/2.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** Perception goes through the accessibility tree first — the one
channel that exists on a modern web app, a frameset-and-nested-tables legacy app, *and* a
native desktop app. The seam is `engine/perception.js` plus the five primitives: everything
above them is intent, ranked candidates, and conditions, none of which mention Playwright, so
swapping in an OS accessibility API changes those files and nothing in the schema or the
replay contract. Screenshot coordinates were rejected deliberately — a recording of pixel
positions is neither portable nor reviewable.

**Multi-tenant reuse.** `app_id` identifies the vendor product; the base URL lives in the
app config. So pointing one `app_id` at a different deployment replays the same recording
against a different tenant with no re-recording and no code change — that is a real seam
today, not a plan. For genuine per-tenant divergence (a renamed field, a different route),
`tenant_overrides` is in the schema: one base recording plus a small diff, rather than one
recording per institution. **It is designed, not built** — the field is validated and always
written empty. §3.7 asks for the design rather than the implementation, and building an
override-merging path I could not exercise against two real tenants would have been the
weaker use of the time.

Drift detection across tenants falls out of the same confidence signal — a tenant whose
replays start failing is visible without separate monitoring.

## 5. Escalation & handoff

**Detecting stuck** has two sources routed through one function: the model calls an
`escalate` tool when it cannot safely proceed, and the loop escalates on its own when the
step budget is exhausted.

**Control transfer uses two mechanisms, and both are needed.** An explicit `owner` flag
(`agent` | `paused` | `human`) says who *should* be acting; a per-run async mutex says who
*is*. Node is single-threaded, but async handlers interleave at every `await`, so an
operator's click and an agent's click can otherwise both be in flight on one page —
"single-threaded so it's fine" would be wrong.

**The same session, literally.** A paused run keeps its Playwright page open and parks the
loop on a promise. The human works in that same browser window; on resume the loop
re-observes the page in whatever state they left it.

**The channel back is language, not selectors.** This is the piece I changed late and would
defend hardest. The goal is written in English and the model reasons in English, so asking
an operator to hand-assemble an action type, a locator kind, and an ARIA role inverted the
premise — and was never necessary. The operator says *"the code is 481920, type it into the
verification box"*, and the note enters the model's context before it re-reads the page.
`performManualAction` still exists and still routes human actions through the same five
primitives tagged `actor: "human"`; it is simply not what a human is asked to fill in.

The committed escalation run shows one transcript reading llm → PAUSED → human → RESUMED →
llm → recorded.

## 6. Safety

**One allowlist gate, at the only place it could be bypassed.** `checkAllowed` opens every
action primitive, so it applies identically to the LLM, replay, and the operator. Two
independent checks — is this action *type* permitted, and is the route inside an allowed
prefix — because they fail for different reasons and a log should tell them apart. **The
app's own origin is not widenable by any prefix**: a link off-site stops the run. Permissions
are editable from the console, because an allowlist only a developer with a text editor can
narrow is not a control an operator actually has.

**Risky vs safe** is decided by two signals, either sufficient: the action type (reads and
navigation cannot mutate) and the route (an app declares which routes change state), because
"click" is safe on a search button and risky on a submit button. A **risky** capability is
refused unattended replay until a human approves it; a **safe** one replays freely from the
console, where a human is watching.

**Redaction happens at the point of logging, not the point of use** — the live browser gets
the real password, the transcript gets `<string:13>`, and an explicit `redacted` flag is
written either way so a reviewer can see the rule ran. Matching is by suffix, so the derived
env name `HEROKU_APP_PASSWORD` hits the `password` rule; over-matching is the safe direction.
Credential *values* never enter a prompt, a recording, or a log.

**Two limits I want to state plainly rather than have found.** First, redaction covers values
the system *types*, not what the app *displays*: page observations are captured whole, and
the committed evidence contains the practice site's credentials because that site prints them
on its own login page. On a real back-office screen showing customer PII this matters, and
the fix is observation-level redaction before the transcript is written — designed, not
built. Second, **the control plane has no authentication at all.** Approval governs *which*
capabilities an agent can see, never *who* may ask; it is safe only because it binds to
localhost. A real deployment needs a key on `/api/capabilities` before anything else.

## 7. Cuts

**Stretch goals: two, and they are one idea** — a human approves a recording, an agent can
then call it by name, and the system tracks whether it keeps working.

- **Agent-facing capability interface.** `GET /api/capabilities` returns approved
  capabilities projected as tool definitions (`name`, `description`, `input_schema`) and
  nothing about how the flow is implemented. A draft is *invisible* rather than
  listed-and-refused, because a catalog an agent cannot act on is noise in its context.
  `examples/agent-demo.js` gives that array to Claude as `tools` with no adapter and lets the
  model pick a capability and fill in its arguments; it lives outside `src/` and speaks only
  HTTP, because the agent is the consumer, not a component.
- **Confidence & approval.** Recordings are born `draft`; promotion is the only act the
  system never grants itself. Every replay folds its outcome into a rolling
  `confidence`. The gate bites in both directions: an approved capability cannot be deleted,
  and neither can the run holding it, until it is revoked.

**Cut on purpose:**

- **Code generation.** A generated script is a second thing that can click, and it drifts
  from the engine while losing the ranked-locator fallbacks, the outcome contract, and the
  evidence trail. The typed recording *is* the script.
- **Assisted LLM fallback on replay.** It puts the model back in the replay loop, which is
  the one thing determinism forbids. Human escalation covers the same failure honestly.
- **Canonicalization / cross-tenant reuse.** Designed, not built — see §4.
- **Multi-run stability sweep.** The rolling `confidence` counter already accumulates the
  same signal across real replays; a sweep would only report it more loudly.
- **A test suite.** An earlier one was removed in a restructure and I did not rebuild it.
  This is the cut I am least comfortable with: the invariants that matter (one gate, one
  action layer, no LLM SDK in replay) are checkable in a few assertions and should be
  enforced rather than asserted in prose. What a reviewer can run instead is the demo path
  end to end, and the committed evidence is the record of it having run.

**What I'd build next, in order:** authentication on the agent surface; observation-level
redaction; the invariant tests; then `tenant_overrides` applied at replay, exercised against
two real deployments of one product.
