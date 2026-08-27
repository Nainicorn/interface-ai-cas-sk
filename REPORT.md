# REPORT.md

## 1. Architecture

**Stack**
- Node — runs the whole backend
- Express — the server that the UI, CLI, and external agents all call
- Playwright — browser automation for both discovery and replay
- Zod — validates and types the capability schema to become a replay
- Anthropic SDK — powers the discovery agent, and nothing else

Express exposes one API that Playwright acts through, Zod makes sure whatever gets recorded from a Playwright run is a valid capability, and the Anthropic SDK is reachable only from the discovery path — replay never touches it, by any flag or option

**Overview**

The agent is allowed five actions, `navigate`, `click`, `type`, `read`, `wait_for`. That's everything it needs to interact with a web interface. A native `<select>` is handled inside `type` rather than as a sixth action — picking an option is putting a value into a control — because fill() throws on a select and a native `<option>` is never reported visible, so without that the five primitives cannot drive a dropdown at all. The model can't invent a sixth action, and neither can its recorded replay. The AI, the replay, and a human operator taking over all use the exact same five actions, with no shortcuts for any of them.

Every one of those five functions starts with `checkAllowed()` before it touches the page. This is to ensure guardrails for the agent and what its allowed to do.

To test an app, a user is prompted to give the app name, app URL, a goal, and if applicable, login information (username/password), either via CLI or through the console's "Add App" modal. Each run's evidence (steps, screenshots, result, cost) saves if successful as a discovery. This discovery can also become a capability (replay) with user approval.

No database was implemented for this application. The evidence folder stores all the discovery and replay runs. Each run is also a single process with no queue or background workers, one step happens after another in order. The tradeoff however is that the process could crash mid run and does not retry. This could be a massive issue if several runs needed to happen at once. But for proving the design actually works, that tradeoff was worth it over building something a bit more complicated that needed further time and effort to design fully.

---

## 2. Artifact schema

The schema was the part I spent the most time on, since it was a focal point. A capability is not just a record of what the model did. It's a typed, versioned description of a flow that an agent can call with the steps in order, how each control is found, typed inputs and outputs, and a confirmation to ensure it actually worked.

Key decisions:

- There are no test IDs in legacy apps, so any single selector is really just a guess. Each step carries an ordered list of candidates (role, label, placeholder, text, then css as a last resort). Replay tries them one at a time and uses the first one that matches. If a candidate matches more than one element, it gets rejected instead of guessing which one is right.

- A step can list expected business outcomes, a condition to look for, and a code to return if it happens. This gets checked before the step's normal success check, since a wrong path answer would usually fail that check too.

- A `type` step's value comes from exactly one of three places: `value_from` (a value the caller supplies), `value_literal` (something safe to hardcode), or `value_from_env` (an environment variable name for a credential). The model picks where a password goes, but never actually sees the password.

- Artifacts are meant to be read by people, and a flat object is much easier to follow in a diff.

`input_schema` and `output_schema` are plain JSON Schema, generated automatically when a run is recorded. That same shape can also be used directly as a tool definition for an AI agent, which is what the agent catalog feature in section 7 uses.

A capability is versioned and starts out as a draft. Turning it into approved is the one thing the system will not do on its own, only a human can do that. It also keeps a running count of how many times it has run and succeeded, which every replay updates.

---

## 3. Determinism & error handling

`src/engine/replay.js` never imports the Anthropic SDK. This is the most important claim in the whole system: the model figures out the steps once, and after that every run is just following a fixed set of instructions. Same inputs, same steps, same result, every time.

Every step in a replay ends in one of four outcomes, and the order they get checked in matters:

1. If the step's condition matches, it returns as a `BUSINESS_OUTCOME` right away, before even checking whether the step technically succeeded. This matters because checking success first would treat something like "no such member" as a hard failure, which is wrong. It's a real answer, not a broken step.
2. The step's normal success check runs.
3. If the check fails, the system tries a short list of known fixes (`src/engine/recovery-table.js`), things like closing a popup or waiting out a slow load. These are fixed rules written ahead of time, not something the AI decides in the moment. `engine/replay.js` imports nothing AI-related, with no exception and no opt-in path.
4. If it's still failing after that, it becomes a `HARD_FAILURE`. This includes exactly which step failed, what was expected, what was actually seen, every option it tried to find the right element, and a screenshot.

If a step can't find its target element at all, it gets checked against the declared business outcomes one more time before being marked a failure. Sometimes "this member has no savings account" looks exactly like an element that's just missing, not like a bug.

Since these are stable apps that don't change their layout often, most real failures aren't from the page looking different. They come from real conditions happening while the app runs. The ranked list of ways to find an element helps absorb small changes, like a button moving or a label being reworded slightly, without needing to redo the whole recording. Anything bigger than that becomes a `HARD_FAILURE` with enough detail to actually go fix it.

Secondarily, on UI drift: nothing here detects a page that is slowly changing while still technically working. A `HARD_FAILURE` tells you the page changed enough to break something; the ranked locator candidates absorb small changes below that. The gap in between — "still passing, but the ground is moving" — is not covered. I built a fingerprint-based detector for it and removed it; see the Cuts section.

---

## 4. Heterogeneity & multi-tenant

This system was only built and tested against one type of app, a regular web app driven through Playwright. But two parts of the design were built so it could grow into the bigger picture without a rewrite.

`src/engine/perception.js` is the only file that actually looks at the page. Right now it reads the accessibility tree first, then visible text, then takes a screenshot as backup. The accessibility tree was chosen because it's the one thing that exists across a modern web app, an old fashioned legacy web app, and even a desktop app. The recorded flow itself, the schema, the five actions, the ways of finding elements, doesn't know or care that it's running on Playwright. To support something like a desktop app later, only `perception.js` and the way locators are built would need to change. The schema and the replay logic wouldn't.

`target.app_id` refers to the actual product being automated, not a specific customer or URL. The real website address and login details live separately in `apps/<app>/config.json`, and get filled in when the capability actually runs. That means one recording can be reused for any customer set up under that same app id. For cases where two customers use the same product but with small differences, the schema already has a place for that, `TenantOverrideSchema`, which lets one small change be layered on top of a base recording instead of starting over. If a customer's replays start failing more often, that shows up in the confidence numbers already tracked on every capability, which is the signal that something needs an override.

I went back and wired this up. `engine/replay.js` exports `applyTenantOverride(capability, tenantId)` — a pure function that patches only the steps a tenant's override names (locator and/or url), leaves everything else exactly as recorded, and can point replay at a different origin via the override's own `base_url` without that tenant needing a separate app registered under `apps/`. It runs before anything else in `replayCapability`, so the four-way outcome contract, the recovery table, and the checkpoint logic never know a patch happened — cross-tenant reuse is a seam in front of replay, not a second replay path. `npm run replay -- --id <id> --tenant <tenant-id>` exercises it from the CLI, and the API's `POST /:id/replay` takes the same `tenant_id` in its body. I verified it live rather than just unit-testing the patch: two tiny local pages standing in for two tenants' installs (one button relabeled, everything else identical), one recording, one override, both replayed to `SUCCESS`.

The other half of this section — detecting drift automatically, so a human finds out a tenant's install diverged before a replay starts failing — is `suggestRoutePattern()` in `src/schema/canonicalize.js` (`npm run canonicalize -- --id <id>`): it flags a recorded route's id-shaped segments (`/members/12345` → `/members/:id`) as a suggestion for a human comparing two recordings, and rewrites nothing on its own.

---

## 5. Escalation & handoff

This is the part I thought about the most, since letting a human actually take over the same live session is a lot harder than just showing a screenshot with a resume button. There are three ways this can happen. The model can call `escalate` when it genuinely doesn't know what to do next. It can call `abandon` if a human already told it the goal can't be done, so it doesn't keep asking forever. Or the run can simply hit its step limit.

`agent/escalation.js` keeps track of every run that's currently paused. When a run pauses, it takes a screenshot, saves the reason, and leaves the browser open exactly as it was, it doesn't close it or open a new one. It just marks the run as paused and waits.

Two things work together for control transfer. A simple flag says who's supposed to be in control, the agent or a human. A lock makes sure only one of them is actually acting at a time, since things can otherwise overlap even though the app runs on one process. Any action a human takes goes through the exact same five actions the AI uses, just tagged as coming from a human, and it gets saved in the same evidence trail as everything else.

Once a human resumes the run, control flips back to the agent and it picks up from wherever the page was left. The human can leave a short note in plain English, since the goal itself was written in English and the model reasons in English too, not in code.

The actual screen a human uses to take over is intentionally simple, just a screenshot, the reason it paused, and buttons for the five actions. It's not a full live view of the browser, which the assignment says is fine to skip. What matters is that pausing, handing off control, and resuming all actually work on the real session.

---

## 6. Safety

Every single action goes through `checkAllowed()` (`src/policy/allowlist.js`) before anything happens on the page. This applies the same way whether the AI, the replay, or a human is doing it. It checks two things: is this type of action even allowed, and is the current page within the URLs the app is allowed to touch. The app's own website address is a hard limit that nothing can widen, so if a link takes it somewhere else, the next action gets blocked right away.

Some actions are riskier than others. Clicking a search button is harmless, but clicking a submit button that changes real data is not, so risk is checked separately (`src/policy/risk.js`). Reading, waiting, and navigating are always considered safe since they can't change anything. Clicking and typing are only considered risky if the current page matches a route the app owner marked as risky. A risky capability can't run on its own without a human approving it first. Separately, no capability at all, risky or not, is visible to an outside AI agent until a human has approved it. An unapproved one isn't just blocked, it doesn't exist from the outside at all.

Sensitive values get hidden at the exact moment they would be written into a log, not before. The real browser still gets the real password to actually log in, but the saved evidence never does. Common sensitive field names like password or token are always redacted, along with anything an app owner adds. Instead of just deleting the value, it gets replaced with something like its length, so it's still possible to tell an empty field from a real one without ever seeing the actual data.

This system only catches what it's been told to catch. If an app owner forgets to mark a route as risky, a risky action on that route won't get flagged, only the basic type of action gets checked. This is a real gap for a first version. A safer version would block anything not explicitly marked as safe by default, instead of trusting every app's settings to be complete.

---

## 7. Cuts

- No database was built. `evidence/` and `apps/` on disk are the entire storage system. This keeps things simple and easy to read without any extra tools.
- Desktop support was planned, not built. `perception.js` is set up to be the seam for it (see §4), but there's no desktop version. Multi-tenant reuse *was* cut originally but I went back and built it — see §4 and the stretch-goal paragraph below.
- The operator screen is intentionally basic, just a screenshot and buttons, not a full live view of the browser, which the assignment allows.
- Assisted fallback was cut, then built, then cut again on measurement — see the paragraph below.

Beyond the core requirements, I also built an agent facing catalog (`src/api/catalog.js` and `tests/agent-demo.js`), a real outside script that lists approved capabilities, hands them to Claude as tools, and lets it call one over HTTP. I also built a confidence and approval system, where a capability starts as a draft and a human has to approve it before it can run unattended if it's risky.

I also went back and built the multi-run stability stretch goal: `npm run stability -- --id <id> --runs 5` replays a capability N times in a row through the exact same gated path as a single replay (same approval check, same evidence folder per run, same confidence signal) and reports what percentage actually held. No special-cased "test mode" — it's just N real replays, aggregated.

And the code generation stretch goal: `npm run generate -- --id <id>` turns a recording into a standalone Playwright script (`src/agent/codegen.js`), runnable with plain `node`, no new dependency. It only uses each step's highest-confidence locator — the ranked fallback list is what makes the *recording* durable, and re-implementing that fallback logic in generated code would just be a second, unmaintained copy of `engine/locator.js`. The remaining candidates are kept as a comment instead, so nothing is silently dropped. I generated and ran one against the live demo target to confirm the output isn't just valid syntax but actually replays the flow.

And the cross-tenant reuse / canonicalization stretch goal — covered in full in §4 above, since it's fundamentally a multi-tenant design answer rather than a separate feature.

I also built, and then removed, a UI-drift detector of my own. Every replay after the first compared a fingerprint of each page — the deduplicated, sorted set of accessibility-tree lines — against a baseline frozen on the first successful run, and logged a warning above a threshold without ever changing the outcome. It worked: I verified it live, replaying one recording against a deliberately reworked page and watching it report `SUCCESS` with a drift warning on the affected steps.

I cut it because the fingerprint is a set, and a set cannot count. Forty identical table rows collapse to one line, so deleting thirty-nine of them scores zero drift — and rows disappearing is exactly the kind of change a back-office operator would want flagged. It also discards indentation, which is how the accessibility tree encodes nesting, so moving a control from a modal into the page footer reads as no change at all. A warning system that is quiet about the changes that matter most is worse than no warning system, because it invites trust it has not earned. Doing it properly means comparing structure rather than a bag of lines, and a per-capability threshold rather than one global constant — more than a threshold tweak, so it is next work rather than a fix.

Assisted fallback is the one stretch goal I built and then **removed**. It worked, and it stayed inside every bound I set for it: off unless a caller opted in, at most one model call per replay, only on a locator that could not be resolved at all, able to suggest nothing but an alternative locator for the same element, validated against the schema, and executed through the same primitives so `checkAllowed()` still ran. `engine/replay.js` never imported the SDK — the call reached it as an opaque callback.

I took it out because I measured it. Against a genuinely broken locator it recovered two runs out of four. That is not a defect to fix: it is one model call with one attempt and no retries, and retrying until something sticks would turn a bounded recovery into the open-ended loop the whole design exists to avoid. So the honest options were a feature that works half the time, or no feature. A replay that fails deterministically, with the step, the selector, everything it tried, and a screenshot, is more useful to whoever has to fix it than one that sometimes silently repairs itself — and it keeps the central claim absolute rather than nearly true: **replay never calls a model.** Deleting it also removed the only opt-in path that could put page text in front of a model mid-replay.

What I would need before putting it back: a way to tell "the suggestion was wrong" apart from "the page was in a state no locator could match", so the retry budget could be spent where it would actually help.

With more time, next steps would be making the allowlist block by default instead of relying on every app being fully configured.
