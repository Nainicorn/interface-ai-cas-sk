# Computer-Use Automation System

This system is designed for legacy bank apps that have no API. An AI agent "discovers" the app to figure out how to perform a specific task (user given goal).

If the agent is successful the flow gets saved as a typed, versioned "capability" that can run with no model involved at all, as it is just a replay of recorded steps (cost and time efficient).

If either the agent or the replay gets stuck, a human can take over during the live session and can either hand back control, manually interact with the session, or give the agent some extra guidance.

Diagrams of the entire flow of the application are in [docs/DESIGN.md](docs/DESIGN.md), and a
walkthrough of how it all works — and the script for the demo — is in
[docs/WALKTHROUGH.md](docs/WALKTHROUGH.md).

**Pointing this at MERIDIAN CORE** — what changed, what broke, what was cut — is written
up in [ADAPTATION.md](ADAPTATION.md). The demo path is below.

---

## What this round added

The core already discovered flows, recorded them and replayed them. Pointing it at a live
legacy target added the following, and the adapter itself is one config file:

**All seven of the target's functions, recorded and replaying** — sign on, member inquiry
by number and by last name, member record and balances, funds transfer, open new share,
update member information, and the supervisor-gated account hold.

**Capabilities as a callable API.** `GET /api/catalog` lists only approved capabilities;
`POST /api/catalog/:id/invoke` runs one by name with typed args and returns a structured
result. An entry becomes an Anthropic tool definition with three renames.

**A chatbot that drives that API** and a dashboard that shows every run — its inputs, its
structured result, its status, and the evidence behind it.

**A fifth outcome, `ESCALATED`.** "A supervisor must authorise this" is neither an answer
nor a fault, so it stopped being reported as either. It carries the step, the url and a
screenshot for whoever picks it up.

**Runtime faults classified on HTTP status**, not on page text — `http_status` is now a
checkpoint condition like any other, and the target's six injected faults are declared
once per app rather than in every recording.

**Error rules that belong to the flow**, not to a single step, because "no such member"
surfaces one step after the search that caused it and an expired session can land anywhere.

**Six fixes to the core** that a tidier target had never tested: dropdown labels that carry
live balances, `value_equals` breaking on attribute selectors, checkpoints that could not
reference a caller's parameter, declared inputs no step consumed, a risk classifier with no
callers, and a save path that silently erased fields it did not recognise. Each is its own
commit with the reasoning; the summary is in [ADAPTATION.md](ADAPTATION.md).

---

## Test Bank

This system was tested against legacy bank app (recorded) & bank app SPA (not recorded)
and both are included for testing in [`test-bank`](https://github.com/Nainicorn/test-bank)
This repo is **for testing only**. No real product, no real data, no real credentials. 
It holds two differentiated test cases so the same capability model can be 
proven across two very different DOM shapes.

---

## Setup

Needs Node 20.12 or newer.

```bash
npm install
npx playwright install chromium
cp .env.example .env      # add your ANTHROPIC_API_KEY
npm start                 # starts the app on port 3000
```
---

## Demo: MERIDIAN CORE

The live target is `web-sample.interface-hiring.com`. Its config is committed without
credentials of its own — the demo operators are public, so copy the example and go:

```bash
cp apps/meridian/config.example.json apps/meridian/config.json
npm start
```

Seven capabilities are already recorded and approved in `evidence/meridian/discovery/`,
so nothing needs discovering to demo — a fresh clone can invoke straight away:

```bash
# every capability the agent can see
curl localhost:3000/api/catalog?app_id=meridian | jq '.[].id'

# a balance, by name, with typed args — the shape an outside agent uses
curl -X POST localhost:3000/api/catalog/member-inquiry-shares-lookup/invoke \
  -H 'content-type: application/json' -d '{"params":{"member_number":"100987"}}'
```

### The five outcomes, on the real target

Each of these is one command, and each returns a different outcome:

```bash
# SUCCESS — money actually moves, and a confirmation number comes back
npm run replay -- --id post-funds-transfer --param member_number=100987 \
  --param from_share=100987-S0001 --param to_share=100987-S0070 \
  --param amount=1.00 --param memo=demo

# BUSINESS_OUTCOME — the source share is on HOLD, so the app refuses.
# Not a failure: the answer comes back in the app's own words.
npm run replay -- --id post-funds-transfer --param member_number=100234 \
  --param from_share=100234-S0001 --param to_share=100234-MMKT-3 \
  --param amount=5.00 --param memo=held

# BUSINESS_OUTCOME — no such member
npm run replay -- --id member-inquiry-shares-lookup --param member_number=999999

# ESCALATED — a teller attempting a supervisor-only Place Hold. Same recording,
# credentials swapped for this run only; the values are never written down.
npm run replay -- --id place-account-hold --param member_number=102777 \
  --param share=102777-S0001 --param reason=FRAUD --param notes="teller attempt" \
  --secret MERIDIAN_SUPERVISOR_USERNAME=teller1 \
  --secret MERIDIAN_SUPERVISOR_PASSWORD=password

# ...and the same call without the override posts the hold as the supervisor.
```

A risky capability that has not been approved refuses before a browser opens — try any
of the above with a fresh recording to see the gate rather than the flow.

### Through the chatbot and the dashboard

Open `localhost:3000`, pick **MERIDIAN CORE** in the sidebar, then **Ask** at the
bottom right:

- *"What are the share balances for member 100987?"* — a real replay, real balances.
- *"Transfer $5 from share 100234-S0001 to 100234-MMKT-3 for member 100234."* — comes
  back BUSINESS_OUTCOME with the app's sentence, "Source share is HOLD and cannot be
  debited."

Every run lands in the **Runs** tab with its status, and each row opens a report showing
the inputs it was given, the structured result, the step-by-step trail and the
screenshots. **Agent catalog** is the same list an outside agent sees, invocable inline.

### Forcing a runtime fault

Faults can be injected per request with `?inject=<kind>`, or globally from the target's
own System Settings screen. Globally is the one to show, because it makes an ordinary
capability meet the fault mid-flow:

- `maintenance` (503) → RECOVERABLE, the run takes the host's Continue link and carries on
- `permission` (403) → ESCALATED
- `notfound` (404) → BUSINESS_OUTCOME
- `timeout` (440) → a read-only flow re-runs once; a transfer stops and escalates

Set it back to none afterwards — it is a shared host.


---

## 1. Add your app

In the sidebar, click **+ Add app** and fill in a name, the URL, a goal, and
(optionally) login information. You can edit or delete it later, and there's a section
to limit what the agent is allowed to do on that app.

Same steps from the command line:

```bash
curl -X POST localhost:3000/api/apps -H 'content-type: application/json' -d '{
  "name": "internet",
  "url": "https://the-internet.herokuapp.com/",
  "goal": "Navigate to Add/Remove Elements, add an element once, then remove it"
}'
```

*username/password are only needed if the app you're pointing at requires a login*

This information is saved in `apps/<app_id>/config.json`. Passwords are stored under an environment variable name, not written into any final recording. The AI is only ever told the *name* of where a password lives, never the password itself.

## 2. Record a run

The app's goal is already filled in. Edit it or write your own, hit **Run**, and watch
it happen live. Takes about a minute.

When it succeeds, everything it learned gets saved into that run's folder as
`goal.json` (the ordered steps, what to type where, and how to check that each step
actually worked). That file is the replayable script.

## 3. Replay it, no AI involved

Capabilities tab → hit the replay icon. Takes about 5 seconds: no AI thinking, just
running the saved steps and checking each one against what it expects to see.

## 4. Look at what happened

The Runs tab lists every run, newest first, with its outcome. Click the report icon on
any row to see the outcome, the steps taken, every screenshot, and, for AI runs, how
much it cost.

## Prefer the terminal?

Everything above also works from the command line:

```bash
npm start

# record a new capability
npm run discover -- --app-id internet \
  --goal "Navigate to Add/Remove Elements, add an element once, then remove it"

# see what got saved
cat evidence/internet/discovery/<stamp>/goal.json

# replay it, no AI
npm run replay -- --id add-remove-elements-cycle --headed

# replay it 5x in a row and see how often it holds
npm run stability -- --id add-remove-elements-cycle --runs 5

# turn it into a standalone Playwright script — a snapshot for a human to read or adapt
npm run generate -- --id add-remove-elements-cycle --out ./add-remove-elements-cycle.spec.js
BASE_URL=https://the-internet.herokuapp.com node ./add-remove-elements-cycle.spec.js

# see if any recorded route looks tenant-specific (a suggestion only, nothing is rewritten)
npm run canonicalize -- --id add-remove-elements-cycle

# replay it as if for a different tenant with a declared override (see REPORT.md §4)
npm run replay -- --id add-remove-elements-cycle --tenant <tenant-id>

# approve it, so an outside agent can call it
curl -X PATCH localhost:3000/api/capabilities/add-remove-elements-cycle/status \
  -H 'content-type: application/json' -d '{"status":"approved"}'

# call it by name, the way an agent would
npm run invoke -- --id add-remove-elements-cycle

# or let a real AI pick the right capability and fill in the details itself
npm run agent-demo -- "add an element on the page and then remove it again"
```

## Try it with what's already saved

`/evidence/` already has a recorded discovery run committed to this repo, under
`evidence/internet/`, holding a capability called `add-remove-elements-cycle`. You just
need to register the practice app it points at. App configs aren't committed, since
they're where credentials would live, even though this particular one needs none:

```bash
npm start
curl -X POST localhost:3000/api/apps -H 'content-type: application/json' -d '{
  "name": "internet",
  "url": "https://the-internet.herokuapp.com/"
}'

npm run replay -- --id add-remove-elements-cycle --headed
```

## Escalation: when it needs a human

Start a run with a small step limit (or just wait for it to genuinely get stuck): it
pauses with the browser still open, and shows up in the console as a pending request
with a screenshot and the reason. You take over that same browser, do whatever's
needed, hit **Resume**, and the AI keeps going from wherever you left it. Every human
action gets logged too, right alongside the AI's.

## Letting an outside agent use a capability

A person has to approve a capability before any outside agent can even see it. A
capability that hasn't been approved is invisible, not just blocked. Once approved:

```bash
npm run invoke                             # the catalog an agent can see, empty until something's approved

curl -X PATCH localhost:3000/api/capabilities/<capability-id>/status \
  -H 'content-type: application/json' -d '{"status":"approved"}'

npm run invoke -- --id <capability-id> --param member_id=12345
```

Or let a real model choose which capability to call and fill in the arguments itself:

```bash
npm run agent-demo -- "add an element on the page and then remove it again"
```

Revoke it and run that again. The model is simply told it has no tools available.
Approval is what decides what an agent is allowed to do.

---

## What a replay can come back with

| Outcome | What it means | What you do |
|---|---|---|
| `SUCCESS` | Worked, here's the data | Use the outputs |
| `BUSINESS_OUTCOME` | A real, expected answer, like "no such member" | Treat it as an answer, not an error |
| `RECOVERABLE` | Hit a known hiccup (like a cookie banner), handled it, kept going | Nothing, it just worked |
| `HARD_FAILURE` | Something didn't match what was expected | Look at the screenshot, the step, and what it saw instead |
| `ESCALATED` | The flow hit something only a person with more authority can do | Read what it needs and who has to do it, then finish it by hand |

The important one is `BUSINESS_OUTCOME`. The system is built to tell "the app gave a
normal answer" apart from "something actually broke."

`ESCALATED` is the other one worth knowing. It is neither: nothing is broken, and no
amount of retrying by the same caller will finish the work. A teller asking to place an
account hold gets this, with the step, the page and a screenshot for whoever picks it up.

---

## Why it's built this way

- **Never just one way to find a button.** Each step lists a few ways to find it, most
  reliable first: its role and name, then its label, then visible text, then CSS as a
  last resort. If more than one thing matches, it stops and asks rather than guessing.
- **One shared set of actions.** The AI, the replay, and the human operator all use the
  exact same five actions (go to a page, click, type, read, wait). None of them has a
  shortcut, so what gets recorded is exactly what gets replayed.
- **The AI never sees a password.** It only ever sees the *name* of where a credential
  lives; the real value gets filled in afterward, outside its view.
- **Every action is logged, from all three sources** (AI, replay, human) into one
  shared, readable trail.
- **Capabilities are plain files, not database rows,** so anyone can open one and read
  exactly what it does, with no special tool.

---

## Tests

```bash
npm test
```

- `tests/policy.test.js`: checks the safety rules actually hold. Blocked pages stay
  blocked, passwords never leak into logs.
- `tests/invariants.test.js`: checks a few core promises by reading the actual code,
  like making sure replay never quietly starts using the AI.
- `tests/schema.test.js`: checks a saved capability's format is validated correctly.
- `tests/agent-demo.js`: not an automated test, but a small script that plays the role
  of an outside AI assistant calling your approved capabilities over HTTP, to prove that
  actually works end to end.

## Where everything lives

```
src/schema/     # valid capability
src/engine/     # five actions
src/policy/     # safety rules
src/agent/      # AI's loop (tools, human handoff, etc.)
src/api/        # web server the UI console talks to
src/evidence/   # saves the screenshots and logs for every run
src/cli/        # runnable scripts from terminal
tests/          # automated checks, plus agent-demo for stretch goal
ui/             # the UI CAS console
apps/           # one folder per app added and its config
evidence/       # one folder per run and its metadata
docs/           # assignment saved & design notes
```
