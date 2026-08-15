Got everything. Here's the full map — one sentence per file, grouped by folder in flow order — then your git question at the end.

src/, folder by folder
schema/ — the contract (what a recording IS)

capability.js — the hand-written Zod definition of what a valid capability looks like: inputs, outputs, steps, locators, checkpoints, business outcomes.
enums.js — the small closed vocabularies everything agrees on (the 5 action types, 4 outcomes, locator kinds, condition types) so no fuzzy strings sneak in.
store.js — saves/loads artifacts as versioned JSON files on disk (files, not DB rows, so humans can review and diff them), validating on every read and write.
validate-params.js — the tiny checker that verifies your member_id=10001 params match the input shape stored inside the artifact before a replay starts.
engine/ — the hands (acting on the page, no AI)

actions.js — the five action primitives (navigate/click/type/read/wait_for) that ALL three actors use; every one calls the policy gate first — the single door to the browser.
locator.js — tries a step's ranked list of "ways to find this element" in order and only accepts a candidate matching exactly one visible element.
perception.js — turns the live page into readable state (accessibility tree, visible text, screenshot) and evaluates checkpoint conditions like "text X is visible."
replay.js — plays a recording back step by step and classifies the result into the four outcomes; famously imports no AI.
recovery-table.js — the hand-written list of known nuisances (dismiss-banner, one reload on 502) that replay may clear once — the RECOVERABLE case.
errors.js — typed error classes (locator failed, policy violation, malformed step) so replay classifies failures by type instead of reading error prose.
policy/ — the guardrails (what's allowed)

allowlist.js — loads targets.json and is the gate deciding "is this action on this route allowed at all," called first in every primitive.
risk.js — classifies actions safe vs risky (state-changing) and enforces "risky or unapproved never runs without a human."
redact.js — scrubs secrets and personal data before anything is logged or recorded: field names and value shapes only, never values.
agent/ — the brain (discovery only — the one place AI lives)

discovery.js — the observe→decide→act loop: launches Chromium, shows Claude the page, executes its one chosen action through the gate, repeats until it emits a recording or escalates.
tools.js — defines the shapes of the tools Claude may call (the 5 actions + escalate + emit_artifact), generated from the same Zod definitions the artifact uses.
artifact-writer.js — turns Claude's validated emission into the saved, versioned artifact file, building the input/output schemas itself so the model can't write bad ones.
escalation.js — owns who controls a live browser session (agent vs human): pause parks the loop with the page open, the operator drives the same session, resume hands it back.
api/ — the front desk (HTTP endpoints the console and agents call)

server.js — the Express app: serves the console from public/ and mounts all the routers below, on port 3000.
runs.js — POST /api/runs starts a discovery in the background and returns instantly; GET is what your console polls for status and the live screenshot.
artifacts.js — the operator's surface: browse capabilities, replay one, and approve a draft (the one power the system reserves for humans).
capabilities.js — the agent-facing catalog: approved capabilities only, shaped like callable tools, invokable by name.
run-replay.js — the shared "one replay, fully accounted for" wrapper that gives every replay a run row + evidence folder, whoever triggered it.
escalation.js — the operator panel's endpoints: list what's stuck, perform a manual step on the live page, hand control back.
db/ + evidence/ — the memory

sqlite.js — the SQLite tables for runs and interventions: workflow state nobody reviews line-by-line (artifacts stay as reviewable files instead).
logger.js — writes each run's evidence folder: a transcript of events, numbered screenshots, and result.json, readable standalone.
cli/ — same flows without the console

discover.js — start a discovery run from the terminal.
replay.js — replay a capability from the terminal.
invoke.js — demos the agent-facing surface over HTTP exactly as an external AI agent would use it.
One flow sentence to hang it all on: api/ receives your click, agent/ thinks (once), engine/ acts, policy/ guards every act, schema/ defines what gets remembered, db/ + evidence/ remember it, cli/ is a second door to the same flows.



- add url