# Computer-Use Automation System

This lets an AI agent learn to use a website by trying it once, then replay what it
learned later without needing the AI at all — fast, cheap, and the same result every
time. If it gets stuck, a real person can jump into the same browser window, help it
out, and hand control back.

In short: the AI discovers the steps once. Those steps get saved as a **capability**.
From then on, running that capability doesn't need the AI at all.

---

## Setup

Needs Node 20.12 or newer.

```bash
npm install
npx playwright install chromium
cp .env.example .env      # add your ANTHROPIC_API_KEY
npm start                 # starts the app on port 3000
```

You point this at your own website — nothing ships built in. Use a test site you're
allowed to automate, never real logins or real personal data.

You only need an API key for recording a new capability — that's the only step that
calls the AI. Everything else (replaying a saved capability, browsing the catalog,
approving one, viewing a report) works with no key, using what's already in this repo.

---

## 1. Add your app

In the sidebar, click **+ Add app** and fill in a name, the URL, a goal, and
(optionally) a login. That's it. You can edit or delete it later, and there's a section
to limit what the agent is allowed to do on that app.

Same thing from the command line:

```bash
curl -X POST localhost:3000/api/targets -H 'content-type: application/json' -d '{
  "name": "internet",
  "url": "https://the-internet.herokuapp.com/",
  "goal": "Navigate to Add/Remove Elements, add an element once, then remove it"
}'
```

(username/password are only needed if the app you're pointing at requires a login — this
practice site has a page that doesn't.)

Where this is saved: `artifacts/<app_id>/config.json` — kept out of git, since it holds
logins. Passwords are stored under an environment variable name, not written into any
recording. The AI is only ever told the *name* of where a password lives, never the
password itself.

## 2. Record a run

The app's goal is already filled in — edit it or write your own, hit **Run**, and watch
it happen live. Takes about a minute.

When it succeeds, everything it learned gets saved into that run's folder as
`goal.json` — the ordered steps, what to type where, and how to check that each step
actually worked. That file *is* the replayable script; nothing gets generated from it.

## 3. Replay it — no AI involved

Capabilities tab → hit the replay icon. Takes about 5 seconds: no AI thinking, just
running the saved steps and checking each one against what it expects to see.

## 4. Look at what happened

The Runs tab lists every run, newest first, with its outcome. Click the report icon on
any row to see the outcome, the steps taken, every screenshot, and — for AI runs — how
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

# replay it — no AI
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
need to register the practice app it points at — app configs aren't committed, since
they're where credentials would live, even though this particular one needs none:

```bash
npm start
curl -X POST localhost:3000/api/targets -H 'content-type: application/json' -d '{
  "name": "internet",
  "url": "https://the-internet.herokuapp.com/"
}'

npm run replay -- --id add-remove-elements-cycle --headed   # SUCCESS, no LLM involved
```

## Escalation: when it needs a human

Start a run with a small step limit (or just wait for it to genuinely get stuck): it
pauses with the browser still open, and shows up in the console as a pending request
with a screenshot and the reason. You take over that same browser, do whatever's
needed, hit **Resume**, and the AI keeps going from wherever you left it. Every human
action gets logged too, right alongside the AI's.

## Letting an outside agent use a capability

A person has to approve a capability before any outside agent can even see it — a
capability that hasn't been approved is invisible, not just blocked. Once approved:

```bash
npm run invoke                             # the catalog an agent can see — empty until something's approved

curl -X PATCH localhost:3000/api/artifacts/<capability-id>/status \
  -H 'content-type: application/json' -d '{"status":"approved"}'

npm run invoke -- --id <capability-id> --param member_id=12345
```

Or let a real model choose which capability to call and fill in the arguments itself:

```bash
npm run agent-demo -- "add an element on the page and then remove it again"
```

Revoke it and run that again — the model is simply told it has no tools available.
Approval is what decides what an agent is allowed to do.

---

## What a replay can come back with

| Outcome | What it means | What you do |
|---|---|---|
| `SUCCESS` | Worked, here's the data | Use the outputs |
| `BUSINESS_OUTCOME` | A real, expected answer — like "no such member" | Treat it as an answer, not an error |
| `RECOVERABLE` | Hit a known hiccup (like a cookie banner), handled it, kept going | Nothing — it just worked |
| `HARD_FAILURE` | Something didn't match what was expected | Look at the screenshot, the step, and what it saw instead |

The important one is `BUSINESS_OUTCOME` — the system is built to tell "the app gave a
normal answer" apart from "something actually broke."

---

## Why it's built this way

- **Never just one way to find a button.** Each step lists a few ways to find it, most
  reliable first — its role and name, then its label, then visible text, then CSS as a
  last resort. If more than one thing matches, it stops and asks rather than guessing.
- **One shared set of actions.** The AI, the replay, and the human operator all use the
  exact same five actions (go to a page, click, type, read, wait). None of them has a
  shortcut, so what gets recorded is exactly what gets replayed.
- **The AI never sees a password.** It only ever sees the *name* of where a credential
  lives; the real value gets filled in afterward, outside its view.
- **Every action is logged, from all three sources** — AI, replay, and human — into one
  shared, readable trail.
- **Capabilities are plain files, not database rows** — so anyone can open one and read
  exactly what it does, with no special tool.

---

## Tests

```bash
npm test
```

- `tests/policy.test.js` — checks the safety rules actually hold: blocked pages stay
  blocked, passwords never leak into logs.
- `tests/invariants.test.js` — checks a few core promises by reading the actual code,
  like making sure replay never quietly starts using the AI.
- `tests/schema.test.js` — checks a saved capability's format is validated correctly.
- `tests/agent-demo.js` — not an automated test, but a small script that plays the role
  of an outside AI assistant calling your approved capabilities over HTTP, to prove that
  actually works end to end.

## Where everything lives

```
src/schema/     what a valid capability is allowed to look like, and saving/loading them
src/engine/     the five actions, finding things on the page, replay, and recovery
src/policy/     the safety rules — what's allowed, what's risky, hiding passwords
src/agent/      the AI's loop, its tools, saving what it learns, human handoff
src/api/        the web server the console talks to
src/evidence/   writes the screenshots and logs for every run
src/cli/        the same things, runnable from a terminal
tests/          the automated checks, plus agent-demo.js (a stand-in outside AI)
public/         the website itself — sidebar, forms, tabs, report page
artifacts/      one folder per app you added: its config (gitignored — it holds logins)
evidence/       one folder per run: screenshots, log, result, and its goal.json if it succeeded
docs/           the assignment brief, the design notes
```

Working rules are in [CLAUDE.md](CLAUDE.md); what's left to do is in REPORT.md's
Cuts section.
