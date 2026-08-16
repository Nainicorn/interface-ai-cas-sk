# Computer-Use Automation System

An LLM drives a legacy web application once to work out how a task is done. That run is
recorded as a **typed, versioned capability**. From then on, an AI agent invokes the
capability through deterministic replay — no model in the decision loop, at a fraction of
the cost, with a result contract that distinguishes *"no such member"* from *"something
broke"*. When either path gets stuck, a human takes over the **same live browser session**
and hands control back.

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is
> how a production agent invokes it.

---

## Setup

Requires **Node 20.12+** (developed on 26).

```bash
npm install
npx playwright install chromium
cp .env.example .env      # then add your ANTHROPIC_API_KEY
npm start                 # control plane + console on port 3000
```

No target application ships with this repo — you point the system at **your own** web app
and record against it live. Use a sandbox or demo application you are permitted to
automate, and never real credentials or real PII (this is the assignment's ground rule and
ours).

**What needs an API key:** only discovery — it is the one path that calls a model, and the
brief requires it to be real. Everything downstream runs without one: replaying a committed
capability, the agent catalog, invoking by name, the operator console, and every run report.
So a reviewer with no key can still see the whole production path work against the committed
evidence (see *Replay the committed evidence* below); a key is needed only to record a new
capability of your own.

---

## 1. Register your application

In the console sidebar, hit **+ Add app**: friendly name, URL, a default goal, and
optionally a login. That's the whole form. The pencil on each app row edits or deletes it
later, and a collapsed **Permissions** section narrows what the agent may do. The same
thing over HTTP:

```bash
curl -X POST localhost:3000/api/targets -H 'content-type: application/json' -d '{
  "name": "The Internet",
  "url": "https://the-internet.herokuapp.com/login",
  "goal": "Log in and read the message shown in the secure area",
  "username": "tomsmith",
  "password": "SuperSecretPassword!"
}'
```

(`PUT /api/targets/<app_id>` edits, `DELETE /api/targets/<app_id>` removes.)

Where everything lives — nothing about your app lives in code:

- `artifacts/<app_id>/config.json` is the app: name, URL, goal, credentials, and its
  permissions. **Gitignored**, because it carries logins. A `config.example.json` ships in
  its place. The app id is the slug of the name, so there is one identifier, not two that
  can disagree.
- Credentials keep an env-name indirection: the config's values are pushed into
  `process.env` under derived names (`<APP_ID>_PASSWORD`), and only the **names** travel
  into the prompt and the recording. The model chooses where a password goes; it never
  learns what it is. Those names are also unioned into the redaction list, so the value
  behind one is a shape (`<string:13>`) in every transcript.
- **A run is its folder.** `evidence/<app>/<kind>/<stamp>/` holds `transcript.jsonl`,
  numbered screenshots, and `result.json` — and, if the run produced one, the recorded
  capability as `goal.json`. There is no database and no separate artifacts tree: the
  recording sits beside the evidence proving it ran.
- The agent can never leave your app's origin — that is structural, and no permission
  setting widens it. Allowed paths default to `/` (the whole app) for a friction-free
  start; narrow them whenever you want, and mark risky paths so they need approval before
  they can replay unattended. Action types default to the five primitives (`navigate`,
  `click`, `type`, `read`, `wait_for`); unticking one removes it from the LLM, from
  replay, and from the operator alike.

## 2. Record a test run

From the console: the app's goal is prefilled in the prompt box — edit it or write a new
one, hit **Run**, and watch it happen in the live viewer.

One real LLM-driven run (`claude-sonnet-5`, headed Chromium, ~1 min). The recording lands
in that run's own folder as `goal.json` — ordered steps, ranked locator candidates, typed
inputs and outputs, a success checkpoint. That file **is** the script; no code is generated
from it. A discovery folder *with* a `goal.json` passed its gates and is replayable; one
without did not.

## 3. Replay it — deterministically

Capabilities tab → the **replay icon**. The result lands in Runs; the capability's
reliability chip ticks up in place (`untested` → `2/2`, tinted if anything failed).

No model in the loop — stable locators, explicit waits, checkpoint verification, ~5s.
Every replay resolves to one of the four outcomes below, stores a full report, and writes
a rolling reliability signal (`confidence`) back into the recording.

## 4. Review every run

The console's **Runs** table lists every run — discovery and replay, newest first, with its
outcome. A replay that an outside agent invoked carries an `agent` badge, and one started
from the terminal a `cli` badge, so a run something else triggered is never mistaken for a
button press. Each row's **Report** icon opens the run in a new tab: outcome banner,
configuration, the step-by-step trail, the screenshot gallery, and token usage for
discovery runs. The page is a read-only projection of the run's folder — the transcript,
screenshots, and result written as the run happened — and keeps updating while a run is
live.

## Prefer the terminal? The same flow, CLI end to end

The CLI drives the same engine through the same gates — runs made here appear in the
console too. Worked example against a public practice site:

```bash
npm start                                  # control plane; registration and catalog are HTTP

# 1. Register (same payload the modal sends — see section 1 for the curl)

# 2. Record: one real LLM run, headed Chromium. The CLI takes any free-text goal.
npm run discover -- --app-id the_internet \
  --goal "Log in and read the message shown in the secure area"
#    → prints status, run id, evidence folder, token usage, and the capability id

# 3. Inspect the recording and the evidence — both live in the run's folder
ls evidence/the_internet/discovery/<stamp>/   # transcript.jsonl, screenshots, result.json
cat evidence/the_internet/discovery/<stamp>/goal.json

# 4. Replay — no LLM. Exit 0 = SUCCESS or BUSINESS_OUTCOME, 1 = HARD_FAILURE.
npm run replay -- --id <capability-id> --headed

# 5. The agent's-eye view: approve, then invoke by name over HTTP
npm run invoke                             # catalog — empty until something is approved
curl -X PATCH localhost:3000/api/artifacts/<capability-id>/status \
  -H 'content-type: application/json' -d '{"status":"approved"}'
npm run invoke -- --id <capability-id> --param member_id=12345

# 6. Or let a real model choose the capability and fill in its arguments:
npm run agent-demo -- "log in and read the secure-area message"

# 7. The report for any run, CLI-made or not:
#    open localhost:3000/report.html?run=<run-id> — or read the run folder's result.json
```

## Replay the committed evidence

The recordings in `/evidence/` are committed; the app config they point at is not (it holds
credentials — `artifacts/*/config.json` is gitignored). Register the practice app once and
they replay as recorded:

```bash
npm start
curl -X POST localhost:3000/api/targets -H 'content-type: application/json' -d '{
  "name": "Heroku App",
  "url": "https://the-internet.herokuapp.com/login",
  "goal": "Log in with the supplied username and password, then read the confirmation message in the secure area",
  "username": "tomsmith", "password": "SuperSecretPassword!"
}'

npm run replay -- --id heroku-app-login --param username=tomsmith      # SUCCESS
npm run replay -- --id heroku-app-login --param username=no-such-user  # BUSINESS_OUTCOME
```

Those are the practice site's own publicly documented test credentials.
[/evidence/README.md](evidence/README.md) says which five runs tell the story.

### Proof of work

`artifacts/` and `evidence/` ship empty and fill as you use the system — every run writes
its own folder. The development history is preserved in git: the
`lookup-member-savings-account` v1→v4 story (a weak locator caught by replay as a
`HARD_FAILURE`, fixed after the engine learned to report ambiguity samples, business
outcomes declared from foresight by v4) and the original discovery / replay / escalation
evidence all live in this repo's earlier commits. The evidence set that ships at
submission is recorded fresh — see [PLAN.md](PLAN.md).

### Escalation & handoff (the operator console)

Start a run with a small max-turns budget (or wait for a genuine escalation): the run
**pauses with the browser session held open**, an intervention appears in the operator
panel with the reason and a screenshot, and the operator drives the *same live page*
through the same action primitives the agent uses — then hits **Resume**, and the agent
continues from whatever state the human left. Every human step lands in the same evidence
trail, tagged `actor: "human"`.

The same handoff is scriptable over HTTP (`/api/escalations`), which is how the committed
evidence run with `paused`/`resumed` events was produced.

### Stretch goals: the agent-facing catalog & the approval gate

Two are built, and they are one idea: **a human approves a recording, an agent can then
call it by name, and the system tracks whether it keeps working.**

```bash
# The catalog an agent sees. Empty until something is approved — a draft is not
# "listed but refused", it is invisible, whatever its risk level.
npm run invoke

# The one human act the system never grants itself (also a button in the console):
curl -X PATCH localhost:3000/api/artifacts/<capability-id>/status \
  -H 'content-type: application/json' -d '{"status":"approved"}'

# Invoke by name with typed args — over HTTP, as an agent would:
npm run invoke -- --id <capability-id> --param member_id=12345
```

Catalog entries are deliberately shaped like tool definitions (`name`, `description`,
`input_schema`) — exactly what a function-calling agent needs to decide whether and how to
call one, and nothing about *how* the flow is implemented, which it has no business
reasoning about.

That shape is why `tests/agent-demo.js` needs no adapter: it GETs the catalog, hands it
to Claude as `tools`, and lets the model pick one and fill in its arguments.

```bash
npm run agent-demo -- "log in and read the secure-area message"
```

Revoke the capability and run it again — the model is told it has no tools at all. A
human's approval decision is what an agent is able to do.

The gate bites in both directions. A **risky** capability is refused unattended replay
until approved (403 before a run row or evidence folder exists, because a refusal says
nothing about the recording). An **approved** capability cannot be deleted, and neither
can the run holding it, until it is revoked — nothing an agent may be calling right now
vanishes on one click.

After two clean invokes the recording reads `"confidence": { "runs": 2, "successes": 2 }`
and its chip shows `2/2`.

---

## The result contract

Every replay resolves to exactly one of four outcomes. The second one is the reason this
contract exists:

| Outcome | Meaning | Caller does |
|---|---|---|
| `SUCCESS` | Checkpoint verified, typed outputs extracted | Use the outputs |
| `BUSINESS_OUTCOME` | A legitimate answer — "no such member", "permission denied" | **Handle as data, not an error** |
| `RECOVERABLE` | A known interstitial was cleared, execution continued | Nothing |
| `HARD_FAILURE` | Nothing matched | Debug: step, expectation, observation, every locator tried, screenshot |

Collapsing `BUSINESS_OUTCOME` into `HARD_FAILURE` is the most common way this problem gets
got wrong, so business outcomes are **declared in the artifact** and checked *before* the
success checkpoint — and again if a locator resolves to nothing, because a missing element
is sometimes the answer rather than a fault.

---

## Design decisions worth defending

**Ranked locator candidates, never one selector.** Legacy targets have no test IDs, so any
single selector is a guess. Each step carries an ordered candidate list; the first that
resolves to exactly **one** visible element wins. A candidate matching several elements is
*rejected*, not silently `.first()`-ed — and the rejection reports each match's ancestor
path, which is how the discovery model (blind to the DOM) finds the attribute that scopes
its next attempt.

**One shared action layer.** The LLM path, the replay path, and the human operator all call
the same five primitives in `src/engine/actions.js`. The model never "just clicks" — it
chooses which primitive to invoke, exactly as replay does. The policy gate runs as the first
line of each, so no caller can forget it.

**The model never sees a secret.** Credentials are referenced by env var *name*; the
harness resolves the value after the model has chosen where to type it, and the name is
what reaches the recording — so the artifact is publishable and the replay path resolves
the same way. Caller data is typed via named parameters (`value_from`), which is also what
keeps recordings parameterized.

**Ownership + a mutex, not vibes.** A paused run keeps its Playwright session open. An
explicit `owner` flag says who *should* act; a per-run async mutex says who *is* acting —
because Node's single thread does not stop two async handlers interleaving on one page.

**The accessibility tree is the primary perception channel**, not the DOM and not the
screenshot. It exists on legacy web apps and native desktop apps alike. Swapping Playwright
for an OS accessibility API later changes one file.

**Artifacts are files, not rows.** "Reviewable" is a requirement, and a JSON file is
diffable in a code review. There is no database at all: a run is a folder, `result.json` is
its record, and the recording it produced sits in that same folder as `goal.json`. Folder
names sort chronologically, so the history needs no index that could disagree with it.

---

## Tests

**There is no test suite in this repo, and that is a deliberate cut.** An earlier one was
removed with the MVP restructure and re-adding it was not the best use of the remaining
time; the checks that survive are structural rather than assertive — the policy gate opens
every action primitive so no caller can bypass it, and `src/engine/replay.js` imports no
LLM SDK, which is the one invariant the whole determinism claim rests on. `REPORT.md`
lists this under Cuts. What a reviewer can run instead is the demo path above end to end:
record, replay, approve, invoke.

## Layout

```
src/schema/     Zod capability schema, the on-disk store, parameter validation
src/engine/     perception, ranked locator resolution, action primitives, replay, recovery
src/policy/     the allowlist gate, redaction, risk classification + approval predicates
src/agent/      discovery loop, LLM tools, artifact writer, escalation & session ownership
src/api/        control plane: targets, runs, artifacts (operator), capabilities (agents)
src/evidence/   RunLogger, the run index, the report projection the report page reads
src/cli/        discover, replay, invoke (the agent's-eye view, over HTTP)
tests/          invariants, policy, schema — plus agent-demo.js, a real model calling the catalog (not part of the system)
public/         console: sidebar, app modal, runs/capabilities/catalog tabs, report page
artifacts/      one folder per app: config.json (gitignored — it holds logins)
evidence/       one folder per run: transcript, screenshots, result, and its goal.json
docs/           the assignment, PLAN.md, DESIGN.md
```

Working agreement in [CLAUDE.md](CLAUDE.md); remaining work in [PLAN.md](PLAN.md).
