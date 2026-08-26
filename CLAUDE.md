# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository

## Rules
- surgical changes only
- commit to github if code is good every 30 min in phases not at once
- within plan.md, complete each phase in a separate session
- when I am learning or asking questions I need max 3 sentence explanations or concise answers only. no extra bloat 
- keep explanations simple: plain, basic language, no formal tone, no jargon, no quoting file paths/line numbers unless I ask for them

## Development Commands

```bash
npm install
npx playwright install chromium
cp .env.example .env              # add ANTHROPIC_API_KEY
npm start                         # console + API on port 3000
npm test                          # runs tests/*.test.js

npm run discover -- --app-id <id> --goal "log in and read the balance"
npm run replay -- --id <capability-id> [--param k=v] [--headed]
npm run stability -- --id <capability-id> --runs 5 [--param k=v]  # replay N times, report % held
npm run generate -- --id <capability-id> [--out file.spec.js]     # standalone Playwright script
npm run canonicalize -- --id <capability-id>                      # suggest route patterns, no rewrite
npm run invoke -- --id <capability-id> [--param k=v]          # agent-facing catalog
npm run agent-demo -- "task in plain english"                 # real outside AI caller
```

An app must exist first, either via the console's Add App modal or `POST /api/targets`
(see README.md). Its config lives at `config/<app_id>/config.json`, gitignored since
it holds credentials.

## Architecture Overview

A computer-use automation system: an AI agent (Claude, driving Playwright) learns a web
flow once ("discovery"), records it as a typed, versioned "capability," then replays it
deterministically with zero LLM involvement. Full design write-up in REPORT.md, flow
diagrams in docs/DESIGN.md.

**Backend (Node/Express, `src/`):**
- `schema/`: the capability schema (Zod) and its on-disk store
- `engine/`: the five action primitives (`actions.js`), locator resolution, the
  deterministic replay executor, the recovery table, perception (accessibility tree)
- `policy/`: the allowlist gate, risk classification, redaction
- `agent/`: the discovery loop, tool definitions, artifact writer, escalation/handoff
- `api/`: the Express routes the console, CLI, and outside agents all call
- `evidence/`: writes `transcript.jsonl` / screenshots / `result.json` per run
- `cli/`: the same operations, runnable from a terminal

**UI (vanilla JS + Handlebars, `ui/`):** component-based, one `.js`/`.html`/
`.css` set per component under `ui/components/<name>/`. Key ones: `sidebar` (apps
list), `app-modal` (add/edit app), `tabs`, `capabilities` (replay + approve), `discoveries`,
`human-in-the-loop` (operator console), `live-viewer` (watches a live discovery run).

**Storage, no database:** `config/<app>/config.json` per app (gitignored);
`evidence/<app>/<discovery|replay>/<timestamp>/` per run (committed, it's the deliverable).

**Invariants worth knowing before touching anything** (see `tests/invariants.test.js`):
- `engine/replay.js` never imports the Anthropic SDK
- every action primitive starts with `checkAllowed()`
- the LLM, replay, and the human operator all drive the page through the same five
  primitives in `engine/actions.js`, no second implementation of any of them anywhere