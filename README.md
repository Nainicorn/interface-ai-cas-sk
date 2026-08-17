# Computer-Use Automation System

This system is designed for legacy bank apps that have no API. An AI agent "discovers" the app to figure out how to perform a specific task (user given goal).

If the agent is successful the flow gets saved as a typed, versioned "capability" that can run with no model involved at all, as it is just a replay of recorded steps (cost and time efficient).

If either the agent or the replay gets stuck, a human can take over during the live session and can either hand back control, manually interact with the session, or give the agent some extra guidance.

Diagrams of the entire flow of the application are in [docs/DESIGN.md](docs/DESIGN.md).

---

## Test fixtures

This system is exercised against
[`test-bank`](https://github.com/Nainicorn/test-bank) (local sibling folder:
[`../mock-bank`](../mock-bank)) — a repo of **mock bank apps for testing only**. No
real product, no real data, no real credentials. It holds two differentiated test
cases so the same capability model can be proven across two very different DOM shapes:

- **[`legacy`](https://github.com/Nainicorn/test-bank/tree/main/legacy)** — hostile,
  server-rendered, no ids or `data-testid`
- **[`spa`](https://github.com/Nainicorn/test-bank/tree/main/spa)** — clean, modern
  SPA counterpart

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

## 1. Add your app

In the sidebar, click **+ Add app** and fill in a name, the URL, a goal, and
(optionally) login information. You can edit or delete it later, and there's a section
to limit what the agent is allowed to do on that app.

Same steps from the command line:

```bash
curl -X POST localhost:3000/api/targets -H 'content-type: application/json' -d '{
  "name": "internet",
  "url": "https://the-internet.herokuapp.com/",
  "goal": "Navigate to Add/Remove Elements, add an element once, then remove it"
}'
```

*username/password are only needed if the app you're pointing at requires a login*

This information is saved in `artifacts/<app_id>/config.json`. Passwords are stored under an environment variable name, not written into any final recording. The AI is only ever told the *name* of where a password lives, never the password itself.

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

# approve it, so an outside agent can call it
curl -X PATCH localhost:3000/api/artifacts/add-remove-elements-cycle/status \
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
curl -X POST localhost:3000/api/targets -H 'content-type: application/json' -d '{
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

curl -X PATCH localhost:3000/api/artifacts/<capability-id>/status \
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

The important one is `BUSINESS_OUTCOME`. The system is built to tell "the app gave a
normal answer" apart from "something actually broke."

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
public/         # the UI CAS console
artifacts/      # one folder per app added and its config
evidence/       # one folder per run and its metadata
docs/           # assignment saved & design notes
```
