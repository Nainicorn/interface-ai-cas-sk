#!/usr/bin/env bash
#
# Demo script — the whole system, in the order it makes sense to show it.
#
#   ./demo.sh          list the steps
#   ./demo.sh 4        run just step 4
#   ./demo.sh 1 2 3    run steps 1, 2 and 3
#   ./demo.sh all      run every step that needs no API key
#
# Steps marked [KEY] call the model and need ANTHROPIC_API_KEY in .env.
# Everything else runs with no model at all — which is the point.
#
# The server must be running for the HTTP steps: npm start

set -uo pipefail
cd "$(dirname "$0")"

CAP="${CAP:-add-remove-elements-cycle}"      # the capability most steps use
APP="${APP:-internet}"                        # the app it belongs to
BASE="${BASE:-http://localhost:3000}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
run()  { dim "\$ $*"; eval "$@"; echo; }

# ---------------------------------------------------------------------------

step_1() {
  bold "1. The tests — including the ones that prove the design claims"
  dim   "invariants.test.js reads the source: replay must never import the AI SDK,"
  dim   "every action must start with the safety gate, and there is only one 'click'."
  run "npm test"
}

step_2() {
  bold "2. Register the practice app"
  dim   "App configs are gitignored (they hold credentials), so a fresh clone needs this."
  run "curl -s -X POST $BASE/api/apps -H 'content-type: application/json' -d '{
  \"name\": \"internet\",
  \"url\": \"https://the-internet.herokuapp.com/\",
  \"goal\": \"Navigate to Add/Remove Elements, add an element once, then remove it\"
}'"
}

step_3() {
  bold "3. Replay a recorded capability — NO AI involved"
  dim   "About 5 seconds. It just walks the saved steps and checks each one."
  run "npm run replay -- --id $CAP"
}

step_4() {
  bold "4. Replay it headed, so you can watch it"
  run "npm run replay -- --id $CAP --headed"
}

step_5() {
  bold "5. THE IMPORTANT ONE — a bad input is an ANSWER, not a crash"
  dim   "Same capability, bad username. Comes back BUSINESS_OUTCOME with a code,"
  dim   "not HARD_FAILURE. Telling those two apart is the whole design."
  run "npm run invoke -- --id heroku-app-login --param username=not_a_real_user"
  bold "   ...and the same call with a good username"
  run "npm run invoke -- --id heroku-app-login --param username=tomsmith"
}

step_6() {
  bold "6. Secrets never reach the log"
  dim   "The browser got the real password. The transcript got its length."
  local latest
  latest=$(ls -dt evidence/heroku_app/replay/*/ 2>/dev/null | head -1)
  if [ -z "$latest" ]; then echo "  (run step 5 first)"; return; fi
  run "grep -o '\"field\":\"[^\"]*\",\"value\":\"[^\"]*\",\"redacted\":[a-z]*' ${latest}transcript.jsonl"
}

step_7() {
  bold "7. Is it reliable? Replay it 5 times and score it"
  dim   "Not a special test mode — 5 real replays, aggregated."
  run "npm run stability -- --id $CAP --runs 5"
}

step_8() {
  bold "8. Turn the recording into a standalone Playwright script"
  dim   "Runs with plain node. No part of this system involved."
  run "npm run generate -- --id $CAP --out ./$CAP.spec.js"
  run "BASE_URL=https://the-internet.herokuapp.com node ./$CAP.spec.js"
  run "rm -f ./$CAP.spec.js"
}

step_9() {
  bold "9. Does any recorded URL look tenant-specific?"
  dim   "Suggestion only — it never rewrites your recording."
  run "npm run canonicalize -- --id $CAP"
}

step_10() {
  bold "10. The approval gate: two surfaces over the same files"
  dim   "Operator sees everything. An outside AI sees only what a human approved."
  run "curl -s $BASE/api/capabilities | python3 -c \"import json,sys;[print(f'  {c[\\\"id\\\"]:32} {c[\\\"status\\\"]}') for c in json.load(sys.stdin)]\""
  bold "   what an outside AI can see:"
  run "curl -s $BASE/api/catalog | python3 -c \"import json,sys;[print('  '+c['id']) for c in json.load(sys.stdin)]\""
  bold "   a draft is not refused — it does not exist:"
  run "curl -s -o /dev/null -w '  GET /api/catalog/get-total-signups → HTTP %{http_code}\n' $BASE/api/catalog/get-total-signups"
}

step_11() {
  bold "11. The catalog an agent sees, from the CLI"
  run "npm run invoke"
}

step_12() {
  bold "12. [KEY] A REAL outside AI picks the capability and calls it"
  dim   "agent-demo.js imports nothing from src/ — it only talks HTTP, like a real caller."
  run "npm run agent-demo -- \"add an element on the page and then remove it again\""
}

step_13() {
  bold "13. [KEY] Discovery — the AI works out a NEW flow from scratch"
  dim   "Takes about a minute. Opens a real browser. This is the part that uses the model."
  run "npm run discover -- --app-id $APP --goal \"Navigate to Add/Remove Elements, add an element once, then remove it\""
}

step_14() {
  bold "14. [KEY] Assisted fallback — one bounded AI call, opt-in, off by default"
  dim   "Only fires if a locator cannot be found at all, and only once per replay."
  run "npm run replay -- --id $CAP --assisted-fallback"
}

# ---------------------------------------------------------------------------

ALL_SAFE=(1 2 3 5 6 7 8 9 10 11)

usage() {
  bold "Demo steps"
  cat <<'EOF'
   1  npm test                          the tests, incl. the design-claim ones
   2  register the practice app         needed on a fresh clone
   3  replay, no AI                     the core loop
   4  replay headed                     same thing, watchable
   5  bad input -> BUSINESS_OUTCOME     the most important one
   6  show the redacted log line        secrets never persisted
   7  stability x5                      how reliably it holds
   8  generate a standalone script      code-generation stretch goal
   9  canonicalize                      cross-tenant stretch goal
  10  approval gate, both surfaces      operator vs agent view
  11  the agent catalog from the CLI
  12  a REAL outside AI calls it        [needs API key]
  13  discovery from scratch            [needs API key]
  14  assisted fallback                 [needs API key]

  ./demo.sh 5          run one
  ./demo.sh 3 5 7      run several
  ./demo.sh all        every step that needs no API key
EOF
}

if [ $# -eq 0 ]; then usage; exit 0; fi
if [ "$1" = "all" ]; then set -- "${ALL_SAFE[@]}"; fi

for n in "$@"; do
  if declare -f "step_$n" > /dev/null; then
    echo; "step_$n"
  else
    echo "No step $n. Run ./demo.sh with no arguments to see the list."
  fi
done
