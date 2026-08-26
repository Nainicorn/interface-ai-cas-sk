# SCRIPT.md — the full demo, against the legacy bank

Every command below was run end to end against `mock-bank/legacy` and the output is
what it actually printed. Two passes: **the CLI** (Part A), then **the console** (Part B),
covering the same ground so you can show either.

---

## Setup

Two servers. Leave both running.

```bash
# 1. the legacy bank being automated
cd ../mock-bank/legacy && npm start          # → http://localhost:3001

# 2. this system
cd interface-ai-cas-sk && npm start          # → http://localhost:3000
```

Register the app if it isn't already (`apps/` is gitignored, so a fresh clone needs this):

```bash
curl -X POST localhost:3000/api/apps -H 'content-type: application/json' -d '{
  "name": "legacy bank",
  "url": "http://localhost:3001",
  "goal": "login and search up member 10001 and record the number of accounts the member has",
  "username": "teller01",
  "password": "demo-password",
  "risky_route_patterns": ["/open-account"]
}'
```

### The cast

The bank is built so every branch has a fixed input — nothing is random.

| Input | What happens |
|---|---|
| `10001` Alice Nguyen | Active, 2 accounts — the happy path |
| `10002` Marcus Bell | Active, 1 account |
| `40000` Dana Whitfield | **Locked** — risky actions are refused |
| `99999` | **Does not exist** — not-found |
| wrong password | login rejected |
| `Savings` + deposit `100` | opens a sub-account — the risky, state-changing flow |
| deposit below `25` | rejected, below the minimum |

Login is `teller01` / `demo-password`.

---

# Part A — the CLI

## A1. The tests, including the ones that read the source

```bash
npm test
```
```
ℹ tests 64
ℹ pass 64
ℹ fail 0
```

**Say:** three of these don't test behaviour, they test the source text — that replay
never imports the AI SDK, that every action starts with the safety gate, and that only
one file in the repo knows how to click. Those are the design claims, so they're checked
by reading the file rather than trusting a comment.

## A2. Discovery — the AI works out a flow it has never seen

```bash
npm run discover -- --app-id legacy_bank \
  --goal "Log in and search for member 10002, then read their full name from the member detail page"
```
```
Status:   recorded
Run:      legacy_bank/discovery/2026-08-26_220030 (8 model turns)
Artifact: lookup-member-full-name v1 → .../goal.json
```

**Say:** 8 turns. Each turn it saw the page as an accessibility tree, picked one of five
moves, and the page changed. At the end it wrote the recipe — and the recipe was only
accepted after the system re-checked, on the live page, that the success condition it
claimed actually held.

Open the run folder and show `goal.json` sitting next to the screenshots that prove it ran.

## A3. Replay it — no AI at all

```bash
npm run replay -- --id get-member-account-count --param member_id=10001
```
```
Outcome:  SUCCESS
Outputs:  {"accounts_table_text":"Account Number\tType\tOpened\tBalance
           CHK-10001-01\tChecking\t2014-03-11\t$2450.75
           SAV-10001-01\tSavings\t2016-07-02\t$18320.40"}
```

**Say:** about a second, no model, no cost. Same steps every time.

## A4. The four outcomes

This is the heart of it. Same recipe, four different endings.

### SUCCESS — shown above

### BUSINESS_OUTCOME — a member who doesn't exist

```bash
npm run replay -- --id get-member-account-count --param member_id=99999
```
```
Outcome:  BUSINESS_OUTCOME
Business: {"code":"MEMBER_NOT_FOUND","message":"No member exists with the given member ID.",
           "step":4,"intent":"Submit the member search"}
```

**Say:** this is the one that matters. "No such member" is a real answer, not a crash.
The step's success check failed too — but the recipe declared ahead of time what a
legitimate not-found looks like, and that gets checked *first*. Check success first and
you'd report a crash for a perfectly good answer. The brief calls this the most common
design mistake in the problem.

### BUSINESS_OUTCOME — a bad password

```bash
npm run replay -- --id get-member-account-count --param member_id=10001 \
  --secret LEGACY_BANK_PASSWORD=wrong-password
```
```
Outcome:  BUSINESS_OUTCOME
Business: {"code":"LOGIN_FAILED","message":"Login was rejected due to invalid credentials.",
           "step":2,"intent":"Submit login form"}
```

**Say:** two things at once — a second declared business outcome, and per-call
credentials. `--secret` runs the same recipe as a different user without editing the app
or re-recording, because the recipe stores the credential's *name*, never its value.

### HARD_FAILURE — refused before the browser even opens

```bash
npm run replay -- --id get-member-account-count --param bogus=x
```
```
Outcome:  HARD_FAILURE
Failure:  {"step": "pre-flight", "error_type": "ParameterValidationError",
           "message": "Invalid parameters: \"bogus\" is not an accepted parameter"}
```

**Say:** the inputs are typed, so a bad call is rejected at the boundary rather than
halfway through a flow with the browser already open.

### RECOVERABLE — see A8, it needs the assisted-fallback setup

## A5. Secrets never reach the log

```bash
grep -o '"field":"[^"]*","value":"[^"]*","redacted":[a-z]*' \
  evidence/legacy_bank/replay/<newest>/transcript.jsonl
```
```
"field":"LEGACY_BANK_USERNAME","value":"<string:8>","redacted":true
"field":"LEGACY_BANK_PASSWORD","value":"<string:13>","redacted":true
"field":"member_id","value":"40000","redacted":false
```

**Say:** the browser got the real password — it had to, it logged in. The log got its
length. And notice `member_id` is *not* redacted: the rule is selective, not a blanket
"hide everything", because a replay that searched the wrong member would be undebuggable
otherwise. The `redacted` flag is written either way, so you can see the rule ran.

## A6. Multi-run stability *(stretch goal)*

```bash
npm run stability -- --id get-member-account-count --runs 5 --param member_id=10001
```
```
  run 1/5  ✓ SUCCESS
  run 2/5  ✓ SUCCESS
  run 3/5  ✓ SUCCESS
  run 4/5  ✓ SUCCESS
  run 5/5  ✓ SUCCESS

100% held  (5/5)
```

**Say:** no special test mode. It calls the same replay function five times, through the
same approval gate, writing five real evidence folders.

## A7. Code generation *(stretch goal)*

```bash
npm run generate -- --id get-member-account-count --out ./bank.spec.js
sed -i '' "s/'REPLACE_ME'/'10001'/" ./bank.spec.js

LEGACY_BANK_USERNAME=teller01 LEGACY_BANK_PASSWORD=demo-password \
  BASE_URL=http://localhost:3001 node ./bank.spec.js
```
```
Wrote ./bank.spec.js  (81 lines, 6 steps)
Outputs: { accounts_table_text: 'CHK-10001-01\tChecking...' }
```

**Say:** plain Playwright, runs with `node`, nothing from this system involved. Open it
and show the `// fallback if this breaks:` comments — the recipe carries several ways to
find each button, the script uses the best one and leaves the rest as notes rather than
reimplementing the fallback logic as a second, unmaintained copy.

## A8. Assisted fallback *(stretch goal)* — and RECOVERABLE

The capability discovered in A2 recorded a locator the model never actually executed.
Replay catches it:

```bash
npm run replay -- --id lookup-member-full-name --param member_id=10002
```
```
Outcome:  HARD_FAILURE
Failure:  {"step": 6, "error_type": "LocatorResolutionError",
           "message": "Could not resolve \"Member Name value cell\" — all 1 candidate(s) failed"}
```

Now opt in to one AI call:

```bash
npm run replay -- --id lookup-member-full-name --param member_id=10002 --assisted-fallback
```
```
Replaying lookup-member-full-name v1 (assisted fallback ON — up to one LLM call if a locator fails)…
Outcome:  RECOVERABLE
Outputs:  {"member_full_name":"Marcus Bell"}
Assisted: [{"step":6,"reasoning":"The accessibility tree shows a row \"Name Marcus Bell\"
  with two cells: label 'Name' and value 'Marcus Bell', so targeting the cell containing
  'Marcus Bell' directly or via a sibling selector relative to the 'Name' label cell
  should reliably locate the same element."}]
```

**Say — this is the best single moment in the demo.** Three things at once:

1. **Discovery isn't always right.** It recorded a guess. That's why a new recipe is a
   *draft* and why the score exists.
2. **Replay caught it**, with the step, the selector, and what it tried.
3. **One bounded AI call fixed it** — and the answer is right: member 10002 really is
   Marcus Bell. Note the outcome is `RECOVERABLE`, not `SUCCESS`, so the run is honest about
   having needed help.

**Warning before you demo this live: the rescue is not reliable.** Measured over four
runs it recovered twice and hard-failed twice. That is not a bug — it is a real model
call getting exactly one attempt, and if the locator it suggests doesn't resolve, or the
step's checkpoint still doesn't hold, that counts as no recovery and there is no second
try. So rehearse it, and if it hard-fails in the room, say that:

> "It gets one shot and no retries. Half the time that's enough. I'd rather it fail
> honestly than keep calling a model until something sticks — that would turn a bounded
> recovery into an open-ended loop, which is the thing the whole design is avoiding."

The HARD_FAILURE half of this demo *is* deterministic, so lead with that.

**The recorded-a-guess part is reproducible, though.** Every discovery run against this
bank's table layout records an unverified CSS selector for the final `read`. The system
prompt explicitly tells the model to execute a read before recording it; it consistently
doesn't. That is a genuine weakness worth naming — and precisely why a new recording is a
draft with a score attached rather than something the system trusts.

And it's boxed in: off by default, at most once per replay, only when a locator can't be
found at all, and it can suggest nothing but another way to find the same element.

## A9. Canonicalization *(stretch goal)*

```bash
npm run canonicalize -- --id get-member-account-count
```
```
get-member-account-count: no route looks tenant-specific — already as canonical as it gets.
```

**Say:** it looks for web addresses that bake in one customer's data (`/members/12345` →
`/members/:id`). It only ever suggests — a string of digits might be a genuinely fixed
product code, and that call belongs to a person.

## A10. The agent catalog *(stretch goal)*

```bash
npm run invoke
```
```
  get-member-account-count  v1  [safe]  9/9 replays ok
    Logs into the Corevance Core Banking Admin, searches for a member by numeric member ID...
    args: member_id: string
```

```bash
npm run invoke -- --id get-member-account-count --param member_id=10002
```
```
Outcome:  SUCCESS
Outputs:  {"accounts_table_text":"...CHK-10002-01\tChecking\t2019-11-25\t$812.09"}
```

**Say:** this goes over HTTP and imports nothing from `src/` — if it could reach into the
code it wouldn't prove anything about a real outside caller.

## A11. Approval is what an agent is allowed to do

```bash
# revoke it
curl -X PATCH localhost:3000/api/capabilities/get-member-account-count/status \
  -H 'content-type: application/json' -d '{"status":"draft"}'

curl -s localhost:3000/api/catalog | python3 -m json.tool | grep get-member   # → nothing
curl -X POST localhost:3000/api/catalog/get-member-account-count/invoke \
  -H 'content-type: application/json' -d '{"params":{"member_id":"10001"}}'   # → HTTP 403

# but the operator still sees it, as a draft
curl -s localhost:3000/api/capabilities | grep -o 'get-member-account-count'

# put it back
curl -X PATCH localhost:3000/api/capabilities/get-member-account-count/status \
  -H 'content-type: application/json' -d '{"status":"approved"}'
```

**Say:** an unapproved recipe isn't refused to an agent, it's *invisible*. And revoking is
as easy as approving — a recipe going flaky should be pullable instantly without deleting
its history.

## A12. A real outside AI picks and calls it

```bash
npm run agent-demo -- "how many accounts does member 10001 have"
```

**Say:** it fetches the catalog, hands it to Claude as tools with three renamed fields and
no adapter, and Claude picks one by reading the description — it never sees the recorded
steps. Then a deterministic replay runs.

## A13. Escalation — a human is asked for help

```bash
npm run discover -- --app-id legacy_bank \
  --goal "Log in, search for member 10001, open a new sub-account for them (Savings, initial deposit 100), and reach the confirmation screen"
```
```
Status:   escalated
Escalated: The "Account Type" field is a native HTML <select> dropdown... every click
  attempt fails because the option element is reported "not visible"... I don't have a
  primitive in my toolset to select a native dropdown option.
```

**Say:** the AI hit a genuine wall and asked for a person rather than flailing or
inventing a move it doesn't have. **Own this one** — it's a real limitation of the
five-primitive design: a native `<select>` needs Playwright's `selectOption`, which isn't
one of the five. The fix I'd make is to extend `type` so that typing into a `<select>`
selects the matching option, keeping the vocabulary at five.

## A14. A risky, state-changing capability, and the approval gate

`open-sub-account` actually creates a sub-account, and `/open-account` is marked risky in
the app config, so the step that submits is classified `risky` and the whole capability
rolls up to `risky`.

```bash
# reset the bank's data first, since this one mutates
curl -s localhost:3001/reset

# as a draft, unattended replay is refused outright
npm run replay -- --id open-sub-account \
  --param member_id=10001 --param account_type=Savings --param initial_deposit=100
```
```
replay: Capability "open-sub-account" is risky and still in draft.
        Approve it (PATCH status to "approved") before unattended replay.
```

Approve it in the console, or by curl, then run it again:

```
Outcome:  SUCCESS
Outputs:  {"reference_number":"REQ-10001-03","new_account_number":"SAV-10001-03",
           "opening_balance":"$100.00"}
```

**Say:** the refusal happens before anything is written — no run row, no evidence folder,
no mark on its record. A safe capability replays as a draft because a person is watching;
a risky one does not, because "risky" means it changes something a customer can see.

This flow also contains a **dropdown**, which is the reason `type` handles a `<select>`:
step 6 selects the account type and is checkpointed with `value_equals`, since a selected
`<option>` is never reported visible and neither `text_visible` nor `element_exists` can
assert one.

**Own the flaw before they find it.** A locked member (`40000`) comes back as
`DEPOSIT_TOO_LOW` rather than a permission denial. The model recorded that detector as the
text `"Minimum opening deposit"` — which is permanent help text on the form, present on
every run. Two guards catch the other shapes of this (see WALKTHROUGH.md, Part 5); this
one needs per-step page capture at record time, which isn't built.

---

# Part B — the console

Same ground, clickable. `http://localhost:3000`.

## B1. The app

Sidebar → **legacy bank**. Click the pencil to show the config: the URL, the login, and
under **Permissions**, the allowlist written out in plain text.

**Say:** the app's own domain is a hard wall nothing can widen. These settings only narrow
it further. They're written into the config file literally, so narrowing them means editing
a value you can see rather than discovering one you can't.

## B2. Run a discovery, watch it live

The goal is pre-filled. Hit **Run**.

The live viewer fills with a screenshot refreshing every 2 seconds and a badge saying who
holds the browser — `agent driving`.

**Say:** that's a real Chromium window. When a human takes over, they take over *that*
window, not a copy.

## B3. Runs tab

Every run, newest first, with its outcome. Click the report icon on any row.

The report shows: the outcome badge, the configuration, every step with who did it
(`llm` / `replay` / `human`), the screenshot gallery, and — for discovery runs only — token
usage.

**Say:** that token panel is hidden on replay reports, and that absence is the claim being
proven. A replay has no token count because there was no model.

## B4. Capabilities tab

One row per recipe: name, status badge, risk badge, reliability score, Approve, Replay, and
a chevron.

Expand `get-member-account-count`:

- **Takes / Returns** — the typed contract
- **Recorded steps** — the six steps in plain English
- **Also answers, without failing** — `MEMBER_NOT_FOUND`, `LOGIN_FAILED`, `NO_ACCOUNTS`
- **Stability** — *Replay 5×*, renders a coloured dot per run
- **Assisted fallback** — the off-by-default checkbox; tick it and the card turns amber
- **Export** — *Generate test script* downloads the standalone Playwright file

## B5. Replay with parameters, and as a different user

Hit **Replay**. A dialog appears asking for `member_id` — and below it, **Run as a
different user**, with the credential blank by default.

Run it three times:

| member_id | credential | Result |
|---|---|---|
| `10001` | blank | `SUCCESS` + the accounts table |
| `99999` | blank | `BUSINESS_OUTCOME · MEMBER_NOT_FOUND` |
| `10001` | `wrong-password` | `BUSINESS_OUTCOME · LOGIN_FAILED` |

**Say:** one recipe, three inputs, three different answers — and two of them are answers,
not errors. Blank credential means "use the app's stored one"; what you type is sent once
and never stored.

## B6. Approve, and the Agent catalog tab

Hit **Approve**. Switch to **Agent catalog** — the row appears immediately.

That tab isn't a description of the agent path. **It is the agent path, driven by hand.**
Type `10001`, hit Invoke, see the four-way result.

Now go back and hit **Revoke**. Return to Agent catalog — it's gone.

**Say:** a human's approval is the entire boundary of what an AI agent may attempt.

## B7. Human-in-the-loop

Start a run with a goal it can't finish — the sub-account flow from A13 works, because of
the dropdown.

When it gets stuck, the **Human needed** panel appears with the reason and the URL. The
browser is still open on that page.

Do the thing manually in the real Chromium window, type a note like *"I selected Savings
for you, carry on"*, and hit **Hand control back**.

**Say:** the operator panel is deliberately a note box, not a form of dropdowns and
selectors. The human's channel back to the AI is language, because the goal was written in
language and the model reasons in language. The run is a real browser window, so a human
can just use it. The click-by-click path still exists and goes through the same five moves
tagged `human` — it's just not what an operator should be asked to hand-assemble.

---

## If something breaks mid-demo

| Symptom | Fix |
|---|---|
| Every replay hard-fails at step 0 | The bank isn't running. `cd ../mock-bank/legacy && npm start` |
| `No app "legacy_bank"` | Re-run the registration curl in Setup |
| `MissingCredential` | The app config has no password, or `--secret` was misspelt |
| Generated script times out | `REPLACE_ME` wasn't filled in, or `BASE_URL` is missing |
| Console shows nothing | An app must be selected in the sidebar — every view is scoped to it |
| Port 3000 or 3001 in use | `lsof -ti :3000 \| xargs kill -9` |

## The five-minute version

If you only get five minutes, run these four:

1. `npm run replay -- --id get-member-account-count --param member_id=10001` — SUCCESS, no AI
2. `... --param member_id=99999` — BUSINESS_OUTCOME, an answer not a crash
3. `npm run replay -- --id lookup-member-full-name --param member_id=10002` — HARD_FAILURE with the exact selector that failed. Add `--assisted-fallback` to try the one-shot AI rescue (lands about half the time — see A8)
4. `npm run invoke` then revoke and re-run — approval is the whole boundary
