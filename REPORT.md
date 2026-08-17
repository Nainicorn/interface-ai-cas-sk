# REPORT.md

## High-Level Description

A computer-use automation system designed for legacy bank apps that have no API. An AI agent "discovers" the app to figure out how to perform a specific task (user given goal).

If the agent is successful the flow gets saved as a typed, versioned "capability" that can run with no model involved at all, as it is just a replay of recorded steps (cost and time efficient).

If either the agent or the replay gets stuck, a human can take over during the live session and can either hand back control, manually interact with the session, or give the agent some extra guidance.

Diagrams of the entire flow of the application are in [docs/DESIGN.md](docs/DESIGN.md).

---

## 1. Architecture

### Stack
- Node
- Express
- Playwright
- Zod
- Anthropic SDK

There are only 5 actions an agent can call — `navigate`, `click`, `type`, `read`, `wait_for`, all defined once in `src/engine/actions.js`. I didn't pick five as a round number; I built up from zero. An agent driving a browser needs to move (`navigate`), needs to look (`read`), needs the two ways of mutating a page a human operator has (`click`, `type`), and needs one way to wait on a condition without touching anything (`wait_for`). That's the whole vocabulary of operating a web UI, and it's deliberately closed — the model doesn't get to invent a sixth action, and neither does replay. Both call through the exact same dispatch table in `actions.js`, and so does the human operator during a handoff. One action layer, three callers. If a reviewer ever finds a second implementation of "click" anywhere in this repo, the architecture claim is false.

Every one of those five functions starts with `checkAllowed()` — the policy gate — before it touches the page. That's the whole safety model in one sentence: there's one gate, it's the first line of every primitive, and no caller can forget to call it because it isn't optional.

When a user wants to test the agent, they must provide a set of important information (name of the app for the test, url of app, any required information like username/password, and the goal the agent should achieve). This can be manually done in `artifacts/<app>/config.json` if the user is using the CLI for testing, or through a pop-up modal via the UI. Once the information is given, the agent is able to use it to discover and explore the app to accomplish the given goal with the given credentials and any necessary permissions. The completed discovery run is stored under `evidence/<app>/<kind>/<stamp>/`, which holds a step-by-step log, screenshots, whether the run succeeded, a result summary, and other useful metadata. The recording itself is saved as `goal.json`.

I chose not to use a database, just to have the structure be as clean as possible — it needed to be readable by a user with no special tool (folder names sort by time). The recording living right inside the run folder that produced it is deliberate too — the capability and the proof that it actually worked are the same artifact. A folder with a `goal.json` in it is, by definition, one that passed its checks, which are taken care of by the code under `/src`.

The other big architectural call is single process, synchronous where possible, no queue. The assignment is explicit that it doesn't reward scaling infrastructure, and a take-home evaluated by reading the code shouldn't be hiding its logic behind a message broker. Everything — the discovery loop, replay, the escalation handoff, the HTTP API — runs in one Node process against one Playwright browser at a time per run. The trade-off is real (this wouldn't survive a process crash mid-run, and there's no horizontal scaling story), but it's the right trade for a system whose job right now is to prove the design is correct, not that it's fast.

---

## 2. Artifact schema

The schema lives in `src/schema/capability.js`, as a Zod definition, and it's the thing I spent the most time on because the brief says it's a focal point. A capability is *not* a transcript of what the model did — it's a typed, versioned, reviewable description of a flow that an agent can call. It needs: the ordered steps, how each control is identified, typed inputs, typed outputs, and a checkpoint. The raw model transcript lives separately in `evidence/{run_id}/` and is deliberately decoupled from it.

A few decisions worth explaining:

- **Locators are ranked lists, never a single selector.** The target environment has no test IDs, so any one selector is a guess. Each step carries an ordered `candidates` array (role, label, placeholder, text, css — most robust first), and replay tries them in order, accepting the first that resolves to exactly one visible, enabled element. A candidate that matches more than one element is rejected outright, never silently `.first()`-ed — guessing which of several matches is "the right one" is how automation quietly does the wrong thing to the wrong record.
- **Business outcomes are declared, per step, not inferred.** This is what makes "no such member" a first-class answer instead of a crash. A step can list `business_outcomes`: a condition to detect and a stable code to return if it's seen. Replay checks these *before* the step's own success checkpoint, because a legitimate non-happy-path will usually fail that checkpoint too.
- **`target.app_id` names the vendor product, not a tenant or a URL.** That indirection is the whole multi-tenant story — see section 4.
- **Credentials never enter the schema.** A `type` step's value comes from exactly one of `value_from` (a caller parameter), `value_literal` (a non-secret constant), or `value_from_env` (an env var *name*). The model chooses where a password goes; it never sees what the password is.
- **One flat locator shape instead of a discriminated union**, on purpose — artifacts get reviewed by humans, and a flat object reads cleanly in a diff.

`input_schema` and `output_schema` are plain JSON Schema (produced by `z.toJSONSchema()` at record time), which is what lets the exact same capability double as an Anthropic tool definition — that's the mechanism the agent-catalog stretch goal uses (section 7).

A capability is versioned (`schema_version`, `version`), and carries a `status` of `draft` or `approved`. It's born `draft`; promotion is the one act the system never grants itself — a human has to do it. It also carries a rolling `confidence` block (`runs`, `successes`, `last_outcome`) that every replay updates, which is the signal the approval gate and a future drift check would read.

---

## 3. Determinism & error handling

`src/engine/replay.js` never imports the Anthropic SDK. That's not a style choice, it's the central claim the whole system rests on: the model discovers once, and everything after that is a typed function call, same inputs → same steps → same outputs.

Every step resolves to one of four outcomes (`src/schema/enums.js`), and the order they're checked in is the part that actually matters:

1. **Declared business outcomes, first.** If the step's condition matches, return `BUSINESS_OUTCOME` immediately — before even looking at the step's own checkpoint. Checking the checkpoint first would report "no such member" as a `HARD_FAILURE`, which is the single most common way this class of problem gets got wrong.
2. **The step's success checkpoint.**
3. **If the checkpoint fails, one bounded pass through a small recovery table** (`src/engine/recovery-table.js`) — a handful of hand-declared, exact-match rules for things like a dismissible notice banner or a transient gateway error, each capped to fire once per step. This is deliberately a lookup table and not the model improvising a fix — replay must never call an LLM, including to recover from something. If a rule applies and the re-check then passes, the outcome is `RECOVERABLE`.
4. **Still failing → `HARD_FAILURE`**, carrying which step, what was expected, what was actually observed, every locator candidate that was tried and why each one lost, and a screenshot.

A locator that matches nothing is also given one more chance before being called a failure: it's checked against the step's declared business outcomes, because "this member has no savings account" often shows up on screen as an element that simply isn't there. Reporting that as a crash would repeat exactly the mistake this whole outcome contract exists to prevent.

Because the target apps are stable, slow-changing UIs (the brief is explicit about this), the interesting failures aren't constant layout drift — they're runtime conditions. The ranked-candidate locator strategy is what absorbs *minor* drift (a renamed label, a moved button still findable by role) without needing a re-record. Anything more structural than that surfaces as a `HARD_FAILURE` with enough detail — every candidate tried, the DOM ancestor chain of whatever it accidentally matched — to fix the recording rather than guess at it.

---

## 4. Heterogeneity & multi-tenant

I only implemented against one surface (a Playwright-driven web app), but the design has two seams built in on purpose so the story isn't retrofitted later.

**Surface abstraction.** `src/engine/perception.js` is the one file that knows how to *look* at the current surface — right now that means the accessibility tree first, visible text, and a screenshot for grounding. I picked the accessibility tree as the primary channel specifically because it's the one representation that exists on a modern web app, a frameset-and-nested-tables legacy web app, *and* a native desktop app. The recorded flow itself (the schema, the five action names, the locator kinds) says nothing about Playwright. Swapping the surface — say, to an OS-level accessibility API for a desktop app — means rewriting `perception.js` and the `buildLocator()` switch in `engine/locator.js`; the schema, the replay engine's outcome logic, and the discovery loop's tool contract don't change.

**Multi-tenant reuse.** `target.app_id` in a capability names the vendor product, not a URL and not an institution — the actual base URL and credentials live in `artifacts/<app>/config.json`, resolved at replay time. That indirection is what lets one recording, in principle, run against any tenant configured under that same app id. For the harder case — two tenants running the same product with real differences (a renamed field, a different base path) — the schema already has `TenantOverrideSchema`: a per-tenant diff of `step_overrides` (locator or url swaps by step index) layered on top of one base recording, rather than a whole new recording per tenant. I did not build the override-application logic in `replay.js` in this slice — it's declared in the schema but not yet read — because the brief is explicit that it doesn't expect multi-tenant to actually be built, only that the abstractions not paint me into a corner. Drift detection reuses the `confidence` block already on every capability: a tenant whose replays start failing shows up as a dropping success rate, which is the signal to add a targeted override rather than re-record from scratch.

---

## 5. Escalation & handoff

This is the piece I spent the second-most time reasoning about, because "the human operates the same live session" is a much harder requirement than "show a screenshot and a resume button."

**Detecting stuck.** Three paths lead here: the model calls an explicit `escalate` tool when it genuinely doesn't know what to do next; it calls `abandon` when a human has already told it nothing can be done (so a truly impossible goal ends with a verdict instead of escalating forever); or the discovery loop simply runs out of its step budget.

**Routing.** `agent/escalation.js` owns a live-session registry, one entry per run. Pausing (`pauseForIntervention`) captures a screenshot and context (goal, url, why it stopped), writes an intervention record, and — critically — leaves the Playwright page open. It does not close the browser and it does not start a new one; it flips an ownership flag to `'paused'` and parks the discovery loop on an unresolved promise.

**Control transfer.** Two mechanisms do this together, because either one alone is wrong. An explicit `owner` field (`'agent' | 'paused' | 'human'`) says who *should* be acting. A per-run async mutex (`RunLock`) says who actually *is* — Node is single-threaded, but async handlers interleave at every `await`, so "single-threaded, so it's fine" isn't actually true here; an agent action and a human click really can otherwise both be mid-flight on the same page. Every manual step the operator takes (`performManualAction`) goes through the exact same `engine/actions.js` primitives the agent uses, under that lock, tagged `actor: 'human'`, and lands in the same evidence trail as everything else.

**Handing back.** `resumeRun` flips ownership back to `'agent'` and resolves the promise the discovery loop has been parked on. The loop re-observes whatever state the human left the page in and continues from there — the channel back is plain English (an optional note from the operator), because the goal was written in English and the model reasons in English, not selectors.

**What's mocked, on purpose.** The operator surface itself (`public/components/human-in-the-loop/`, `live-viewer/`) is deliberately bare — a screenshot, the reason, and buttons for the same five primitives, not real-time co-browsing. The brief scopes that out explicitly. What's real is the mechanism underneath it: pause, cede control, resume, on the same session, with a clear answer to "who is in control right now."

---

## 6. Safety

Every action primitive is gated by `checkAllowed()` (`src/policy/allowlist.js`) before it touches the page — the LLM path, replay, and the human operator all pass through the identical check, because it's the first line inside `actions.js` rather than something each caller remembers to call. Two things are checked: whether this *action type* is permitted for the app at all, and whether the current route falls inside an allowed prefix on the app's own origin. The origin itself is the hard edge — no prefix list can widen past it, so a redirect off-site stops the very next action instead of being noticed after the fact.

Risk is classified separately (`src/policy/risk.js`), because "click" is safe on a search button and risky on a submit button, and the action type alone can't tell those apart. Reads, waits, and navigation are always safe (they can't mutate state); `click` and `type` are risky if the current route matches one of the app's declared `risky_route_patterns`. A risky capability cannot replay unattended until a human has explicitly approved it (`checkUnattendedAllowed`), and — separately, more strictly — no capability of any risk level is visible to an outside AI agent at all until it's `approved` (`checkAgentInvocable`): a draft isn't refused to an agent, it's invisible, which felt like the more honest failure mode than a 403 an agent could learn to work around.

Redaction (`src/policy/redact.js`) happens at the point of logging, not the point of use — the live browser still gets the real password, the evidence trail never does. Field names are matched against an always-redact list (password, token, ssn, pin, …) plus whatever an app's config adds, and credential env-var names are auto-added to that list so `MY_APP_PASSWORD` gets caught by the same rule as `password`. A redacted value isn't dropped, it's shape-described (`<string:13>`, `<numeric-string:5>`) — enough to tell an empty field from a truncated one while debugging a replay, without keeping the actual data.

**Limits.** This is allowlist-and-pattern enforcement, not semantic understanding — an app owner has to actually think about which routes mutate state and declare them, and a risky action on a route nobody thought to pattern won't be caught by anything except the action-type check. That's a real gap for a first version; the honest fix is a stricter default (deny-by-default on anything not explicitly read-only) rather than trusting every app's config to be complete, which I'd want to tighten before this touched anything real.

---

## 7. Cuts

- **No database.** `evidence/` and `artifacts/` on disk are the whole store. Simpler, and readable without tooling — the trade-off is no concurrent-write safety beyond the one process this runs in.
- **Multi-tenant and desktop are designed, not built**, per the brief's own scope note (§3.7). `TenantOverrideSchema` exists and `perception.js` is the seam, but nothing applies a tenant override at replay time yet, and there's no desktop/accessibility-API backend.
- **The operator console is intentionally mocked** — a bare screenshot-and-buttons surface, not real-time co-browsing, which the brief explicitly allows.
- **No LLM-assisted replay recovery.** The recovery table is a small, fixed, hand-declared list. I considered the "assisted fallback" stretch goal and decided against it for this slice — "replay never calls an LLM" is the one invariant I didn't want to put an exception into, even a bounded one, until the rest of the system had proven itself first.
- **No route canonicalization** (e.g. `/item/12345` → `/item/:id`). A step's *value* is parameterized (`value_from`), but the *route itself* isn't yet templated across recordings.
- **No dedicated flakiness score.** The rolling `confidence` counter on every capability is the seed for one, but nothing runs a capability N times and reports a stability percentage yet.

What I did build past the core requirements, picking depth over breadth as the brief asks: the **agent-facing capability interface** (`src/api/capabilities.js` plus `tests/agent-demo.js`, which is a real outside caller — no import from `src/` — that lists the approved catalog, hands it to Claude as tools, and lets the model invoke one over HTTP) and the **confidence & approval gate** (draft → approved, with unattended replay of anything risky blocked until a human promotes it).

Next, with more time: actually apply tenant overrides in `replay.js` and demonstrate one base recording running against a second, slightly different config as a stand-in for two tenants; a real flakiness signal off of repeated replays; and a tighter, deny-by-default posture on the allowlist instead of relying on each app's config being complete.
