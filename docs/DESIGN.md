# DESIGN.md — the flow, and the file that does each job

Every box names the file that actually does the work, so you can go from a picture to the
code without hunting. Diagrams render on GitHub.

Here's the idea the whole system is built around:

> **The model discovers. The recording becomes a reusable capability. Deterministic replay
> is how a production agent invokes it.**

---

## The shape of it

Three things can act on the page — the AI, replay, and a human. They all go through the
same set of actions, and they all write to the same kind of log.

```mermaid
flowchart TB
    subgraph callers["Three callers"]
        LLM["LLM discovery<br/>agent/discovery.js"]
        REPLAY["Deterministic replay<br/>engine/replay.js"]
        HUMAN["Human operator<br/>agent/escalation.js"]
    end

    GATE{"check allowed<br/>policy/allowlist.js<br/>opens every primitive"}

    ACTIONS["Five primitives<br/>engine/actions.js<br/>navigate · click · type · read · wait_for"]

    LOCATOR["Ranked locator resolution<br/>engine/locator.js"]
    PAGE(["Playwright page<br/>one live browser session"])
    LOG["Evidence trail<br/>evidence/logger.js<br/>every line tagged with its actor"]

    LLM --> GATE
    REPLAY --> GATE
    HUMAN --> GATE
    GATE -->|refused| STOP["PolicyViolation<br/>a stop, never a retry"]
    GATE -->|allowed| ACTIONS
    ACTIONS --> LOCATOR --> PAGE
    ACTIONS --> LOG
```

Two things matter here, and they're both true because of how the code is built, not just
because we say so:

- **There's only one version of "click."** Not one for the AI and a different one for
  replay. If you ever find a second implementation of any of the five actions anywhere in
  this repo, something's wrong. The model doesn't get to just click on things — it has to
  pick one of the five actions, the same way replay does.
- **There's only one gate, and it can't be skipped.** `checkAllowed` runs first, inside
  the action itself, not as a separate step a caller has to remember to do. And no
  permission setting can ever let an app act outside its own website — that line never
  moves.

---

## 1. Discovery — the model works it out once

```mermaid
flowchart TB
    GOAL["Goal in plain English<br/>api/runs.js POST /api/runs"]
    CONF["Resolve the app<br/>config/app-config.js<br/>URL, credentials as env NAMES, permissions"]
    LOOP["Agent loop<br/>agent/discovery.js"]
    TOOLS["Tool definitions for Claude<br/>agent/tools.js"]
    OBSERVE["Perceive the page<br/>engine/perception.js<br/>accessibility tree first, not the DOM"]
    ACT["engine/actions.js<br/>via the gate"]
    EMIT{"Model emits<br/>the recording?"}
    WRITE["Validate and write<br/>agent/artifact-writer.js<br/>→ schema/capability.js (Zod)"]
    FILE[["evidence/&lt;app&gt;/discovery/&lt;stamp&gt;/goal.json"]]
    NONE[["No goal.json<br/>the run happened; it yielded nothing"]]

    GOAL --> CONF --> LOOP
    LOOP <--> TOOLS
    LOOP --> OBSERVE --> LOOP
    LOOP --> ACT --> OBSERVE
    LOOP --> EMIT
    EMIT -->|yes| WRITE --> FILE
    EMIT -->|"stuck, or out of turns"| ESC["Escalate — see §4"]
    EMIT -->|no| NONE

    classDef good fill:#1e5e3a,stroke:#3fae6a,color:#eafff1;
    classDef bad fill:#5e2323,stroke:#c24747,color:#ffecec;
    classDef wait fill:#4a3a12,stroke:#c99a34,color:#fff6e0;
    class FILE good
    class ESC wait
    class NONE bad
```

**Why the accessibility tree.** It's the one way of reading a page that works everywhere —
a modern web app, an old clunky one built out of tables, and even a desktop app. If we
ever swap Playwright for something else, only this one file has to change.

**The recording lives right next to the proof it worked.** There's no separate folder for
capabilities. `goal.json` sits in the same run folder as the screenshots and the log from
that same run. If a folder has a `goal.json` in it, that run succeeded and can be
replayed. If it doesn't, it didn't.

**The model never actually sees a password.** `config/app-config.js` loads real
credentials into the environment under a made-up name, and only tells the model the
*name* — never the value. The model decides where a password goes on the page without
ever knowing what the password is.

---

## 2. Replay — no model, ever

```mermaid
flowchart TB
    CALL["Caller<br/>console · CLI · agent"]
    ENTRY["Single entry point<br/>api/run-replay.js"]
    GATE{"checkUnattendedAllowed<br/>policy/risk.js"}
    REF["403 ApprovalRequired<br/>before any run row or folder exists"]
    PARAMS["Validate typed params<br/>schema/validate-params.js"]
    EXEC["Walk the recorded steps<br/>engine/replay.js"]
    LOC["Try ranked candidates<br/>engine/locator.js"]
    RECOV["Known interstitial?<br/>engine/recovery-table.js"]
    CHECK{"Checkpoint holds?"}
    FOLD["Fold outcome into confidence<br/>schema/store.js"]

    CALL --> ENTRY --> GATE
    GATE -->|"risky + draft"| REF
    GATE -->|allowed| PARAMS --> EXEC
    EXEC --> LOC
    LOC -->|"nothing matched"| RECOV
    RECOV -->|cleared| EXEC
    RECOV -->|unknown| CHECK
    LOC -->|resolved| CHECK
    CHECK --> OUT["Four-way result"]
    OUT --> FOLD

    OUT --> S["SUCCESS<br/>checkpoint verified,<br/>typed outputs extracted"]
    OUT --> B["BUSINESS_OUTCOME<br/>a real answer —<br/>handle as data"]
    OUT --> R["RECOVERABLE<br/>declared interstitial cleared,<br/>execution continued"]
    OUT --> H["HARD_FAILURE<br/>step, expectation, observation,<br/>every locator tried, screenshot"]

    classDef good fill:#1e5e3a,stroke:#3fae6a,color:#eafff1;
    classDef info fill:#1e3a5e,stroke:#4785c9,color:#e8f3ff;
    classDef wait fill:#4a3a12,stroke:#c99a34,color:#fff6e0;
    classDef bad fill:#5e2323,stroke:#c24747,color:#ffecec;
    class S good
    class B info
    class R wait
    class H bad
```

**`engine/replay.js` never imports the AI SDK.** That's the whole point of this file. If
that import ever shows up here, replay stops being deterministic — same input won't
reliably give the same output anymore.

**BUSINESS_OUTCOME is the most important idea in this whole system.** "No such member" is
a real, useful answer — not a crash. So the recording writes down ahead of time what a
valid non-happy-path answer looks like on the page, and replay checks for that *before* it
decides a step failed. It checks again if a button or field can't be found at all, because
sometimes "it's not there" IS the answer.

**A refusal isn't a failure.** If a capability gets refused before it even starts — a
risky one that hasn't been approved yet, say — nothing gets written down anywhere. No run,
no folder, no mark on its track record. Nothing happened, so nothing gets recorded as
having happened.

**Cross-tenant reuse happens before any of the rest of this starts.** If a `tenant_id` is
passed in, `applyTenantOverride()` swaps out a few locators or the site's address before
replay even begins. Everything after that runs exactly like normal — replay has no idea a
swap happened. Most tenants using the same underlying product need no swap at all. One
with a couple of relabeled buttons only needs those buttons listed, not a whole new
recording.

---

## 3. The approval gate, and the two surfaces it separates

There's one place capabilities are stored, but two different views into it. The narrower
view is what an AI agent gets to see.

```mermaid
flowchart LR
    STORE[("Recordings on disk<br/>schema/store.js")]

    subgraph op["Operator surface — api/capabilities.js"]
        OL["GET /api/capabilities<br/>drafts included"]
        OS["PATCH /:id/status<br/>the one human act"]
        OR["POST /:id/replay"]
        OD["DELETE /:id<br/>refused while approved"]
    end

    subgraph ag["Agent surface — api/catalog.js"]
        AL["GET /api/catalog<br/>approved only — a draft is<br/>invisible, not refused"]
        AI["POST /:id/invoke"]
    end

    STORE --> OL
    STORE --> AL
    OS -->|"draft → approved"| AL
    OS -->|"approved → draft"| GONE["vanishes from the catalog"]
    OR --> RR["api/run-replay.js"]
    AI --> RR
```

Every capability starts as a draft. The only way it becomes "approved" is a human doing it
by hand — the system never approves its own work. Taking approval back is just as easy as
giving it, on purpose: if a capability starts failing a lot, it should be pullable from
the agent's list right away, without deleting the recording or its history.

---

## 4. Escalation — a human on the same session

```mermaid
sequenceDiagram
    participant L as agent/discovery.js
    participant E as agent/escalation.js
    participant API as api/escalation.js
    participant UI as operator-console
    participant P as the live Chromium window

    L->>E: pauseForIntervention(reason)
    Note over E: owner: agent → paused<br/>screenshot + context saved<br/>page stays OPEN
    E-->>L: await resumed (parked)
    API-->>UI: intervention appears
    Note over UI,P: the human works in the real<br/>browser window — same session<br/>by construction
    UI->>API: POST /:id/resume { note }
    API->>E: resumeRun(runId, note)
    Note over E: owner: paused → agent
    E-->>L: { note }
    L->>P: re-observe the page as the human left it
    Note over L: the note enters the model's<br/>context as plain English
```

**Two safety checks work together here.** One flag says who's *supposed* to be in
control. A separate lock says who's *actually* in control right now, at this exact
moment. Both are needed — even though the code runs on one thread, it can still jump
between the AI and a human mid-action if you're not careful. "It's single-threaded so it's
fine" would be the wrong assumption to make here.

**Handing control back happens in plain English, not clicking.** The goal was written in
English and the model thinks in English, so when a human steps in and fixes something,
they just describe what they did — like *"the code is 481920, type it into the code
box"* — and the model picks up from there the same way it already understands things.
There's still a way for a human to click and type directly on the page too
(`performManualAction`), and it goes through the exact same five actions everything else
uses, just tagged as done by a human instead of the AI. It's just not usually what the
operator is asked to do by hand.

---

## 5. An agent calling the catalog

This is the one part where an outside program actually calls into this system over the
network, instead of through the codebase directly. `tests/agent-demo.js` doesn't import
anything from `src/` on purpose — if it could reach into the code directly, it wouldn't
prove anything about what a real outside caller can actually do.

```mermaid
sequenceDiagram
    participant D as tests/agent-demo.js
    participant C as api/catalog.js
    participant M as Claude
    participant R as "api/run-replay.js → engine/replay.js"

    D->>C: GET /api/catalog
    C-->>D: approved entries<br/>{ name, description, input_schema }
    Note over D: three renames, no adapter —<br/>the catalog IS a tools array
    D->>M: task + tools
    M-->>D: tool_use { name, typed args }
    Note over M: chose by reading the description,<br/>never saw the recorded steps
    D->>C: POST /:id/invoke { params }
    C->>R: runReplay(caller: "agent")
    R-->>C: four-way result
    C-->>D: result
    D->>M: tool_result
    M-->>D: reports what it got
```

Take away a capability's approval and try this again: the AI is told it has no tools at
all to use. A human's approval is what decides what an AI agent is even allowed to try.

---

## Where a run's evidence goes

```mermaid
flowchart LR
    RUN["Any run"] --> LOG["evidence/logger.js"]
    LOG --> T[["transcript.jsonl<br/>one JSON line per event,<br/>every line tagged with its actor"]]
    LOG --> S[["000-*.png …<br/>screenshots"]]
    LOG --> RES[["result.json<br/>the summary a reviewer opens first"]]
    RUN -->|"discovery that emitted"| G[["goal.json<br/>the capability"]]

    T --> REP["evidence/report.js"]
    S --> REP
    RES --> REP
    REP --> PAGE["report.html?run=&lt;id&gt;"]
```

The AI, replay, and a human operator all write their logs in the exact same format. If
each one needed its own way of being read, the logs wouldn't really prove anything. Folder
names are timestamps, so they're already in the right order — there's no separate list
that could ever get out of sync with them.

**Sensitive values get hidden right when they're written to the log** (`policy/redact.js`),
not later. The real browser still gets the real password, since it actually needs it to
log in — but the log itself only ever sees something like `<string:13>` (just the length,
never the value). A `redacted` flag gets written either way, so anyone reading the log can
see the rule actually ran, instead of just assuming it did.
