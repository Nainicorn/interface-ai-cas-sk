# Adapting the core to MERIDIAN CORE

The take-home built a system that discovers a web flow once with an LLM, records it as a
typed capability, and replays it deterministically with no model in the loop. This is what
happened when it was pointed at MERIDIAN CORE.

## What adapting actually took

The adapter is one file: `apps/meridian/config.json`. It names the target, the routes the
system may touch, the routes that mutate, the fields whose values must not be kept, and
the two operator identities the target distinguishes. No new action primitive, no second
replay path, no target-specific branch in the engine. All seven functions in §2.1 are
recorded and replaying.

Two config decisions worth defending. `/settings` is **outside** the allowlist — that
screen sets a global error-injection rate for everyone, and automation has no business
flipping it; faults get forced per request with `?inject=` instead. And redaction covers
member name, e-mail, phone, address and account identifiers but **not** balances, because
reading balances is what a member-servicing console is for; the redacted copy is the one
written to evidence, while the caller still receives the real value.

So the shape held. What did not hold was a set of assumptions inside the core that a
tidier target had never tested:

| What broke | Why this target found it |
| --- | --- |
| Dropdown selection matched an option's exact label | Labels carry live balances — `100987-S0001 - Regular Shares ($24.00)`. A recording worked once and broke after its own first transfer. |
| `value_equals` split `"<selector>=<expected>"` on the first `=` | With no test ids every selector is an attribute selector, so `input[name='q']=100987` parsed as the selector `input[name`. The condition was unusable here. |
| Checkpoints could not reference a caller's parameter | A control filled from a parameter has no value known at record time, so the model checkpointed the branch dropdown on text present either way — an unverified step recorded as verified. |
| Nothing checked that a declared input was used | The first recording demanded `operator_password` from the caller while correctly typing it from the environment. Every invocation failed pre-flight. |
| `classifyRisk()` had no callers | Risk was whatever the recorder claimed about itself, and everything downstream trusts it. |
| `updateCapability` rewrote the parsed artifact | A process on older code silently erased fields it did not know. Approving a capability deleted its business outcomes, and a run then reported HARD_FAILURE for a member who simply did not exist. |

Each is fixed in its own commit with the reasoning. Three additions were genuinely new
capability rather than repair: business outcomes that belong to the **flow** rather than to
one step, an `escalate` flag that turns an anticipated state into a handover, and
`http_status` as a condition type.

## The capability API

`GET /api/catalog` lists only **approved** capabilities — a draft is invisible rather than
listed-and-refused, because a catalog an agent cannot act on is noise in its context.
`POST /api/catalog/:id/invoke` takes `{ params }` and returns the result contract.

An entry is `id`, `name`, `description`, `input_schema`, `output_schema`, `risk_level` and
a rolling `reliability`. Turning that into an Anthropic tool definition is three renames
and nothing else, which is the point of shaping it that way. The chatbot calls the same
helper the HTTP route does, so approval, allowlist, risk and evidence apply once rather
than in two implementations.

Every invocation returns one of five outcomes: `SUCCESS`, `BUSINESS_OUTCOME`,
`RECOVERABLE`, `HARD_FAILURE`, `ESCALATED`. The distinction the whole design rests on is
that "no such member" is an answer, not an error.

## Driving this UI reliably

There are no test ids and no `<label for>` anywhere, so locators fall back to scoped CSS
with ranked alternates. Option selection is an explicit ladder — underlying value, exact
label, label with its trailing annotation dropped, unique prefix — where every rung is
exact-or-unique, so the same input always picks the same option or none at all.

The per-transaction hidden `_token` needs **no special handling**, and that is the
strongest argument for driving the page rather than its endpoints: the form carries the
token, and clicking the real submit button submits it. Likewise review→post is just two
recorded clicks.

## Runtime and exceptional states

Faults are classified on the HTTP status, not on the page's prose: the status cannot be
matched by accident the way a phrase can, and it does not move when the copy is reworded.
Playwright discards it once navigation settles, so it is captured as it goes past — both
the last status and the set of statuses seen, because this host answers 440 and then
redirects to sign-on, which erases the evidence from the current status.

The six injected kinds are declared once per app, not per recording, because a runtime
fault belongs to the host rather than to the flow that happened to be running:

| Status | Treated as | Why |
| --- | --- | --- |
| 400 | BUSINESS_OUTCOME | The app refused the transaction. That is an answer. |
| 404 | BUSINESS_OUTCOME | The record is not there. Also an answer. |
| 403 | ESCALATED | Not an answer — the work is real and needs more authority. |
| 503 | RECOVERABLE | The host offers a Continue link; take it. |
| 500 | RECOVERABLE, once | One reload, then it is a hard failure. |
| 440 | split by risk | See below. |

A capability's own rules are consulted **before** the table, because the target answers 400
both for a transfer it refused and for an injected fault, and the recording knows which it
saw. Natural errors — bad login, overdraw, a held share, an invalid e-mail, a deposit below
minimum — are declared per recording, and each recorder was told to trigger the case and
read the real wording rather than guess it. A rule detects the app's generic rejection
banner and a `detail` locator reads the specific line, so one rule covers every rejection
and the caller still learns which one: `"Source share is HOLD and cannot be debited."`

**The 440 split is the judgement call.** Re-authenticating and carrying on is safe for a
read and reckless for a transfer: the run cannot tell whether its post landed before the
session dropped, and guessing wrong duplicates an irreversible transaction. So a read-only
flow is re-run once from the top and reports RECOVERABLE; a mutating one stops and
escalates for a person to check.

## What survives the new surface

The allowlist still opens every action primitive, so it applies identically to the model,
to replay and to a human operator. Risk is now re-derived from config against the **live**
url and a step riskier than its capability admits to being is refused — a legacy flow
reaches `/transfer/review` by submitting a form, not by navigating to it, so the recorded
url would have been the wrong thing to check. Only approved capabilities reach the agent
catalog, and a refusal comes back to the chatbot as a message to explain rather than a
crash. Persisted outputs and inputs are redacted; secrets travel as env-var names and only
the names are recorded, so a run that swapped a credential says which one without the
value.

Escalation survives as a first-class outcome. Both paths are real: the discovery loop
escalated when told to record Place Account Hold as a teller — it hit the supervisor gate
and stopped rather than emitting a recording for a flow it cannot complete — and replay
escalates when the same recording runs with teller credentials, carrying the step, the url
and a screenshot for whoever picks it up.

## Cut, and what is next

- **No mid-flow session resume for mutating flows.** Deliberate, for the reason above.
  Resuming safely needs an idempotency key the target does not offer.
- **Transient-fault retry is one reload.** No backoff, no second attempt. A persistent 500
  is correctly a hard failure, but a slow-clearing one is reported worse than it is.
- **No stability runs across all seven.** `npm run stability` exists and was not swept over
  the set; the per-capability reliability counters are what is on the record instead.
- **The chatbot has no memory beyond the transcript** and no confirmation step before a
  risky call. It is a demo driver over the API, and a real one should make a human confirm
  an irreversible action even when the capability is approved.
- **Next:** sweep stability across the seven, add a confirm-before-risky turn to the
  chatbot, and re-verify the standalone Playwright generator against this target — it was
  updated for the new checkpoint syntax but only exercised by its unit tests.
