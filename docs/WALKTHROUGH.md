# WALKTHROUGH.md — the whole system in plain language

A companion to [REPORT.md](../REPORT.md) (the design write-up) and
[DESIGN.md](DESIGN.md) (the diagrams). This one explains the same system without
assuming you already know how it's built.

Run `./demo.sh` with no arguments to see every demo command.

---

## Part 1 — How it all works

> Imagine teaching someone to make a sandwich. The **first** time, they need to figure
> it out — where's the bread, where's the knife. After that, you just hand them the
> written steps. **The AI is the figuring-out. The recipe is what you keep.**

### The problem this solves

Banks have old internal software with no way to plug into it. No API, no connection
point. The only way in is to click around the screen like a person would.

You could point an AI at it every single time — but that's slow, expensive, and it
might do something slightly different on each run. In banking, "slightly different each
time" is unacceptable.

So: let the AI work it out *once*, write down exactly what it did, and replay those
written steps forever.

### Step by step, start to finish

**1. You add an app.** Name, web address, and what you want done in plain English. Saved
as a file at `apps/internet/config.json`.

If it needs a login, the password gets tucked into a hidden variable, and the AI is only
ever told the *name* of that hiding spot — never the password itself.

**2. You hit Run. A folder gets made.** Named with the date and time. Everything from
this run goes in it.

**3. A real Chrome window opens** and goes to your app.

**4. The loop starts.** Over and over:

- Take a picture of the page, send it to Claude
- Claude picks **one** thing to do
- That thing happens
- Screenshot saved, note written in the log
- Go again

It gets 24 turns, max.

**5. It ends one of four ways:**

- **It worked** → writes down the recipe
- **It's stuck** → pauses and asks a human (browser stays open)
- **It's impossible** → says so and quits
- **Out of turns** → stops

**6. Before the recipe is accepted, it gets checked three ways.** Is it the right shape?
Does the "I succeeded" thing Claude claims actually show on screen *right now*? Do the
steps match the inputs and outputs it said it needed? All three must pass.

**7. The recipe is saved as `goal.json` — inside that same folder**, right next to the
screenshots and log from the run that made it. It's marked **draft**.

> **Why the recipe lives inside the run folder:** a folder with a `goal.json` is a run
> that worked. A folder without one didn't. You can't have a recipe with no proof it
> ran, and you can't lose the proof while keeping the recipe. There's no second place
> for them to disagree.

So after a successful run, one folder holds all of this:

```
evidence/internet/discovery/2026-08-17_032433/
  000-entry.png        ← screenshots, in order
  001-navigate.png
  002-click.png
  goal.json            ← THE RECIPE
  result.json          ← the summary
  transcript.jsonl     ← every action, one line each
```

### Now the useful part

**8. You replay it.** Click replay. **No AI at all this time** — it just walks the saved
steps and checks each one. About 5 seconds instead of a minute, and it costs nothing.

**9. Each replay leaves its own receipt** — a new folder with its own log and result.
But no `goal.json`, because it didn't learn anything new. It just followed instructions.

**10. Each replay updates the recipe's score.** 8 runs, 8 successes. That number lives
inside the recipe.

**11. If you approve it**, an outside AI can now call it by name. Until you approve it,
that AI can't even see it exists.

> **Say this if nothing else:** discovery learns it once and writes the recipe. Replay
> follows the recipe forever, with no AI. Everything else in the project is in service
> of that one sentence.

### The five things anyone can do

The AI can't do anything it wants. There are exactly five moves: **go to a page, click,
type, read, wait**. That's it.

A dropdown is still one of the five — `type` means "put this value into this control", so
choosing an option in a `<select>` records and replays as an ordinary type step. That
matters: without it the five primitives simply cannot operate a dropdown, and any form
with one escalates to a human every time.

And here's the part that matters: **the AI, the replay, and a human taking over all use
the same five moves.** Nobody gets a secret back door. There is only one piece of code
that knows how to click — there's even a test that reads the source code and fails if a
second one ever appears.

### The five doors (the API)

| Door | What's behind it |
|---|---|
| `/api/apps` | Your apps |
| `/api/runs` | Everything that ever happened — discoveries *and* replays |
| `/api/capabilities` | All your recipes, drafts included. Your view |
| `/api/catalog` | Only approved recipes. An outside AI's view |
| `/api/escalations` | When a human needs to take over |

The last two are the *same files on disk*. Two different doors, because a person
browsing and a robot calling need to see different things.

---

## Part 2 — The stretch goals

> The assignment listed six optional extras and said **"pick at most one or two."** This
> project built all six plus a seventh, then deliberately removed one of them — see #4,
> which is a cut rather than a gap.

### 1. A catalog an outside AI can call

*Asked: expose saved artifacts as a catalog of callable capabilities that an AI agent
could discover and invoke by name.*

1. An outside program asks for the list of approved recipes
2. The list comes back **already shaped like AI tools** — three renamed fields, no
   translation layer needed
3. Claude reads the descriptions, picks one, fills in the arguments. **It never sees the
   recorded steps**
4. It calls it. A plain replay runs. No AI in the replay itself

> **Why it proves something:** the demo script deliberately can't reach into the
> codebase. It only talks over the network, like a real outside caller would. If it
> could peek inside, it wouldn't prove anything.

### 2. Turning a recipe into a normal script

*Asked: emit a runnable test or automation snippet from an artifact.*

1. Load the recipe
2. Walk each step in order
3. Take **only the best way** of finding each button, write it as plain code
4. Keep the backup ways as a comment, so nothing's silently thrown away
5. Copy the success checks across as real waits
6. Wrap it: open browser, do steps, close browser
7. Write the file

**The thing to defend:** it doesn't copy the backup-finding logic into the script. That
logic is what makes the *recipe* survive small changes. A generated script is a snapshot
for a human to read or hand off — so duplicating that logic would just create a second
copy nobody maintains.

### 3. Scoring and approval

*Asked: score artifacts by how reliably they replay, and gate unattended replay on an
approval state.*

1. Every recipe starts as a **draft** with a 0/0 score
2. Every replay updates the score
3. A *safe* draft can replay from the console — a human is watching
4. But **nothing** unapproved is visible to an outside AI
5. Un-approving is as easy as approving — a recipe going flaky should be pullable
   instantly, without deleting its history
6. An approved recipe can't be deleted. Un-approve it first

### 4. Letting the AI help once, if a replay gets stuck — **built, then cut**

*Asked: on replay failure, allow a bounded, policy-checked LLM recovery for a single
step (never open-ended), and record it as evidence.*

I built this and then took it out. It worked, and it stayed inside every bound: off
unless you asked for it, one call per replay, only when a button genuinely couldn't be
found, and it could suggest nothing except another way to find that same button.

**Why it's gone:** I measured it. On a genuinely broken locator it fixed two runs out of
four. That's not a bug to fix — it's one model call with one shot and no retries, and
retrying until something sticks is exactly the open-ended loop the whole design avoids.

So the choice was a feature that works half the time, or no feature. A replay that fails
the same way every time — with the step, the selector, everything it tried, and a
screenshot — is more useful to whoever has to fix it than one that sometimes quietly
repairs itself. And it keeps the headline claim absolute instead of nearly true:
**replay never calls a model.** No flag, no opt-in, no exception.

**What I'd need to put it back:** a way to tell "the suggestion was wrong" apart from
"the page was in a state no locator could match", so the one retry is spent where it
would actually help.

### 5. One recipe, many customers

*Asked: normalize concrete routes into parameterized patterns, and/or demonstrate one
artifact applied to a second, slightly different variant with per-variant overrides.*

Hundreds of banks run the *same* software with different branding. You shouldn't
re-record for each one.

1. A customer can declare a small patch — "our Submit button says Send"
2. The patch swaps **only** the steps it names, leaves everything else exactly as
   recorded
3. It's applied before replay starts, so **replay has no idea a patch happened**
4. Separately, a tool spots web addresses that look customer-specific
   (`/members/12345`) and suggests `/members/:id`

**It only suggests.** A string of digits might genuinely be a fixed product code — that
judgment belongs to a person, not a script.

### 6. Is it actually reliable?

*Asked: replay N times and report a stability/flakiness signal.*

Run the recipe 5 times, report what percent held. **No special test mode** — it calls
the exact same replay function 5 times, with the same approval checks and the same
evidence trail, then adds up the results.

### 7. Noticing when a page quietly changes *(not in the assignment)*

The gap it fills: a hard failure tells you the page *broke*. Nothing tells you the page
is slowly *drifting* while still technically working.

1. The first successful replay takes a fingerprint of each page and freezes it
2. Every replay after that compares against **that frozen fingerprint**
3. Drifted too far? Log a warning, show it in the report
4. **It never changes the result.** A recipe that still works is still a success

> **The smartest decision in the whole feature:** the fingerprint is *never* updated. If
> it were, a slow redesign — one small change a week — would quietly seep into the
> baseline and never trigger a warning at all.

---

## Part 3 — Choices and trade-offs

> For each of these, know **what was picked, what wasn't, and why.** That's the actual
> interview question.

### Playwright, not Selenium or Puppeteer

- It can read the **accessibility tree** — the thing screen readers use. That's the
  foundation of the whole approach
- It waits for things automatically, so there's no scattering of sleeps
- It finds buttons by *meaning* ("the button called Submit") rather than by CSS. Old
  bank apps have no clean CSS to grab

Selenium is older, heavier, more fragile, and much worse at the accessibility tree.
Puppeteer is Chrome-only with no equivalent way of finding things.

### Reading the accessibility tree, not the raw HTML or pixels

The assignment says these are old apps built out of tables with no clean markup — and
sometimes desktop apps, not websites at all. The accessibility tree is the one thing
that exists across *all* of those. It's also far cheaper to send to the AI than a dump
of HTML, and far more stable.

**The payoff:** switching to desktop apps later means changing one file.

### Exactly five moves, no more

Not "let the AI do anything." It can't invent a sixth move, and neither can replay. That
also means what gets recorded is exactly what gets replayed — no translation step in
between that could drift.

### Files on disk, no database

A run *is* its folder. Folder names are timestamps, so they already sort correctly. The
reason: a database index would be a second source of truth that could disagree with the
folders.

**Own the downside:** this doesn't scale, there's no protection against two things
writing at once, and listing runs means walking the whole filesystem. Fine for proving
the design. Not fine for production.

### One process, no queue, no retries

It could crash halfway and won't retry. That's a real problem if lots of runs needed to
happen at once.

**Why it's still right:** the assignment explicitly says *"prematurely building that
infrastructure is not"* valuable. Building queues would have been solving a problem the
brief said not to solve.

### The AI loop is hand-written, not from a library

Three reasons, all real:

- When a human takes over, the loop has to **pause and resume minutes later from a
  completely different web request**. Library loops can't do that
- The assignment grades the observe → decide → act loop, so it should be visible as an
  actual loop you can read
- The one thing that absolutely must work shouldn't depend on a beta feature

### One definition feeds four things

The same schema validates the saved recipe, checks the inputs on replay, defines
Claude's tools during discovery, *and* shapes the outside catalog.

So the words the AI speaks while learning are the same words stored in the file are the
same words replay executes. **Nothing needs translating, so nothing can drift.**

---

## Part 4 — When things go wrong

> Every step ends in one of four ways — and **the order they're checked in is the single
> most important design decision in the project.**

| Result | Means | You do |
|---|---|---|
| `SUCCESS` | Worked, here's the data | Use it |
| `BUSINESS_OUTCOME` | A real answer, like "no such member" | Treat it as an answer, **not** an error |
| `RECOVERABLE` | Hit a known hiccup, handled it, carried on | Nothing |
| `HARD_FAILURE` | Didn't match what was expected | Look at the screenshot |

### Why "no such member" is checked first

Say you look up a member who doesn't exist. The page says *"No such member."*

Now — the step's success check was probably "the balance is showing." That check
**also** fails. So if you check success first, you'd report a crash for what is actually
a *perfectly good answer*.

> The assignment's own glossary calls this out by name: *"Conflating the two is the most
> common design mistake here."*

So the recipe writes down ahead of time what a legitimate not-found answer looks like,
and replay checks for **that first**, before deciding anything failed.

And it's checked a **second** time — if a button can't be found at all, it asks the
question again. Because "this member has no savings account" looks exactly like a
missing button on screen.

### Recovery is a fixed list, not the AI improvising

Replay isn't allowed to call the AI — *including* to recover. So known annoyances (a
cookie banner, a temporary server error) are a short hand-written list: here's how to
spot it, here's the one thing to do about it.

Each rule fires at most once. There's no loop that could spin forever trying to fix
something.

### Being refused isn't the same as failing

If a risky recipe gets refused before it starts, **nothing gets written down**. No run,
no folder, no mark on its record. It never happened, so nothing records it as having
happened.

---

## Part 5 — Gaps to own

> Say these **before someone finds them.** Knowing your own weak spots reads as senior.
> Being surprised by them doesn't.

### Business-outcome detectors are written by a model, and can be too loose

The biggest one. A recording declares what a legitimate failure looks like on screen. The
model writes those detectors by picking a phrase off the page — and forms carry permanent
help text that reads exactly like an error. The mock bank's form always says *"Minimum
opening deposit is $25.00. Sub-accounts cannot be opened for non-active members."* The
model detected `DEPOSIT_TOO_LOW` on `"Minimum opening deposit"` — text that is on the page
every single run.

Two guards now catch two of the three shapes of this:

- **A detector that matches the successful page** is rejected at record time. The emit
  gate checks every declared outcome against the live page and hands the model the list to
  fix before the recording is accepted.
- **A detector that matches while the step's own checkpoint also holds** is ignored at
  replay time. The checkpoint is the stronger statement — it proves the step reached the
  state it wanted, where a matched detector only proves some text was present — so a
  happy-path run stays a happy-path run.

Still open: a detector that only false-positives on a *different* failure page. In
`open-sub-account`, a locked member is reported as `DEPOSIT_TOO_LOW` rather than a
permission denial, because both land on the same form and the loose detector matches
first. **The fix I'd make next** is to capture each step's page text as the run proceeds
and validate every declared detector against all of them at emit time, not just against
the final page.

### Safety assumes the form got filled in

If someone forgets to mark a route as risky, a risky action there won't get flagged.
**The fix:** deny by default, and require routes to be explicitly marked safe.

### The safety gate only looks at the path

Anything after a `?` or `#` in a web address is invisible to it. And matching is a plain
prefix, so allowing `/account` also allows `/account-admin`.

### Drift detection can't count

The page fingerprint is a *set*, so 40 identical table rows collapse into one entry.
Delete 39 and it reports zero drift. It also ignores indentation, which is how the
accessibility tree encodes nesting — so moving a button from a popup to the footer reads
as no change. That's the same property that makes harmless reordering not count as drift,
so it's a trade-off rather than a bug — but name it first.

### Assisted fallback lands about half the time

Measured over four runs against a genuinely broken locator: two recoveries, two hard
failures. That is what "one model call, one attempt, no retries" buys. It isn't a bug —
retrying until something sticks would turn a bounded recovery into the open-ended loop the
whole design exists to avoid — but don't promise it in a live demo.

### Discovery can record a locator it never executed

The system prompt tells the model to exercise every read before recording it. It
consistently doesn't, and the resulting capability hard-fails on its first replay. Which
is exactly why a new recording is a **draft** carrying a reliability score rather than
something the system trusts — the console shows `2/7` on such a capability, in amber.

### Replay cannot ask a human

Escalation exists only in discovery. A stuck replay returns `HARD_FAILURE` with a
screenshot; nobody is paged. The session-handoff machinery already exists, so wiring
replay into it is the obvious next step.

### Credentials are process-global

A per-call credential is threaded through the replay context, but the fallback still reads
`process.env`, which the whole process shares. Two concurrent replays for two different
users in one server would race. The fix is contained — `resolveStepValue` is the only
function that reads it.

### Older committed evidence predates the redaction fix

`evidence/heroku_app/` was recorded before credential values were masked out of captured
page text, so that demo site's public password is still visible in those transcripts. New
runs are clean; those would need regenerating.

### Dead code

`redactObject` and `RunLogger.saveResult` are exported and tested but have no production
caller.
