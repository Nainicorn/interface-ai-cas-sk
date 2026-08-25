# REPORT.md

## 1. Architecture

**Stack:** 
Node
Express
Playwright
Zod
Anthropic SDK

The agent is allowed five actions, `navigate`, `click`, `type`, `read`, `wait_for`, which all defined once in `src/engine/actions.js`. That's everything it needs to interact with a web interface. The model can't invent a sixth action, and neither can its recorded replay. The AI, the replay, and a human operator taking over all use these exact same five actions too, with no shortcuts for any of them, so whatever actually happens on the page always goes through the same path no matter who's driving.

Every one of those five functions starts with `checkAllowed()` before it touches the page. This is to ensure guardrails for the agent and what its allowed to do.

To test an app, a user is prompted to give the app name, app URL, a goal, and if applicable, login information (username/password), either via CLI and in `config/<app>/config.json`, or through the console's "Add App" modal. Each run's evidence (steps, screenshots, result, cost) saves to `evidence/<app>/<kind>/<stamp>/`. A successful discovery also saves `goal.json`, the capability itself, sitting right in the run folder that produced it.

No database was implemented for this application. `evidence/` and `config/` on disk are essentially the storage system. Everything also runs as a single process with no queue or background workers, one step happens after another in order. The assignment specifically says it does not reward extra infrastructure like that, and a project meant to be reviewed by reading the code should not hide its logic behind something like a message queue. The tradeoff is real, if the process crashes mid run, that run does not pick back up on its own, and this would not hold up if many runs needed to happen at once. But for proving the design actually works, that tradeoff was worth it over building something more complicated.

---

## 2. Artifact schema

The schema lives in `src/schema/capability.js` (Zod). This was the part I spent the most time on, since the brief calls it out as a focal point. A capability is not just a record of what the model did. It's a typed, versioned description of a flow that an agent can call: the steps in order, how each control is found, typed inputs, typed outputs, and a checkpoint to confirm it actually worked. The raw model transcript is kept separately in `evidence/{run_id}/`, so the two never get mixed up.

Key decisions:

- There are no test IDs in legacy apps, so any single selector is really just a guess. Each step carries an ordered list of candidates (role, label, placeholder, text, then css as a last resort). Replay tries them one at a time and uses the first one that matches exactly one visible, usable element. If a candidate matches more than one element, it gets rejected instead of guessing which one is right.

- A step can list expected business outcomes, a condition to look for, and a code to return if it happens. This gets checked before the step's normal success check, since a real non happy path answer would usually fail that check too.

- `target.app_id` is the name of the vendor product, not a tenant or a URL.

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
3. If the check fails, the system tries a short list of known fixes (`src/engine/recovery-table.js`), things like closing a popup or waiting out a slow load. These are fixed rules written ahead of time, not something the AI decides in the moment. Replay is never allowed to call an AI, even to fix a problem.
4. If it's still failing after that, it becomes a `HARD_FAILURE`. This includes exactly which step failed, what was expected, what was actually seen, every option it tried to find the right element, and a screenshot.

If a step can't find its target element at all, it gets checked against the declared business outcomes one more time before being marked a failure. Sometimes "this member has no savings account" looks exactly like an element that's just missing, not like a bug.

Since these are stable apps that don't change their layout often, most real failures aren't from the page looking different. They come from real conditions happening while the app runs. The ranked list of ways to find an element helps absorb small changes, like a button moving or a label being reworded slightly, without needing to redo the whole recording. Anything bigger than that becomes a `HARD_FAILURE` with enough detail to actually go fix it.

---

## 4. Heterogeneity & multi-tenant

This system was only built and tested against one type of app, a regular web app driven through Playwright. But two parts of the design were built so it could grow into the bigger picture without a rewrite.

`src/engine/perception.js` is the only file that actually looks at the page. Right now it reads the accessibility tree first, then visible text, then takes a screenshot as backup. The accessibility tree was chosen because it's the one thing that exists across a modern web app, an old fashioned legacy web app, and even a desktop app. The recorded flow itself, the schema, the five actions, the ways of finding elements, doesn't know or care that it's running on Playwright. To support something like a desktop app later, only `perception.js` and the way locators are built would need to change. The schema and the replay logic wouldn't.

`target.app_id` refers to the actual product being automated, not a specific customer or URL. The real website address and login details live separately in `config/<app>/config.json`, and get filled in when the capability actually runs. That means one recording can be reused for any customer set up under that same app id. For cases where two customers use the same product but with small differences, the schema already has a place for that, `TenantOverrideSchema`, which lets one small change be layered on top of a base recording instead of starting over. It's not fully wired up yet, since the brief doesn't expect multi-tenant support to actually be built, only planned for. If a customer's replays start failing more often, that shows up in the confidence numbers already tracked on every capability, which is the signal that something needs an override.

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

- No database was built. `evidence/` and `config/` on disk are the entire storage system. This keeps things simple and easy to read without any extra tools.
- Multi-tenant and desktop support were planned, not built. `TenantOverrideSchema` exists in the schema and `perception.js` is set up to be the seam for it, but nothing actually applies a tenant override yet, and there's no desktop version.
- The operator screen is intentionally basic, just a screenshot and buttons, not a full live view of the browser, which the assignment allows.
- No AI assisted recovery during replay. The recovery list is small, fixed, and written by hand. I considered letting the AI help fix a failed step during replay, but decided against it for now. Replay never calling an AI is one rule I didn't want to bend, even a little, until everything else was proven solid first.
- No route cleanup yet. A step's value can be swapped out, like a different member ID, but the actual URL path itself isn't turned into a reusable pattern yet, like turning `/item/12345` into `/item/:id`.
- No flakiness score yet. Every capability already tracks how many times it ran and succeeded, which is the start of a reliability score, but nothing runs a capability multiple times automatically to report a stability percentage.

Beyond the core requirements, I also built an agent facing catalog (`src/api/capabilities.js` and `tests/agent-demo.js`), a real outside script that lists approved capabilities, hands them to Claude as tools, and lets it call one over HTTP. I also built a confidence and approval system, where a capability starts as a draft and a human has to approve it before it can run unattended if it's risky.

With more time, next steps would be actually applying tenant overrides during replay and showing one recording working against two slightly different setups, building a real flakiness score from repeated replays, and making the allowlist block by default instead of relying on every app being fully configured.
