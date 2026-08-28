# REPORT.md

Covers the core system. Pointing it at MERIDIAN CORE — what that took and what it
broke — is in [ADAPTATION.md](ADAPTATION.md).

---

## 1. Architecture

**Stack.** Node (it's all I/O). Express — one API the console, CLI and outside
agents all call. Playwright — auto-waits, and exposes the accessibility tree. Zod
— validates the recording on the way in *and* out, because a recording that fails
to load is a bug that only shows up in a demo. Anthropic SDK — reachable from the
discovery path only.

**Five actions.** `navigate`, `click`, `type`, `read`, `wait_for`. That's the
whole vocabulary. A `<select>` is handled inside `type` — picking an option is
putting a value into a control — because `fill()` throws on a select and an
`<option>` is never reported visible, so without that the five can't drive a
dropdown at all. The model can't invent a sixth. The AI, replay and a human
operator all use the same five, with no shortcut for any of them.

`checkAllowed()` is the first line of all five, inside the primitive rather than
in the callers, so no caller can forget it.

**Storage is files.** `evidence/` holds what runs did, `apps/` holds what apps
are. A recording is meant to be read and diffed in a code review, and a SQLite
row isn't reviewable without a client.

**One process, no queue, no retries.** A crash mid-run loses the run, and
concurrent runs would contend. Worth it to prove the design; the first thing to
change if this ran for more than one institution at a time.

---

## 2. Artifact schema

The focal point. A capability isn't a transcript — it's a typed, versioned
description of a flow an agent can call: ordered steps, how each control is found,
typed inputs and outputs, and proof it worked.

- **Locators are ranked candidate lists** — role, label, placeholder, text, then
  CSS last. Legacy apps have no test IDs, so any single selector is a guess.
  Replay takes the first that resolves; a candidate matching more than one element
  is rejected rather than guessed between.

- **A step declares its non-happy-paths** — a condition to look for and a code to
  return. Checked *before* the step's success check, because a wrong-path answer
  usually fails that check too.

- **A capability declares them at the top level too**, for endings that belong to
  the flow rather than one step. "No such member" surfaces one step *after* the
  search; an expired session lands anywhere. Flow-level rules are only consulted
  when a step is about to be called a failure — so they can't mask a step that
  worked — and a step-level rule wins where both match.

- **Any rule can be marked `escalate: true`.** "No such member" is something the
  caller acts on; "a supervisor must authorise this" isn't. Both are anticipated
  states, so both are declared the same way; the flag separates an answer from a
  handover.

- **A rule can carry a `detail` locator** naming where the app states its own
  reason. Detection wants a stable anchor — a legacy app renders one rejection
  banner for every kind of invalid transaction — but a caller told only
  `TRANSACTION_REJECTED` can't explain it. Reading it is best-effort, so it can
  never turn a classified outcome back into a failure.

- **Checkpoints take `{{parameter}}` references.** Without them, a control filled
  from a caller's parameter has no value known at record time and can't be
  asserted at all — which pushes the recorder into a checkpoint that passes
  whatever happened.

- **A `type` value comes from exactly one of three places**: `value_from` (the
  caller), `value_literal` (a safe constant), `value_from_env` (a credential's
  env-var *name*). The model chooses where a password goes and never sees one.

`input_schema` and `output_schema` are plain JSON Schema, generated at record
time, and double as a tool definition for a calling agent. A capability starts as
a **draft**; only a human promotes it to approved. Every replay updates a running
count of how often it held.

---

## 3. Determinism & error handling

`src/engine/replay.js` never imports the Anthropic SDK. That's the central claim:
the model works out the steps once, and after that every run follows a fixed list.
It's enforced by a test, not a convention.

**Five outcomes, and the order they're checked in is the design:**

1. A rule the step declared matches → return immediately, before checking whether
   the step technically succeeded. Checking success first would call "no such
   member" a hard failure, which is the most common mistake in this problem space.
2. The step's success check runs.
3. If it fails, a fixed list of known fixes (`recovery-table.js`) — dismiss an
   interstitial, reload through a transient error. Written ahead of time, capped,
   never improvised.
4. Still failing → the flow-level rules, then the host's runtime faults. Either
   can end the run `BUSINESS_OUTCOME` or `ESCALATED`.
5. Only then `HARD_FAILURE`, carrying the step, what was expected, what was seen,
   every candidate tried, and a screenshot.

A step that can't resolve its element at all gets one more look against the
declared outcomes first — "this member has no savings account" looks exactly like
a missing element.

**Faults are classified on HTTP status, not page text.** A legacy host states a
fault twice, in the status and in the page. The status can't be matched by
accident and doesn't move when the copy is reworded. `http_status` is a condition
type like any other, so this needed no new classification logic. Statuses are
declared once per app, because a runtime fault belongs to the host, not to
whichever flow was running — but a capability's own rules are consulted first,
since the same 400 can mean "this transfer was refused" or "a fault was injected."

**One judgement call worth stating.** A session expiring mid-flow is recoverable
for a read and not for a transfer: the run can't tell whether its post landed
before the session dropped, and guessing wrong duplicates an irreversible
transaction. So a read-only flow re-runs once and reports `RECOVERABLE`; a
mutating one stops and escalates.

**On UI drift.** Ranked candidates absorb small changes — a button moving, a label
reworded. Anything larger becomes a `HARD_FAILURE` with enough detail to fix it.
What isn't covered is the middle: a page drifting while still passing. I built a
detector for that and removed it (§7).

---

## 4. Heterogeneity & multi-tenant

**Surfaces.** `src/engine/perception.js` is the only file that looks at a page. It
reads the accessibility tree first, then visible text, then a screenshot. The tree
was chosen because it exists across a modern web app, a legacy one, and a desktop
app. The schema, the five actions and the replay logic don't know Playwright is
underneath. Supporting desktop means changing `perception.js` and adding a locator
kind — not the recording format or the engine.

**Tenants.** `target.app_id` names the *product*, not a customer or a URL; the
address and credentials come from `apps/<app>/config.json` at run time. So one
recording serves every customer on that product. Where two genuinely differ,
`applyTenantOverride()` patches only the steps an override names and can point
replay at a different origin. It runs before anything else, so the outcome
contract, the recovery table and the checkpoints never know a patch happened —
cross-tenant reuse is a seam in front of replay, not a second replay path.
Verified live: two local pages standing in for two installs with one button
relabelled, one recording, one override, both `SUCCESS`.

Drift between tenants shows up in the per-capability confidence counters. For
finding it earlier, `suggestRoutePattern()` flags id-shaped route segments
(`/members/12345` → `/members/:id`) as a suggestion for a human, and rewrites
nothing.

---

## 5. Escalation & handoff

Three things trigger it during discovery: the model calls `escalate` because it
doesn't know what to do, calls `abandon` because a human said the goal is
impossible, or the run hits its step limit.

The session **stays open**. Nothing closes the browser or starts a fresh one — the
run takes a screenshot, records why, and marks itself paused.

Two mechanisms transfer control. A flag says who *should* be acting; a per-run
lock enforces who *is*, because async handlers interleave even in one process.
Every human action goes through the same five primitives, tagged `human`, into the
same evidence trail. On resume, control flips back and the model continues from
the page's current state — the human can leave a note in plain English, since the
goal was written in English too.

The operator screen is deliberately minimal: a screenshot, the reason, and buttons
for the five actions. Not live co-browsing, which the brief allows. What's real is
the pause, the transfer and the resume, on the same session.

**Replay escalates differently, and should.** There's no live session to hand over
— no model is thinking, and the browser follows a fixed list. So it stops rather
than pauses: writes down the step, the URL and a screenshot, records `ESCALATED`,
returns. Waiting would hold a browser open for a caller that may be an unattended
agent with nobody watching.

Both paths are real. Told to record Place Account Hold as a teller, discovery hit
`SUPERVISOR OVERRIDE REQUIRED` and escalated rather than emit a recording for a
flow it can't finish — which settles a design question: a teller-operated hold
capability can't exist. And the supervisor recording, run with teller credentials,
escalates at replay.

---

## 6. Safety

**The allowlist.** `checkAllowed()` opens all five actions, identically for the
AI, replay and a human. It checks two things: is this action type permitted for
this app, and is the current page inside the allowed routes. The app's origin is a
hard boundary no prefix can widen, so a link off-site stops the next action.

**Risk.** Reads, waits and navigation can't change state. Clicks and typing are
risky if the route matches one the app owner marked as mutating. A risky
capability can't replay unattended until approved, and *nothing* is visible to an
outside agent until approved — an unapproved capability doesn't exist on that
surface rather than being refused on it.

That classifier used to be written down and never called, so risk was whatever the
recorder claimed about itself. Replay now re-derives it per step from config and
refuses a step riskier than its capability admits to being — checking the **live**
URL, because a legacy flow reaches a posting screen by submitting a form, not by
navigating to it.

**Redaction runs two directions**, because a credential escapes two ways. By
*name*, when a value would be written to a log. And by *value*, in text nobody
logged: a browser publishes a filled input's value in the accessibility tree, so
the moment the agent types a password it's in every later snapshot — which is both
what reaches the transcript and what the model is shown next turn. Without masking
that, "the model never sees a password" is true only until it types one. Values
are replaced by their shape, so an empty field is still distinguishable from a
real one. Run outputs are redacted into the run record too; the caller gets the
real value, the persisted copy keeps only the shape.

**Limits.** The gate reads the route, not the form — a wrong *amount* on an
allowed transfer screen passes. And it trusts each app's config to be complete: an
unmarked risky route isn't flagged. A safer version denies by default rather than
trusting configuration.

---

## 7. Cuts

- **No database.** Files on disk.
- **Desktop designed, not built.** `perception.js` is the seam (§4).
- **Operator console is a screenshot and buttons**, not co-browsing — allowed.
- **One process, no queue, no retries.**
- **From the adaptation:** no mid-flow session resume for flows that change data
  (resuming safely needs an idempotency key the target doesn't offer); transient
  retry is one reload, no backoff; no stability sweep across the seven
  capabilities. Details in [ADAPTATION.md](ADAPTATION.md).

**Stretch goals built:** an agent-facing catalog with a real outside caller
(`tests/agent-demo.js`); confidence and approval; multi-run stability (N real
replays through the same gate, aggregated — no test mode); code generation into a
standalone Playwright script; and cross-tenant reuse plus canonicalization,
covered in §4.

**Two I built and then removed.**

*A UI-drift detector.* Each replay compared a fingerprint of the page — the
deduplicated, sorted accessibility-tree lines — against a baseline, warning without
changing the outcome. It worked. I cut it because the fingerprint is a *set*, and a
set can't count: forty identical rows collapse to one line, so deleting
thirty-nine scores zero drift, and rows disappearing is exactly what an operator
would want flagged. It also discards indentation, which is how the tree encodes
nesting. A warning system quiet about the changes that matter most is worse than
none, because it invites trust it hasn't earned. Doing it properly means comparing
structure, not a bag of lines.

*Assisted fallback.* One model call per replay, only on a locator that wouldn't
resolve, only able to suggest another locator for the same element, schema-checked
and executed through the same gated primitives. It stayed inside every bound. I
removed it because I measured it: two recoveries out of four. Retrying until
something stuck would turn a bounded recovery into the open-ended loop the design
exists to avoid — so the honest options were a feature that works half the time or
no feature. A replay that fails deterministically, with the step, the selector,
everything tried and a screenshot, is more useful to whoever fixes it than one that
sometimes silently repairs itself. It also keeps the central claim absolute rather
than nearly true. Before putting it back I'd want a way to tell "the suggestion was
wrong" from "no locator could have matched", so the retry budget goes where it helps.

**Next:** make the allowlist deny by default instead of trusting each app's config
to be complete; field-level policy on money-moving steps; confirm-before-risky in
the chatbot.
