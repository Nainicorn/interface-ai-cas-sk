# PLAN.md

Nothing outstanding — everything on this list is built, committed, and pushed.

What a reviewer might reasonably ask for next is argued in [REPORT.md](../REPORT.md) §7,
in priority order:

1. **Authentication on the agent surface.** Approval governs which capabilities an agent
   can see, never who may ask; the control plane is safe today only because it binds to
   localhost.
2. **Observation-level redaction.** Redaction covers values the system types, not what the
   app displays — page observations are captured whole.
3. **The invariant tests.** One gate, one action layer, no LLM SDK in replay. All three are
   checkable in a few assertions and should be enforced rather than asserted in prose.
4. **`tenant_overrides` applied at replay**, exercised against two real deployments of one
   vendor product.
