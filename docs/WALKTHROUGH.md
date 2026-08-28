# Walkthrough — demo script

---

# Part 1 — The take-home MVP (4 min)

**1. The problem.**
> "Banks have a long tail of internal apps with no API — the only way in is driving
> the screen like a person. Put an AI in front of every transaction and it's slow,
> costly, and can decide differently each time."

**2. The idea.** *(show the first diagram in DESIGN.md, then close it)*
> "The AI learns the flow once. We record it. Then we replay that recording forever
> with no AI in the loop."

**3. The one rule.** → `node --test tests/invariants.test.js`
> "Replay never imports the AI SDK. That's a test — add the import and the build
> fails."

**4. The shape.** *(say, don't show code)*
> "Five actions are all anything can do to a page — navigate, click, type, read,
> wait. The AI, the replay and a human operator all go through the same five, and
> the safety gate is the first line of each."

**5. Live replay.** → `npm run replay -- --id member-inquiry-search-by-last-name --param last_name=Hopper`
> "Fifteen seconds, no model, costs nothing — and that's a different surname than it
> was recorded with, so it's parameterised, not a fixed script."

**6. How I worked.**
> "I time-boxed this deliberately, to stop myself shipping ten features I couldn't
> defend. That rule is why two of them got deleted."

---

# Part 2 — Stretch goals, after the callback (3 min)

**7. Agent catalog.** → **Agent catalog** tab
> "This is what an outside AI sees — only approved capabilities, with typed inputs
> and outputs. Turning an entry into a Claude tool definition is three renames."

**8. Approval and confidence.** *(point at the badges)*
> "Every capability carries how often it actually held, and a risky one can't run
> unattended until a human approves it."

**9. Code generation.**
> "A recording can be exported as a standalone Playwright script — useful for
> handing a flow to a team that doesn't want this system."

**10. Multi-tenant.**
> "A recording is tied to a product, not a URL, so hundreds of institutions on the
> same vendor software share one recording. Where two genuinely differ, an override
> patches only the steps it names."

**11. The two I deleted.**
> "Assisted fallback — letting the AI repair a broken step — worked, but recovered
> two runs out of four, so I removed it rather than ship something half-reliable.
> Same with a drift detector whose fingerprint couldn't count repeated rows."

---

# Part 3 — The challenge (6 min)

**12. Rewrite or config?** → `cat apps/meridian/config.example.json`
> "Pointing my system at your target was this one file — the URL, the routes it may
> touch, the routes that change data, and the fields never written down. No new
> code, no second replay path."

**13. What it broke.**
> "Six assumptions inside my core didn't survive — dropdown labels that carry live
> balances, selectors containing an equals sign, a risk classifier that was never
> actually called. Each is fixed in its own commit, and finding them is what a real
> target is for."

**14. Three things genuinely new.**
> "Error rules that belong to the whole flow rather than one step. An escalate flag
> that turns an anticipated state into a handover. And HTTP status as something a
> checkpoint can assert on."

**15. Chatbot — the happy path.** → **Ask** → `What are the share balances for member 100987?`
> "It picked the capability, filled the typed argument, and drove a real browser
> against the live host. Every figure came back from that call — it can't invent one."

**16. Chatbot — the unhappy path.** → `Transfer $5 from share 100234-S0001 to 100234-S0001-5 for member 100234, memo demo.`
> "Rejected — and carrying the app's own sentence, 'Source share is HOLD and cannot
> be debited.' That's a business outcome, not a failure: the app was asked and it
> answered."

**17. A transfer that works.** → **Capabilities** tab → replay icon on **Post Member Funds Transfer**
Member `100987`, your two OPEN shares, `1.00`, memo `demo`.
> "Same thing an agent would invoke. Real money moved, confirmation number back."

**18. Escalation.** → replay icon on **Place Account Hold**
`102777` · `102777-MMKT-3` · `FRAUD` · notes · **plus `teller1` / `password` in "Run as a different user"**
> "Holds need a supervisor. It stopped instead of guessing, and left the step, the
> URL and a screenshot for whoever picks it up."

**19. Same thing, blank credentials.**
> "Supervisor — posts fine and returns a confirmation. Same recording, different
> operator, and the report names which credential was swapped."

**20. The dashboard.** → **Runs** tab
> "Everything you just watched, colour-coded by outcome, each with a full report
> behind it showing the inputs, the result and the screenshots."

**21. Close.**
> "Six things in my own code broke when I pointed it here, and each one is fixed and
> written up. That's the honest answer to whether this was a config change or a
> rewrite — it was config, and the exercise found real bugs."

---

## Where each criterion is covered

| They're scoring | Step |
| --- | --- |
| Adaptation quality | 12, 13 |
| Correctness of the core loop | 5, 15, 17 |
| Robustness & error handling | 14, 16, 18 |
| Capability API / contract | 7 |
| Demoability | 15–20 |
| Safety & data handling | 3, 4, 18, 19 |
| Escalation | 18 |
| Communication | 11, 13, 21 |

---

## Decisions they'll ask about

**Why Playwright?** It auto-waits, which removes the biggest source of flakiness,
and it exposes the accessibility tree directly.

**Why the accessibility tree, not HTML or screenshots?** Legacy HTML is layout
tables and noise, and screenshots need a vision model on every step. The tree is
roles and names — the same shape a desktop app exposes.

**Why only five actions?** Every action is a place the safety gate has to be
applied. Five means the gate lives in five places and the model picks from a
closed list instead of inventing something.

**How is replay deterministic if locators have fallbacks?** Every rung is
exact-or-unique — a candidate matching two elements is rejected, not guessed
between. Same input picks the same element or none at all.

**How does the model know when to escalate?** During discovery it has an escalate
tool and picks it like any other. During replay no model runs at all — escalation
is a rule it wrote down at discovery time, matched deterministically.

**Why is a session timeout handled two ways?** Re-authenticating is safe for a read
and reckless for a transfer, because the run can't tell whether its post landed
before the session dropped. So reads re-run once; anything moving money stops and
escalates.

**Where does the safety model stop?** The gate checks the route, not the form — a
wrong *amount* on an allowed transfer screen would go through. Field-level policy
on money-moving steps is the next thing I'd build.

**Your outputs are all strings.** True. The read primitive extracts text and
locators are static, so I can't target "the row for share X" from a parameter —
structuring it needs a parsing layer or a sixth primitive, and I chose neither over
half of one.

**What does this cost?** Discovery is one model-call chain per capability, once.
Every replay after that is zero model cost and about fifteen seconds — that's the
whole architectural argument.

**What breaks first at scale?** Credentials are process-global, so two institutions
replaying at once in one process would collide. Per-call overrides exist and are the
right shape; the default path isn't.

**You found six bugs in your own code — was it working?** It worked against the
target it was built on. These were assumptions that target never tested, and a new
surface is exactly what surfaces them.

**If you don't know:** say so, then say how you'd find out.

---

## If they ask to see more

- **All seven capabilities** — Capabilities tab shows them at a glance. Say: *"all
  seven functions are recorded; I ran the ones that come back differently rather
  than seven that all say SUCCESS."*
- **The artifact itself** — `localhost:3000/api/capabilities/place-account-hold`,
  or the **›** chevron on a Capabilities row.
- **The fault table** — `src/engine/recovery-table.js`, the `FAULT_RULES` list:
  400 and 404 are answers, 403 escalates, 503 and 500 recover, 440 splits by risk.
- **Other capabilities' values** — member `103001` for Open New Share (`MMKT`,
  `50.00`) and Update Contact Info.

**Seeds:** 100234 (has a HOLD share), 100987, 101555, 102777, 103001
**Operators:** `teller1` / `password` · `super1` / `password`
