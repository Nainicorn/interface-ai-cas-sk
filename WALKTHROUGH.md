# WALKTHROUGH.md

## my notes
- computer use automation system for legacy bank apps
- legacy apps followed server-rendering style
- needed a way to add an app to test (url, name, goal, fields, etc.)
- needed a way to save each apps config
- needed a way to test the agent against each app
- the req was to take a user specified goal in natural language and create an agentic loop (understand, plan, etc.) and record the successful discovery run, escalate to a human when needed, and replay it to be deterministic, while staying within guardrails
- I needed to first understand how to implement the mvp, which meant doing some learning and refreshing some technologies. once I understood what I needed to accomplish, I then scaffolded and at first I got it wrong, obviously I used claude code but again if you as a developer arent a good driver then no matter how now the car is you won't get where you want to go. So i went back and tried to understand how to build the system end to end, the full flow, even if i had to be excruciatingly detailed with my plan
- once i heard computer use automation, my mind went to playwright, i had played around with it a couple months ago but i needed a refresh however I had a feeling I would need to use it for this system. The agent needed browser tools to actually interact with the app its given (in the mvp it was only the legacy bank app)
- once I had my stack down, I had a better idea of how everything would flow together. I stuck with js after i picked node to be my runtime and wanted to use zod for the schema validation and versioning
- the structured artifact is where I knew zod would come in handy as it needed to be especially because it would eventually be used to do a deterministic run
- i had never actually implemented human in the loop before but i designed the rough flow for another project so i thought about how i could fit that logic into this app, obviously hitl would mainly be used for discovery runs as replays were deterministic
- I also really wanted a "live play" feature because I love UI and i love being able to SEE what i built rather than just rely on a success note from the CLI. is the CLI beautiful and fast on its own, of course, but I still wanted to create a console to see my runs in progress and any other features I wanted to build on top
- I time boxed myself by giving myself a week or half a sprint to complete the work because I didnt want to rush it but also didnt want to take too long or implement too many things because I wanted to actually have a full understanding of what I built even if its not perfect
- I also didnt want my stack to be heavy, this was just a prototype essentially but if I were to further build this out I would spend more time understanding each piece in detail rather than just implementing a ton of features without taking the time to see if they were useful or not.
- once i finished the mvp, the app could be configured, discovery run worked, replay tested, and human in the loop fired, I wanted to tackle the multi-tenant part. Although I did scope myself only to web apps for the take home, in the future id love to work with other surfaces too. but i did want to test on legacy and spa not just one or the other, and i wanted to test different apps itself not just bank apps to see how my agent would perform in those cases
- I appreciated that you provided us with the freedom to choose what tech stack we wanted and the option to mock a bank app because it gave me the flexibility to run all kinds of tests and edge cases that I could think of to test each feature (human in the loop, agentic capability, etc.) oh and I loved the glossary I agree if you don't know its fine but you should try to learn
- I did cut a few things but I thought that it was best given my own time box and also since I wanted to prioritize the MVP and some features instead of 10 features I couldn't stand behind because it is difficult to own several lines of code if you don't know at the very least what it does and how it fits into your system
- for my design writeup i focused on the decisions I made and had several conversations with claude about what was developed if I was unsure and definitely went back and forth a lot on whether I agreed or disagreed with the implementation choices
- i noticed how the stretch goals kind of mesh together in a way if you really think about it
- i want to walkthrough what i did initially, then how i implemented extra stretch goals after i got the demo callback, and finally the challenge thats how i want to structure my presentation along with all the requirements they are looking for sprinkled in (like for example sections 6, 7 and 8 from the assignment.pdf doc under docs)

---

# Demo script — 12 minutes

Three parts, the way I want to tell it: **what I built first → what I added after
the callback → the challenge.** Part 3 is the one that counts; if I run short,
cut Part 2, not Part 3.

**Before anyone is watching:** `npm start`, open `localhost:3000`, click
**MERIDIAN CORE** in the sidebar. Second terminal open in the repo. Target's
System Settings showing no forced injection. Backup recording ready.

---

## Part 1 — What I built first (4 min)

**Say:**

> "Banks have a long tail of internal apps with no API — the only way in is to
> drive the screen like a person. You could put an AI in front of every one, but
> then every transaction costs a model call, takes seconds, and can decide
> something different today than yesterday. Not something you put near someone's
> money.
>
> So: let the AI figure it out **once**, write down what it learned, and replay
> that recording forever with no AI. The model discovers, the recording becomes a
> reusable capability, deterministic replay is how a production agent calls it."

**One rule everything hangs off:**

> "The replay engine never imports the AI SDK. Not behind a flag, not as a
> fallback. It's a test — add that import and the build fails."

**Run:** `node --test tests/invariants.test.js`

> "Four invariants. Replay imports no AI. The safety gate opens every action.
> There's only one action layer. And the five primitives match the schema."

**The folders, quickly:**

| | |
| --- | --- |
| `src/schema/` | **The contract** — what a recording *is* |
| `src/engine/` | **The hands** — the only five ways to touch a page |
| `src/policy/` | **The rules** — allowlist, risk, redaction |
| `src/agent/` | **The AI part** — the one place a model decides anything |
| `src/api/` `src/cli/` | The surfaces: console, terminal, outside agents |
| `src/evidence/` | What every run did, on disk |
| `ui/` | The console, one folder per component |

> "Three files matter most. `schema/capability.js` — the typed shape of a
> recording. `engine/actions.js` — the five things anything can do to a page;
> the AI, the replay and a human operator all go through these same five, and the
> safety gate is the first line of each. And `agent/discovery.js` — the only
> place a model decides anything.
>
> Storage is files, no database. A recording should be readable in a code review,
> and a row in SQLite isn't."

**Live — the loop:**

**Run:** `npm run replay -- --id member-inquiry-search-by-last-name --param last_name=Hopper`

> "Fifteen seconds, no model, costs nothing. And that's a different surname than
> it was recorded with — it's parameterised, not a fixed script."

---

## Part 2 — Stretch goals, after the callback (3 min)

> "I went back and did five of the six. They mesh together more than you'd think."

**Run:** `curl -s "localhost:3000/api/catalog?app_id=meridian" | jq '.[].id'`

> "**Agent-facing catalog.** Only *approved* capabilities appear — a draft isn't
> listed-and-refused, it's invisible, because a catalog an agent can't act on is
> noise in its context. Turning an entry into a Claude tool definition is three
> renames.
>
> **Confidence and approval** — every capability carries how often it held, and a
> risky one can't run unattended until a human approves it.
>
> **Code generation** — turns a recording into a plain Playwright script.
>
> **Multi-tenant** — a recording is tied to an app id, not a URL. Two institutions
> on the same vendor product share one recording; where they differ, an override
> patches only the steps it names.
>
> **Stability** — replay N times, report what held."

**The two I deleted — say this confidently, it's a strength:**

> "**Assisted fallback** — letting the AI fix one broken step. It worked. I
> removed it because I measured it: two recoveries out of four. So the honest
> choice was a feature that works half the time or no feature. A replay that fails
> deterministically — step, selector, everything it tried, screenshot — is more
> useful than one that sometimes silently repairs itself.
>
> **A drift detector** — I removed it because the fingerprint was a set, and a set
> can't count. Forty identical rows collapse to one line, so deleting thirty-nine
> scores zero drift. A warning system that's quiet about what matters most is
> worse than none."

---

## Part 3 — The challenge (6 min) ← the important one

### Was it a rewrite or a config change?

**Run:** `cat apps/meridian/config.example.json`

> "That's the adapter. One file — the URL, the routes it may touch, the routes
> that change data, the fields never written down, and the two operator
> identities. No new primitive, no second replay path, no target-specific branch
> in the engine. All seven functions recorded and replaying.
>
> Two decisions I'd defend: **System Settings is deliberately outside the
> allowlist** — it sets a global error rate for everyone on that host, automation
> has no business there. And **redaction covers PII but not balances**, because
> reading balances is what the console is *for*."

### What it broke — the useful part

> "The shape held. Six assumptions inside my core didn't, and finding those is
> the value of the exercise."

| Broke | Why this target found it |
| --- | --- |
| Dropdowns matched exact label | Labels carry **live balances** — a recording broke after its own first transfer |
| `value_equals` split on first `=` | No test IDs → every selector is `input[name='q']`, which contains an `=` |
| Checkpoints couldn't use a parameter | So the model checkpointed on text that's there either way — unverified step recorded as verified |
| Nothing checked an input was used | First recording demanded the *password* from the caller |
| `classifyRisk()` had no callers | Risk was whatever the recorder claimed about itself |
| Saving a capability rewrote it | Older code silently erased fields it didn't know — approving deleted the error rules |

### Three things that are genuinely new

> "**Error rules that belong to the flow, not a step** — 'no such member' shows up
> one step *after* the search. They're only checked when a step is about to be
> called a failure, so they can't mask a step that worked.
>
> **An `escalate` flag** — 'a supervisor must authorise this' is neither an answer
> nor a fault. Same declaration, one flag, and it's a handover.
>
> **HTTP status as a checkable condition** — this host states every fault twice,
> in the status and in the page. The status is better: a phrase gets matched by
> accident and moves when someone rewords it."

### Live — three runs

**1. Chatbot:** `What are the share balances for member 100987?`

> "The chatbot has no idea how any of this works — it got typed capabilities,
> picked one, called it. That's a real browser on the real host. Every number came
> back from the capability; the model can't invent one."

**2. Chatbot:** `Transfer $5 from share 100234-S0001 to 100234-MMKT-3 for member 100234, memo demo.`

> "That share is on HOLD. It comes back **BUSINESS_OUTCOME**, not a failure —
> nothing broke, the app was asked and said no. And it carries the app's own
> sentence: *'Source share is HOLD and cannot be debited.'* One rule detects the
> generic rejection banner, a second locator reads the specific reason — so one
> rule covers held shares, insufficient funds and bad amounts, and the caller
> still learns which."

**3. Run:**

```bash
npm run replay -- --id place-account-hold --param member_number=102777 \
  --param share=102777-S0001 --param reason=FRAUD --param notes="teller attempt" \
  --secret MERIDIAN_SUPERVISOR_USERNAME=teller1 \
  --secret MERIDIAN_SUPERVISOR_PASSWORD=password
```

> "Holds need a supervisor. Same recording — I've only swapped credentials for
> this run, and only the *names* get written down. Comes back **ESCALATED**: not a
> failure, nothing's broken; not an answer either, the work is real and unfinished.
> It carries the step, the URL and a screenshot so a person can pick it up.
>
> Drop the two `--secret` flags and it posts the hold and returns a confirmation
> number. Same capability, different operator — and the run report says which
> credential was swapped, because otherwise the same capability gives two
> different answers for no visible reason."

**One more, if there's time:**

> "There's a run in evidence where **discovery itself escalated**. I told it to
> record the hold as an ordinary teller; it hit the supervisor gate and refused to
> emit a recording for a flow it couldn't finish. That settles a design question
> rather than being a bug — a teller-operated hold capability *cannot exist*."

### The six injected faults

| Status | Treated as |
| --- | --- |
| 400 validation · 404 not found | `BUSINESS_OUTCOME` — the app answered |
| 403 permission | `ESCALATED` — needs more authority |
| 503 maintenance | `RECOVERABLE` — take the host's Continue link |
| 500 server | `RECOVERABLE` once, then a hard failure |
| 440 session expired | **Split by risk** |

> "Declared once per app, not per recording — a runtime fault belongs to the host,
> not to whichever flow was running.
>
> The 440 split is the call I'd most want to defend. Re-authenticating is safe for
> a read and reckless for a transfer, because the run **cannot tell** whether its
> post landed before the session dropped, and guessing wrong duplicates an
> irreversible transaction. So reads re-run once; anything that moves money stops
> and escalates."

---

## Legacy vs SPA vs desktop (1 min)

> "**Legacy** — MERIDIAN and the mock bank I built. Full page load per click,
> table layout, no test IDs, no `<label for>`. Worth saying: the per-transaction
> hidden token needed **no special handling** — the form carries it and clicking
> the real submit button submits it. That's the argument for driving the page
> rather than its endpoints.
>
> **SPA** — I tested two. Nothing navigates, content appears when a fetch
> finishes. That's why checkpoints are first-class instead of sleeps: every step
> proves it worked rather than assuming the click landed.
>
> **Desktop** — designed, not built, and I'd rather say so. The seam is
> `engine/perception.js`, which turns a surface into an accessibility tree.
> Windows and macOS expose the same shape. The recording format, the five actions
> and the replay engine wouldn't change — the driver under perception would. I'm
> confident in that seam because I already don't read raw HTML, I read the
> accessibility tree, so the abstraction is in use rather than declared."

---

## Guardrails, safety, failures (2 min)

> "**The allowlist** is the first line of all five action functions — inside the
> primitives, not in the callers, so nobody can forget it. The app's origin is a
> hard boundary no route prefix widens.
>
> **Risk** — reads and navigation are always safe; clicks and typing depend on the
> route. A risky capability can't replay unattended without approval, and nothing
> at all is visible to an outside agent until approved. The honest bit: that
> classifier existed and was **never called**. Replay now re-derives it per step
> and checks the **live** URL, because a legacy flow reaches a posting screen by
> submitting a form, not by navigating to it.
>
> **Redaction runs two directions.** By name, when a value would be logged —
> obvious. And by *value*, in text nobody logged: a browser publishes a filled
> input's value in the accessibility tree, so the moment the agent types a
> password it's in every later snapshot — which is both what's written to the
> transcript and what the model sees next turn. Without masking that, 'the model
> never sees a password' is only true until it types one.
>
> **Where it stops** — the gate looks at the route, not what's in the form. If a
> recording types the wrong *amount* into a legitimately-allowed transfer screen,
> nothing catches it. I'd want field-level policy on money-moving steps before
> this went near production."

**The five outcomes, and why the order matters:**

| | |
| --- | --- |
| `SUCCESS` | Worked, here are the outputs |
| `BUSINESS_OUTCOME` | A real answer that isn't the happy path |
| `RECOVERABLE` | Known problem, cleared it, carried on |
| `HARD_FAILURE` | Didn't match — step, expectation, observation, screenshot |
| `ESCALATED` | Needs a person with more authority |

> "A step's declared rules are checked **before** its success check — because
> checking success first treats 'no such member' as a broken step, and that's the
> single most common mistake in this problem space. Then the success check, then a
> fixed recovery list, then flow-level rules and host faults. Only then a hard
> failure. And recovery is a lookup table, never the AI improvising — replay never
> calls a model, including when it's stuck."

---

## Cuts and next (1 min)

> "**Cut deliberately:** no mid-flow session resume for anything that changes data
> — resuming safely needs an idempotency key this target doesn't offer. Transient
> retry is one reload, no backoff. No stability sweep across the seven. The
> chatbot has no confirm-before-risky step. Desktop designed, not built. Operator
> console is a screenshot and buttons, not live co-browsing — which the brief
> allowed.
>
> **Next, in order:** confirm-before-risky in the chatbot, because that's a real
> hole in the wrapper rather than the core. Then sweep stability so the reliability
> numbers mean something. Then field-level policy on money-moving steps."

---

## Questions I should expect

- **"Why Playwright?"** Auto-waiting, direct accessibility-tree access, one API
  across browsers. Selenium needs explicit waits everywhere — the flakiness I'm avoiding.
- **"Why the accessibility tree?"** Legacy HTML is layout tables and noise;
  screenshots need a vision model every step. The tree is roles and names — the
  same shape desktop exposes, which is what makes desktop a driver swap.
- **"Why five actions?"** Every action is a place the gate must be applied and the
  model could invent something. A dropdown is a `type`, not a sixth primitive.
- **"Rewrite or config?"** Config, one file — and it exposed six assumptions a
  tidier target had never tested.
- **"What breaks first at scale?"** Credentials are process-global. Per-call
  overrides exist and are the right shape, but the default path would collide if
  two tenants replayed concurrently in one process.
- **If I don't know:** say so, then say how I'd find out. Their own glossary says
  not knowing is fine and not looking it up isn't.

---

## Commands, in order

```bash
npm start                                   # before they walk in
node --test tests/invariants.test.js        # Part 1
npm run replay -- --id member-inquiry-search-by-last-name --param last_name=Hopper
curl -s "localhost:3000/api/catalog?app_id=meridian" | jq '.[].id'   # Part 2
cat apps/meridian/config.example.json       # Part 3
# chatbot: balances for 100987 · transfer from 100234-S0001 (HOLD)
npm run replay -- --id place-account-hold --param member_number=102777 \
  --param share=102777-S0001 --param reason=FRAUD --param notes="teller attempt" \
  --secret MERIDIAN_SUPERVISOR_USERNAME=teller1 \
  --secret MERIDIAN_SUPERVISOR_PASSWORD=password
```

**Seeds:** 100234 (has a HOLD), 100987, 101555, 102777, 103001
**Operators:** `teller1` / `password` · `super1` / `password` (supervisor)
