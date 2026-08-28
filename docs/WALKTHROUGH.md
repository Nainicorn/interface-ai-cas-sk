# Walkthrough — demo script

12 minutes, three parts: **what I built first → what I added after the callback →
the challenge.** Part 3 is what they set. If time runs short, cut Part 2.

**Before they walk in:** `npm start` · open `localhost:3000` · select **MERIDIAN
CORE** · second terminal in the repo · target's System Settings showing no forced
injection · backup recording ready.

---

## What they're scoring, and where I prove it

Their criteria, in their order of weight. One line each — this is the checklist.

| # | They're scoring | I prove it by | My one-line answer |
| --- | --- | --- | --- |
| 1 | **Adaptation quality** | `cat apps/meridian/config.example.json` | "The adapter is one config file. No new primitive, no second replay path, no target-specific branch." |
| 2 | **Correctness of the core loop** | A live replay + all 7 functions in the catalog | "All seven functions recorded and replaying deterministically, with typed results." |
| 3 | **Robustness & error handling** | The chatbot's HOLD rejection + the fault table | "Five outcomes. Business outcome, recoverable and hard failure are separated by declared rules, not guesswork." |
| 4 | **Capability API / contract** | `curl /api/catalog` | "Typed in, typed out, invocable by name. Becomes a Claude tool definition with three renames." |
| 5 | **Demoability** | Chatbot + Runs tab, happy and unhappy | "Anyone can drive it and watch it, including when it goes wrong." |
| 6 | **Safety & data handling** | The allowlist, the risk gate, redaction | "One gate opens every action. Risky needs approval. Evidence never keeps PII." |
| 7 | **Escalation** | The teller-credential run | "Stop, don't guess — with the step, the URL and a screenshot for whoever picks it up." |
| 8 | **Communication** | `ADAPTATION.md` / `REPORT.md` | "Every trade-off and every cut is written down with the reason." |

**Deliverables, all in the repo:** source + README with the demo path ·
`ADAPTATION.md` (this round) · `REPORT.md` (the core, their seven headings) ·
`evidence/meridian/` with discovery and replay runs, including failures and
escalations.

---

## Part 1 — What I built first (4 min)

**The problem.**
> "Banks have a long tail of internal apps with no API — the only way in is to drive
> the screen like a person. Put an AI in front of every one and every transaction
> costs a model call, takes seconds, and can decide differently today than
> yesterday. Not something you put near someone's money."

**The idea.**
> "Let the AI figure it out **once**, write down what it learned, replay it forever
> with no AI. The model discovers. The recording becomes a capability.
> Deterministic replay is how a production agent calls it."

**The one rule.** → `node --test tests/invariants.test.js`
> "Replay never imports the AI SDK. Not behind a flag, not as a fallback. It's a
> test — add that import and the build fails. Four invariants: no AI in replay, the
> gate opens every action, one action layer, five primitives matching the schema."

**The stack, briefly.**
> "Node because it's all I/O. **Playwright** because it auto-waits — the biggest
> source of flakiness gone — and it exposes the accessibility tree. **Zod** because
> the recording gets replayed with no model watching, so it validates in *and* out;
> a recording that fails to load is a bug that only shows up in a demo. **No
> database** — a recording should be readable in a code review, and a SQLite row
> isn't."

**The folders.**

| | |
| --- | --- |
| `src/schema/` | The contract — what a recording *is* |
| `src/engine/` | The hands — the only five ways to touch a page |
| `src/policy/` | The rules — allowlist, risk, redaction |
| `src/agent/` | The AI part — the one place a model decides anything |
| `src/api/` `src/cli/` | Surfaces: console, terminal, outside agents |
| `src/evidence/` | What every run did |
| `ui/` | The console |

> "Three files carry it. `capability.js` — the typed shape of a recording.
> `actions.js` — the five things anything can do to a page; AI, replay and human all
> use the same five, and the safety gate is the first line of each, *inside* the
> primitive so no caller can forget it. `discovery.js` — the only place a model
> decides anything."

**Live.** → `npm run replay -- --id member-inquiry-search-by-last-name --param last_name=Hopper`
> "Fifteen seconds, no model, costs nothing. And that's a different surname than it
> was recorded with — parameterised, not a fixed script."

**How I worked.**
> "Time-boxed to half a sprint on purpose — to stop myself building ten features I
> couldn't defend. Depth over breadth. That rule is why two things got deleted."

---

## Part 2 — Stretch goals, after the callback (3 min)

> "Five of six. They mesh more than I expected — the catalog needs the approval
> gate, the approval gate needs the reliability score, and multi-tenant is really
> the schema being honest about what a recording is tied to."

→ `curl -s "localhost:3000/api/catalog?app_id=meridian" | jq '.[].id'`

- **Agent catalog** — only *approved* capabilities appear. A draft is invisible, not
  refused: a catalog an agent can't act on is noise in its context.
- **Confidence + approval** — each carries how often it held; risky ones need a human.
- **Code generation** — a recording becomes a standalone Playwright script.
- **Multi-tenant** — tied to an app id, not a URL. Two institutions on the same
  vendor product share one recording; overrides patch only the steps they name.
- **Stability** — replay N times, report what held.

**The two I deleted** *(say this confidently — it's judgement, not failure)*
> "**Assisted fallback** — letting the AI repair one broken step. It worked. I
> measured it: two recoveries out of four. So the choice was a feature that works
> half the time or no feature. A replay that fails deterministically — step,
> selector, everything tried, screenshot — beats one that sometimes silently repairs
> itself. And it keeps 'replay never calls a model' absolutely true.
>
> **A drift detector** — the fingerprint was a *set*, and a set can't count. Forty
> identical rows collapse to one line, so deleting thirty-nine scores zero drift. A
> warning system quiet about what matters most is worse than none."

---

## Part 3 — The challenge (6 min)

### Rewrite, or config change? → `cat apps/meridian/config.example.json`

> "That's the adapter. URL, routes it may touch, routes that change data, fields
> never written down, and the two operator identities. No new primitive, no second
> replay path, no target-specific branch. Seven functions recorded and replaying.
>
> Two decisions I'd defend: **System Settings is deliberately outside the
> allowlist** — it sets a global error rate for everyone on that host. And
> **redaction covers PII but not balances**, because reading balances is what the
> console is *for*."

### What it broke — six assumptions a tidier target never tested

| Broke | Why this target found it |
| --- | --- |
| Dropdowns matched exact label | Labels carry **live balances** — a recording broke after its own first transfer |
| `value_equals` split on first `=` | No test IDs → every selector is `input[name='q']`, which contains an `=` |
| Checkpoints couldn't use a parameter | So the model checkpointed on text that's there either way — unverified step recorded as verified |
| Declared inputs weren't checked | First recording demanded the *password* from the caller |
| `classifyRisk()` had no callers | Risk was whatever the recorder claimed about itself |
| Saving a capability rewrote it | Older code silently erased fields it didn't know |

> "Finding those is the value of the exercise. Each is its own commit with the
> reasoning."

### Three things genuinely new

> "**Flow-level error rules** — 'no such member' shows up one step *after* the
> search. Only checked when a step is about to be called a failure, so they can't
> mask a step that worked.
>
> **An `escalate` flag** — 'a supervisor must authorise this' is neither an answer
> nor a fault. Same declaration, one flag, and it's a handover.
>
> **HTTP status as a condition** — the host states every fault twice, in the status
> and the page. The status is better: a phrase gets matched by accident and moves
> when someone rewords it."

### Live — the chatbot (all verified)

Point at the panel header first: the **`meridian`** chip and *"It can only do what
you have approved."* → that's the scoping proof.

**1.** `What are the share balances for member 100987?` → **SUCCESS**
> "It picked the capability, filled the typed argument, drove a real browser on the
> real host. Every figure came back from the call — the model can't invent one."

**2.** `What are the balances for member 999999?` → **BUSINESS_OUTCOME**
> "Not a failure. Nothing broke — the app was asked and answered. That's the
> distinction the whole system is organised around."

**3.** `Transfer $5 from share 100234-S0001 to 100234-MMKT-3 for member 100234, memo demo.`
→ **BUSINESS_OUTCOME**, *"Source share is HOLD and cannot be debited."*
> "One rule detects the generic rejection banner, a second locator reads the specific
> reason — so one rule covers held shares, insufficient funds and bad amounts, and
> the caller still learns which."

**4.** Switch to the **Runs** tab — all three sitting there tagged `agent`, each
with a full report behind it.

*(Skip sign-on as a chatbot demo — every capability signs itself on. If it comes
up: plain "sign in" makes the model stop and ask for the branch rather than guess
a required parameter, which is the guardrail working.)*

### Live — escalation

```bash
npm run replay -- --id place-account-hold --param member_number=102777 \
  --param share=102777-S0001 --param reason=FRAUD --param notes="teller attempt" \
  --secret MERIDIAN_SUPERVISOR_USERNAME=teller1 \
  --secret MERIDIAN_SUPERVISOR_PASSWORD=password
```

> "Holds need a supervisor. Same recording — only the credentials swapped for this
> run, and only the *names* get written down. Comes back **ESCALATED**: not a
> failure, nothing broke; not an answer either, the work is real and unfinished. It
> carries the step, the URL and a screenshot so a person can finish it.
>
> Drop the two `--secret` flags and it posts the hold and returns a confirmation
> number. The report says *which* credential was swapped — without that, the same
> capability gives two answers for no visible reason."

**If there's time:**
> "There's a run in evidence where **discovery itself escalated** — told to record
> the hold as a teller, it hit the supervisor gate and refused to emit a recording
> for something it couldn't finish. That settles a design question rather than being
> a bug: a teller-operated hold capability *cannot exist*."

### The six injected faults

| Status | Treated as |
| --- | --- |
| 400 validation · 404 not found | `BUSINESS_OUTCOME` — the app answered |
| 403 permission | `ESCALATED` — needs more authority |
| 503 maintenance | `RECOVERABLE` — take the host's Continue link |
| 500 server | `RECOVERABLE` once, then a hard failure |
| 440 session expired | **Split by risk** |

> "Declared once per app, not per recording — a fault belongs to the host, not the
> flow that was running.
>
> The 440 split is the call I'd most defend. Re-authenticating is safe for a read
> and reckless for a transfer: the run **cannot tell** whether its post landed
> before the session dropped, and guessing wrong duplicates an irreversible
> transaction. So reads re-run once; anything that moves money stops and escalates."

---

## Surfaces (1 min)

> "**Legacy** — MERIDIAN and a mock core I built. Full page load per click, table
> layout, no test IDs. The per-transaction hidden token needed **no special
> handling** — the form carries it, clicking the real submit button submits it.
> That's the argument for driving the page rather than its endpoints.
>
> **SPA** — I tested two. Nothing navigates; content appears when a fetch resolves.
> That's why checkpoints are first-class rather than sleeps — every step proves it
> worked instead of assuming the click landed.
>
> **Desktop** — designed, not built, and I'd rather say so. The seam is
> `perception.js`, which turns a surface into an accessibility tree; Windows and
> macOS expose the same shape. The format, the five actions and the replay engine
> wouldn't change — the driver under perception would. I'm confident because I
> already read the tree rather than raw HTML, so the abstraction is in use."

---

## Safety and failures (2 min)

> "**Allowlist** — first line of all five action functions, inside the primitives.
> The app's origin is a hard boundary no route prefix widens.
>
> **Risk** — reads and navigation are safe; clicks and typing depend on the route.
> Risky can't replay unattended without approval, and nothing is visible to an
> outside agent until approved. Honest bit: that classifier existed and was **never
> called**. Replay now re-derives it per step and checks the **live** URL, because a
> legacy flow reaches a posting screen by submitting a form, not navigating to it.
>
> **Redaction runs two directions.** By name when a value would be logged — obvious.
> And by *value* in text nobody logged: a browser publishes a filled input's value
> in the accessibility tree, so the moment the agent types a password it's in every
> later snapshot — which is both what's written to the transcript and what the model
> sees next turn. Without masking that, 'the model never sees a password' is only
> true until it types one.
>
> **Where it stops** — the gate reads the route, not the form. Wrong *amount* in a
> legitimately-allowed transfer screen? Nothing catches it. I'd want field-level
> policy on money-moving steps before production."

**The five outcomes**

| | |
| --- | --- |
| `SUCCESS` | Worked — here are the outputs |
| `BUSINESS_OUTCOME` | A real answer that isn't the happy path |
| `RECOVERABLE` | Known problem, cleared it, carried on |
| `HARD_FAILURE` | Didn't match — step, expectation, observation, screenshot |
| `ESCALATED` | Needs a person with more authority |

> "The order is the design. A step's declared rules are checked **before** its
> success check — checking success first treats 'no such member' as a broken step,
> the single most common mistake in this problem space. Then the check, then a fixed
> recovery list, then flow rules and host faults. Only then a hard failure. And
> recovery is a lookup table, never the AI improvising."

---

## Cuts and next (1 min)

> "**Cut:** no mid-flow session resume for anything that changes data — resuming
> safely needs an idempotency key this target doesn't offer. Transient retry is one
> reload. No stability sweep across the seven. No confirm-before-risky in the
> chatbot. Desktop designed, not built. Operator console is a screenshot and
> buttons, not co-browsing — which the brief allowed.
>
> Same rule behind all of it: a smaller set I can defend beats a longer one I can't.
>
> **Next, in order:** confirm-before-risky in the chatbot — a real hole in the
> wrapper, not the core. Then sweep stability so the reliability numbers mean
> something. Then field-level policy on money-moving steps."

---

## Hard questions — have these ready

**"Show me the artifact."** ← most likely; the schema is a stated focal point.
Open any `evidence/meridian/discovery/*/goal.json`. Walk: the ordered steps, the
ranked locator candidates per step, `value_from` vs `value_from_env`, the
checkpoint on each step, the business-outcome rules, `risk_level`, `status`.

**"Your outputs are all strings."** True, and the sharpest criticism available.
> "The `read` primitive extracts text, and locators are static — I can't target 'the
> row for share X' from a caller's parameter. So a shares table comes back as one
> block rather than typed rows. Structuring it means either a parsing layer per
> capability or a sixth primitive, and I chose neither rather than half of one.
> It's the first thing I'd change to the schema."

**"You claim deterministic but have fallbacks and prefix matching."**
> "Every rung is exact-or-unique. A rung matching two options is skipped, not
> guessed between — so the same input picks the same option or none at all. Nothing
> is scored or fuzzy."

**"You said accessibility tree, but every locator is CSS."**
> "Perception reads the tree — that's what the model sees and what checkpoints
> assert on. *Locators* fall back to scoped CSS when the page has no roles or labels
> worth using, and this target has no `<label for>` anywhere. The tree is the
> abstraction; CSS is the last rung of the ladder."

**"The rules deciding answer-vs-failure are written by the model."**
> "Yes, at discovery time — and there's a gate that rejects a rule which also
> matches the successful page, because that's the failure mode. But it's
> model-authored logic in the classification path, and the honest answer is it
> should be human-reviewed before approval. Approval already exists; today it
> doesn't force you to read those rules."

**"What stops the chatbot posting the same transfer twice?"**
> "Nothing today. No rate limit, no idempotency key, no dry-run. That's the
> confirm-before-risky gap and it's my first next step."

**"What does this cost?"** ← the leadership question
> "Discovery is one model-call chain, once per capability — a few minutes. Every
> replay after that is **zero model cost** and about fifteen seconds. That's the
> whole architectural argument: the expensive reasoning happens once, not per
> transaction."

**"You found six bugs in your own core — was it working?"**
> "It worked against the target it was built on. These were assumptions that target
> never tested — labels that don't move, selectors without an `=`, one operator per
> app. A new surface is what surfaces them, which is exactly what this exercise was
> for."

**"What breaks first at scale?"**
> "Credentials are process-global. Per-call overrides exist and are the right shape,
> but the default path would collide if two institutions replayed concurrently in
> one process."

**Why Playwright / accessibility tree / five actions** — auto-waiting and tree
access; legacy HTML is layout noise and screenshots need a vision model per step;
five means the gate lives in five places and the model picks from a closed list.

**If I don't know:** say so, then say how I'd find out.

---

## Commands, in order

```bash
npm start                                   # before they arrive
node --test tests/invariants.test.js        # Part 1
npm run replay -- --id member-inquiry-search-by-last-name --param last_name=Hopper
curl -s "localhost:3000/api/catalog?app_id=meridian" | jq '.[].id'   # Part 2
cat apps/meridian/config.example.json       # Part 3

# chatbot, in order:
#   What are the share balances for member 100987?
#   What are the balances for member 999999?
#   Transfer $5 from share 100234-S0001 to 100234-MMKT-3 for member 100234, memo demo.

npm run replay -- --id place-account-hold --param member_number=102777 \
  --param share=102777-S0001 --param reason=FRAUD --param notes="teller attempt" \
  --secret MERIDIAN_SUPERVISOR_USERNAME=teller1 \
  --secret MERIDIAN_SUPERVISOR_PASSWORD=password
```

**Seeds:** 100234 (has a share on HOLD), 100987, 101555, 102777, 103001
**Operators:** `teller1` / `password` · `super1` / `password` (supervisor)

**Check right before recording:** `npm run replay -- --id member-inquiry-shares-lookup --param member_number=100234`
— confirm `100234-S0001` still shows HOLD, or demo 3 returns SUCCESS instead of the rejection.
