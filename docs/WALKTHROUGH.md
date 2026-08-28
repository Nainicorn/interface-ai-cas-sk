# Walkthrough — demo script

A 12-minute walkthrough for the leadership demo, in three parts: **what I built
first → what I added after the callback → the challenge.** Part 3 is the one
that counts. If time runs short, cut Part 2, not Part 3.

**Before anyone is watching:** `npm start`, open `localhost:3000`, select
**MERIDIAN CORE** in the sidebar. Second terminal open in the repo. The target's
System Settings showing no forced injection. Backup recording ready in case the
network isn't.

---

## Part 1 — What I built first (4 min)

### The problem

> "Banks and credit unions have a long tail of internal apps with no API. The only
> way in is to drive the screen the way a person would. You could put an AI in
> front of every one of those — but then every transaction costs a model call,
> takes seconds, and can decide something different today than it did yesterday.
> That's not something you put near someone's money.
>
> So the shape is: let the AI figure it out **once**, write down what it learned,
> and replay that recording forever with no AI involved. The model discovers. The
> recording becomes a reusable capability. Deterministic replay is how a
> production agent actually calls it."

### The one rule everything else follows from

> "The replay engine never imports the AI SDK. Not behind a flag, not as a
> fallback, not for error recovery. It isn't a promise in a document — it's a test.
> Add that import and the build fails."

**Run:** `node --test tests/invariants.test.js`

> "Four invariants. Replay imports no AI. The safety gate opens every action.
> There's exactly one layer that touches a page. And the five primitives match the
> schema."

### The stack, and why

> "Node and JavaScript for the runtime, because the whole thing is I/O — a browser,
> an HTTP API, files — and nothing here is CPU-bound.
>
> **Playwright** for driving the browser. It waits for elements on its own, which
> removes the single biggest source of flakiness, and it exposes the accessibility
> tree directly, which turns out to matter a lot later.
>
> **Zod** for the recording schema. That one was load-bearing rather than
> convenient. The recording is the thing that gets replayed with no model watching,
> so it has to be validated on the way in *and* on the way out — a recording that
> would fail to load is the kind of bug that only surfaces during a demo. Zod also
> gave me versioning for free.
>
> And **no database.** Files on disk. A recording is meant to be read and diffed by
> a human in a code review, and a row in SQLite isn't reviewable without a client.
> Deliberately light — this is a prototype, and I wanted to understand every piece
> of it rather than assemble a stack I couldn't explain."

### The folders

| | |
| --- | --- |
| `src/schema/` | **The contract** — what a recording *is* |
| `src/engine/` | **The hands** — the only five ways to touch a page |
| `src/policy/` | **The rules** — allowlist, risk, redaction |
| `src/agent/` | **The AI part** — the one place a model decides anything |
| `src/api/` `src/cli/` | The surfaces: console, terminal, outside agents |
| `src/evidence/` | What every run did, on disk |
| `ui/` | The console, one folder per component |

> "Three files carry most of it. `schema/capability.js` is the typed shape of a
> recording — steps, how each control is found, typed inputs and outputs, the proof
> it worked. `engine/actions.js` is the five things anything can do to a page; the
> AI, the replay, and a human operator all go through those same five, and the
> safety gate is the first line of each — inside the primitive, not in the callers,
> so nobody can forget it. And `agent/discovery.js` is the only place a model
> decides anything at all."

### Live — the loop

**Run:** `npm run replay -- --id member-inquiry-search-by-last-name --param last_name=Hopper`

> "Fifteen seconds, no model, costs nothing. And that's a different surname than it
> was recorded with — it's parameterised, not a fixed script."

### A word on how I worked

> "I time-boxed this to about half a sprint on purpose. Not to rush it — to stop
> myself building ten features I couldn't stand behind. It's hard to own code you
> can't explain, and the brief was explicit that I'd have to defend any part of it.
> So the rule I set was depth over breadth: fewer things, each one I could argue
> for. That rule is also why two features you'll hear about in a minute got
> deleted after I measured them."

---

## Part 2 — Stretch goals, after the callback (3 min)

> "I went back and did five of the six. What I didn't expect is how much they mesh
> — the catalog only makes sense because of the approval gate, the approval gate
> only means something because of the reliability score, and the multi-tenant work
> is really just the artifact schema being honest about what it's tied to."

**Run:** `curl -s "localhost:3000/api/catalog?app_id=meridian" | jq '.[].id'`

> "**An agent-facing catalog.** Only *approved* capabilities appear. A draft isn't
> listed-and-refused, it's invisible — a catalog an agent can't act on is just
> noise in its context window. Turning an entry into a Claude tool definition is
> three renames and nothing else; that was the point of shaping it that way.
>
> **Confidence and approval.** Every capability carries how often it actually held,
> and a risky one can't replay unattended until a human approves it.
>
> **Code generation** — turns a recording into a plain Playwright script.
>
> **Multi-tenant reuse.** A recording is tied to an app id, not a URL, so two
> institutions running the same vendor product share one recording. Where they
> genuinely differ, an override patches only the steps it names and leaves the rest
> exactly as recorded.
>
> **Stability** — replay N times, report what held."

### The two I built and then deleted

> "**Assisted fallback** — letting the AI repair one broken step. It worked, and it
> stayed inside every bound I set. I removed it because I measured it: two
> recoveries out of four. So the honest choice was a feature that works half the
> time, or no feature. A replay that fails deterministically — with the step, the
> selector, everything it tried, and a screenshot — is more useful to whoever has
> to fix it than one that sometimes silently repairs itself. And it keeps 'replay
> never calls a model' absolutely true instead of nearly true.
>
> **A UI drift detector** — comparing a fingerprint of each page against a
> baseline. I removed it because the fingerprint was a *set*, and a set can't
> count. Forty identical table rows collapse to one line, so deleting thirty-nine
> of them scores zero drift — and rows disappearing is exactly what you'd want
> flagged. A warning system that's quiet about the changes that matter most is
> worse than none, because it invites trust it hasn't earned."

---

## Part 3 — The challenge (6 min)

### Was it a rewrite, or a config change?

**Run:** `cat apps/meridian/config.example.json`

> "That's the adapter. One file — the URL, the routes it may touch, the routes that
> change data, the fields that must never be written down, and the two operator
> identities this target distinguishes. No new action primitive, no second replay
> path, no target-specific branch anywhere in the engine. All seven functions
> recorded and replaying.
>
> Two decisions in there I'd defend. **System Settings is deliberately outside the
> allowlist** — that screen sets a global error rate for everyone using the host,
> and automation has no business flipping it. And **redaction covers names, email,
> phone, address and account numbers but not balances** — because reading balances
> is what a member-servicing console is *for*. The copy written to evidence is
> redacted; the caller still gets the real value."

### What it broke — the useful part

> "The shape held. What didn't hold was six assumptions inside my core that a
> tidier target had never tested. Finding those is the value of the exercise."

| Broke | Why this target found it |
| --- | --- |
| Dropdowns matched an option's exact label | Labels carry **live balances** — a recording worked once, then broke after its own first transfer |
| `value_equals` split on the first `=` | No test IDs means every selector is `input[name='q']` — which contains an `=` |
| Checkpoints couldn't reference a parameter | So the model checkpointed a dropdown on text that's there either way: an unverified step recorded as verified |
| Nothing checked a declared input was used | The first recording demanded the *password* from the caller |
| `classifyRisk()` had no callers | Risk was whatever the recorder claimed about itself |
| Saving a capability rewrote it | Older code silently erased fields it didn't know — approving one deleted its error rules |

### Three things that are genuinely new

> "**Error rules that belong to the flow, not to a step.** 'No such member' shows up
> one step *after* the search that caused it, and an expired session can land
> anywhere. These are only checked when a step is about to be called a failure,
> which is what makes them safe — they can't mask a step that worked.
>
> **An `escalate` flag.** 'A supervisor must authorise this' is neither an answer
> nor a fault. Same declaration, one flag, and it becomes a handover.
>
> **HTTP status as a checkable condition.** This host states every fault twice — in
> the status line and in the page. The status is the better one: a phrase gets
> matched by accident and moves the moment someone rewords the copy."

### Live — three runs

**1. Chatbot:** `What are the share balances for member 100987?`

> "The chatbot has no idea how any of this works. It got a list of capabilities
> with typed arguments, picked one, and called it — and that's a real browser
> driving the real host right now. Every figure came back from the capability; the
> model isn't allowed to invent one and has nothing to invent from."

**2. Chatbot:** `Transfer $5 from share 100234-S0001 to 100234-MMKT-3 for member 100234, memo demo.`

> "That share is on HOLD. It comes back **BUSINESS_OUTCOME** — not a failure.
> Nothing broke; the app was asked and it said no. And it's carrying the app's own
> sentence: *'Source share is HOLD and cannot be debited.'*
>
> The way that works is one rule detecting the generic rejection banner this host
> shows for *any* invalid transaction, plus a second locator that reads the specific
> reason inside it. So one rule covers a held share, insufficient funds and a bad
> amount — and the caller still learns which one it actually was."

**3. Run:**

```bash
npm run replay -- --id place-account-hold --param member_number=102777 \
  --param share=102777-S0001 --param reason=FRAUD --param notes="teller attempt" \
  --secret MERIDIAN_SUPERVISOR_USERNAME=teller1 \
  --secret MERIDIAN_SUPERVISOR_PASSWORD=password
```

> "Placing a hold needs a supervisor. That's the same recording as always — I've
> only swapped the credentials for this one run, and only the *names* are ever
> written down.
>
> It comes back **ESCALATED**. Not a failure, nothing is broken. Not a business
> outcome either — the work is real and unfinished. It carries the step, the URL
> and a screenshot, because a person has to pick this up and finish it.
>
> Drop the two `--secret` flags and the same call posts the hold and returns a
> confirmation number. And the run report says *which* credential was swapped —
> without that, the same capability gives two different answers for no visible
> reason."

**If there's time:**

> "There's a run in the evidence folder where **discovery itself escalated**. I told
> it to record the hold as an ordinary teller; it drove the flow, hit SUPERVISOR
> OVERRIDE REQUIRED, and refused to emit a recording for something it couldn't
> actually finish. That settles a design question rather than being a bug — a
> teller-operated hold capability *cannot exist*."

### The six injected faults

| Status | Treated as |
| --- | --- |
| 400 validation · 404 not found | `BUSINESS_OUTCOME` — the app answered |
| 403 permission | `ESCALATED` — needs more authority |
| 503 maintenance | `RECOVERABLE` — take the host's Continue link |
| 500 server error | `RECOVERABLE` once, then a hard failure |
| 440 session expired | **Split by risk** |

> "Declared once per app rather than in every recording, because a runtime fault
> belongs to the host, not to whichever flow happened to be running.
>
> The 440 split is the call I'd most want to defend. Re-authenticating and carrying
> on is safe for a read and reckless for a transfer — because the run **cannot
> tell** whether its post landed before the session dropped, and guessing wrong
> duplicates an irreversible transaction. So a read-only flow re-runs once from the
> top; anything that moves money stops and escalates for a person to check."

---

## Surfaces: legacy, SPA, desktop (1 min)

> "I tested more than one shape on purpose, and not only bank apps — I wanted to
> know whether the recording format held up somewhere it wasn't designed for.
>
> **Legacy** — MERIDIAN, and a mock core I built. Full page load per click, table
> layout, no test IDs, no `<label for>` anywhere. Worth saying: the
> per-transaction hidden token needed **no special handling at all**. The form
> carries it, and clicking the real submit button submits it. That's the strongest
> argument for driving the page rather than its endpoints — posting to URLs would
> have meant scraping and replaying that token myself.
>
> **SPA** — nothing navigates, content appears when a fetch resolves, elements
> exist before they're usable. That's why checkpoints are first-class rather than
> sleeps: every step has to *prove* it worked instead of assuming the click landed.
>
> **Desktop** — designed, not built, and I'd rather say that plainly. The seam is
> `engine/perception.js`, which turns a live surface into an accessibility tree.
> Windows and macOS both expose essentially that same shape. The recording format,
> the five actions and the replay engine wouldn't change — the driver underneath
> perception would. I'm confident in that seam because I already don't read raw
> HTML; I read the accessibility tree. The abstraction is in use, not just declared."

---

## Guardrails, safety, failures (2 min)

> "**The allowlist** opens all five action functions — inside the primitives, not
> in the callers. The app's own origin is a hard boundary no route prefix can widen,
> so a link that goes off-site stops the run.
>
> **Risk** — reads and navigation can't change state; clicks and typing depend on
> the route. A risky capability can't replay unattended without approval, and
> nothing is visible to an outside agent until approved. The honest part: that
> classifier existed and was **never called**. Replay now re-derives it per step
> from config and checks the **live** URL, because a legacy flow reaches a posting
> screen by submitting a form, not by navigating to it.
>
> **Redaction runs in two directions.** By name, when a value would be logged —
> that's the obvious one. And by *value*, in text nobody explicitly logged: a
> browser publishes a filled input's value in the accessibility tree, so the moment
> the agent types a password it's in every later snapshot of that page — which is
> both what's written to the transcript and what the model is shown on its next
> turn. Without masking that, 'the model never sees a password' is only true until
> it types one.
>
> **Where it stops** — the gate looks at the route, not at what's in the form. If a
> recording types the wrong *amount* into a legitimately allowed transfer screen,
> nothing catches it. I'd want field-level policy on money-moving steps before this
> went near production."

**The five outcomes, and why the order matters:**

| | |
| --- | --- |
| `SUCCESS` | Worked — here are the outputs |
| `BUSINESS_OUTCOME` | A real answer that isn't the happy path |
| `RECOVERABLE` | Known problem, cleared it, carried on |
| `HARD_FAILURE` | Didn't match — step, expectation, observation, screenshot |
| `ESCALATED` | Needs a person with more authority |

> "A step's declared rules are checked **before** its success check — because
> checking success first treats 'no such member' as a broken step, and that's the
> single most common mistake in this problem space. Then the success check. Then a
> fixed recovery list. Then the flow-level rules and the host's faults. Only then
> is it a hard failure.
>
> And recovery is a lookup table, never the AI improvising — replay never calls a
> model, including when it's stuck."

---

## Cuts and next steps (1 min)

> "**Cut deliberately.** No mid-flow session resume for anything that changes data —
> resuming safely needs an idempotency key this target doesn't offer. Transient
> retry is one reload, no backoff. No stability sweep across the seven capabilities.
> The chatbot has no confirm-before-risky step. Desktop designed, not built. The
> operator console is a screenshot and buttons rather than live co-browsing, which
> the brief allowed.
>
> The rule behind all of those was the same: I'd rather ship a smaller set I can
> defend line by line than a longer one I can't.
>
> **Next, in order.** Confirm-before-risky in the chatbot — that's a real hole in
> the wrapper rather than the core, so it goes first. Then sweep stability so the
> reliability numbers mean something. Then field-level policy on money-moving steps."

---

## Questions to expect

- **"Why Playwright?"** Auto-waiting, direct accessibility-tree access, one API
  across browsers. Selenium needs explicit waits everywhere — the exact flakiness
  I'm trying to avoid.
- **"Why the accessibility tree, not HTML or screenshots?"** Legacy HTML is layout
  tables and noise; screenshots need a vision model on every step. The tree is
  roles and names — the same shape desktop exposes, which is what makes desktop a
  driver swap rather than a rewrite.
- **"Why only five actions?"** Every action is a place the safety gate must be
  applied and the model could invent something. A dropdown is a `type` — putting a
  value into a control — not a sixth primitive.
- **"Rewrite or config change?"** Config, one file. And it exposed six assumptions
  a tidier target had never tested.
- **"What breaks first at scale?"** Credentials are process-global. Per-call
  overrides exist and are the right shape, but the default path would collide if
  two institutions replayed concurrently in one process. That's the first thing I'd
  fix.
- **If I don't know:** say so, then say how I'd find out.

---

## Commands, in order

```bash
npm start                                   # before they walk in
node --test tests/invariants.test.js        # Part 1
npm run replay -- --id member-inquiry-search-by-last-name --param last_name=Hopper
curl -s "localhost:3000/api/catalog?app_id=meridian" | jq '.[].id'   # Part 2
cat apps/meridian/config.example.json       # Part 3

# chatbot: balances for 100987 · transfer from 100234-S0001 (on HOLD)

npm run replay -- --id place-account-hold --param member_number=102777 \
  --param share=102777-S0001 --param reason=FRAUD --param notes="teller attempt" \
  --secret MERIDIAN_SUPERVISOR_USERNAME=teller1 \
  --secret MERIDIAN_SUPERVISOR_PASSWORD=password
```

**Seed members:** 100234 (has a share on HOLD), 100987, 101555, 102777, 103001
**Operators:** `teller1` / `password` · `super1` / `password` (supervisor)
