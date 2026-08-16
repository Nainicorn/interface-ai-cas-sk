# /evidence/ — the demonstration

Every run writes its own folder: `evidence/<app>/<kind>/<stamp>/` containing
`transcript.jsonl` (one JSON line per event, each tagged with the actor that caused it),
numbered screenshots, `result.json` (the summary to open first), and — if the run produced
one — the recorded capability as `goal.json`.

**Five runs tell the whole story.** Everything else here is development history, kept
because evidence is never hand-edited.

| Run | What it demonstrates |
|---|---|
| `heroku_app/discovery/2026-08-16_183850` | **A real LLM discovery run.** 5 model turns against a live browser, ending in a typed capability (`goal.json` → `heroku-app-login`). Credentials redacted: `username` → `<string:8>`, `HEROKU_APP_PASSWORD` → `<string:20>`. |
| `heroku_app/replay/2026-08-16_184013` | **Deterministic replay, SUCCESS.** No LLM. Checkpoint verified, typed output extracted: `{"confirmation_message": "You logged into a secure area!"}` |
| `heroku_app/replay/2026-08-16_184036` | **The exceptional state — BUSINESS_OUTCOME.** The same capability invoked *through the agent catalog* with an unknown username returns `INVALID_USERNAME` as a typed answer, HTTP 200. Not a crash. This is the distinction the whole result contract exists for. |
| `heroku_app/discovery/2026-08-16_184054` | **Human-in-the-loop.** Paused on the step budget with the browser held open, a human acted on that same live session (landing on `/secure`), handed control back in plain English, and the agent finished and recorded. The transcript reads `llm → paused → human → resumed → llm`. |
| `heroku_app/discovery/2026-08-16_191141` | **The dead-end stopping condition.** A goal the app genuinely cannot do (a fund transfer on a UI-demo site). The agent concluded it was impossible and ended the run as `unreachable` with its reasoning — a verdict rather than an infinite loop of asking a human. |

## Reading a transcript

```bash
# the story of a run, one line per event
python3 -c "
import json
for l in open('evidence/heroku_app/discovery/2026-08-16_184054/transcript.jsonl'):
    e=json.loads(l); print(e.get('type'), e.get('actor',''), e.get('action',''))"
```

The `actor` field is the point: `llm`, `replay`, and `human` actions all land in one trail
in one format, because they all go through the same five action primitives.

## Reproducing these

The recordings are committed; the app config that points at the target is **not** (it holds
credentials — `artifacts/*/config.json` is gitignored). Register the practice app once and
these capabilities replay as recorded:

```bash
npm start
curl -X POST localhost:3000/api/targets -H 'content-type: application/json' -d '{
  "name": "Heroku App",
  "url": "https://the-internet.herokuapp.com/login",
  "goal": "Log in with the supplied username and password, then read the confirmation message in the secure area",
  "username": "tomsmith",
  "password": "SuperSecretPassword!"
}'

npm run replay -- --id heroku-app-login --param username=tomsmith      # SUCCESS
npm run replay -- --id heroku-app-login --param username=no-such-user  # BUSINESS_OUTCOME
```

Those are the practice site's own publicly documented test credentials — it prints them on
its login page, which is also why they appear in the discovery transcript's page
observations. Redaction covers values the system *types*, not what the app *displays*; see
REPORT.md §6.
