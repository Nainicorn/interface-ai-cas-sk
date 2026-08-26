# DESIGN.md — the flow, and the file that does each job

Every box names the file that actually does the work, so you can go from a picture to the
code without hunting. Diagrams render on GitHub.

The through-line the whole system is arranged around:

> **The model discovers. The recording becomes a reusable capability. Deterministic replay
> is how a production agent invokes it.**

---

## The shape of it

Three callers, one action layer, one evidence trail.

```mermaid
flowchart TB
    subgraph callers["Three callers — and there is no fourth"]
        LLM["LLM discovery loop<br/>agent/discovery.js"]
        REPLAY["Deterministic replay<br/>engine/replay.js"]
        HUMAN["Human operator<br/>agent/escalation.js"]
    end

    GATE{"checkAllowed<br/>policy/allowlist.js<br/>opens every primitive"}

    ACTIONS["The five primitives<br/>engine/actions.js<br/>navigate · click · type · read · wait_for"]

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

Two claims are load-bearing here, and both are structural rather than promised:

- **One action layer.** If a reviewer finds a second implementation of "click" anywhere in
  this repo, the design claim is false. The model does not get to *just click* — it
  chooses which of the five primitives to invoke, exactly as replay does.
- **One gate.** `checkAllowed` is the first line of each primitive rather than a thing each
  caller remembers to call, so no caller can forget it. The app's own origin is the hard
  edge; no permission setting widens it.

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

**Why the accessibility tree.** It is the one perception channel that exists on a modern
web app, a frameset-and-nested-tables legacy app, *and* a native desktop app. Swapping
Playwright for an OS accessibility API later changes one file.

**The recording lives in the run folder.** There is no separate artifacts tree and no
promotion step: `goal.json` sits beside the transcript and screenshots that prove it ran.
A discovery folder *with* one passed its gates; one without did not.

**The model never learns a secret.** `config/app-config.js` pushes credential values into
`process.env` under derived names and passes only the **names** to the prompt. The model
decides where a password goes; the harness resolves what it is, after the fact.

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

**`engine/replay.js` imports no LLM SDK.** That is the invariant the determinism claim
rests on — if the Anthropic SDK ever appears in that file, the thesis is broken.

**BUSINESS_OUTCOME is the point.** Collapsing *"no such member"* into a crash is the most
common way this problem gets got wrong, so business outcomes are **declared in the
recording** and checked *before* the success checkpoint — and again when a locator resolves
to nothing, because a missing element is sometimes the answer rather than a fault.

**A refusal is not a failure.** The gate runs before anything is written, so a refused
capability leaves no run row, no evidence folder, and no mark on its confidence: nothing
happened, and the record says nothing happened.

**Cross-tenant reuse is a seam in front of this diagram, not a branch inside it.** An
optional `tenant_id` runs `applyTenantOverride()` before ENTRY does anything else — it
patches the named steps' locators/urls (and optionally points at a different origin) and
hands `EXEC` an ordinary capability. Everything from PARAMS onward, including the
four-way outcome contract and the confidence fold, has no idea a patch happened. A tenant
running the identical vendor product needs no override at all; one with a couple of
relabeled buttons needs only those steps named, not a re-record.

---

## 3. The approval gate, and the two surfaces it separates

One store, two views. The narrower one is what an agent gets.

```mermaid
flowchart LR
    STORE[("Recordings on disk<br/>schema/store.js")]

    subgraph op["Operator surface — api/artifacts.js"]
        OL["GET /api/artifacts<br/>drafts included"]
        OS["PATCH /:id/status<br/>the one human act"]
        OR["POST /:id/replay"]
        OD["DELETE /:id<br/>refused while approved"]
    end

    subgraph ag["Agent surface — api/capabilities.js"]
        AL["GET /api/capabilities<br/>approved only — a draft is<br/>invisible, not refused"]
        AI["POST /:id/invoke"]
    end

    STORE --> OL
    STORE --> AL
    OS -->|"draft → approved"| AL
    OS -->|"approved → draft"| GONE["vanishes from the catalog"]
    OR --> RR["api/run-replay.js"]
    AI --> RR
```

A capability is born `draft`. Promotion is the only act the system never grants itself.
Demotion is deliberately as easy as promotion — a capability whose replays start failing
should be pullable immediately, without deleting the recording or its history.

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

**Two mechanisms, both needed.** An explicit `owner` flag says who *should* be acting; a
per-run async mutex (`RunLock`) says who *is*. Node is single-threaded, but async handlers
interleave at every `await` — "it's single-threaded so it's fine" would be wrong.

**The channel back is language, not selectors.** The goal was written in English and the
model reasons in English, so the operator says *"the code is 481920, type it into the code
box"* and the model does what it already knows how to do. `performManualAction` still
exists and still routes human actions through the same five primitives tagged
`actor: "human"` — it is simply not what the operator is asked to fill in by hand.

---

## 5. An agent calling the catalog

The one path that crosses a process boundary. `tests/agent-demo.js` imports nothing
from `src/` — if it could reach into the codebase it would prove nothing about what an
outside caller can do.

```mermaid
sequenceDiagram
    participant D as tests/agent-demo.js
    participant C as api/capabilities.js
    participant M as Claude
    participant R as "api/run-replay.js → engine/replay.js"

    D->>C: GET /api/capabilities
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

Revoke the capability and run it again: the model is told it has no tools. **A human's
approval decision is what an agent is able to do.**

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

One format serves all three actors — the LLM loop, replay, and the human operator — because
an evidence trail that needed three readers would prove nothing. Folder names sort
chronologically, so the history needs no index that could disagree with it.

**Redaction happens at the point of logging** (`policy/redact.js`), not at the point of
use: the live browser gets the real password, the transcript gets `<string:13>`, and an
explicit `redacted` flag is written either way so a reviewer can see the rule ran.
