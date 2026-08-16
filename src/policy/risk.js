/**
 * Risk classification: which actions are reversible, and which need a human.
 *
 * Safe/reversible actions are distinguished from risky/irreversible ones, and the risky
 * class is handled conservatively. Two signals decide it, and either one is enough to
 * escalate the classification:
 *
 *   1. The action type — reads and navigation cannot change state.
 *   2. The route — an app declares which routes mutate (risky_route_patterns).
 *
 * Route matters because "click" is safe on a search button and risky on a submit button,
 * and the action type alone cannot tell them apart.
 *
 * Hands off to: agent/discovery.js (escalate before risky), api/artifacts.js and
 * api/capabilities.js (the approval gate).
 */

import { routeOf } from './allowlist.js';

/**
 * Raised when a capability is refused for want of human approval.
 *
 * A refusal is NOT a HARD_FAILURE: the run never started, so it says nothing about
 * whether the recording still works. It surfaces as 403 and never touches the rolling
 * confidence signal.
 */
export class ApprovalRequired extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = 'ApprovalRequired';
    this.status = 403;
    this.detail = detail;
  }
}

/** Action types that cannot mutate server state, whatever route they happen on. */
const INHERENTLY_SAFE_ACTIONS = new Set(['read', 'wait_for', 'navigate']);

/**
 * Classify one action.
 * @returns {{ level: 'safe'|'risky', reason: string }}
 */
export function classifyRisk({ target, action, url }) {
  if (INHERENTLY_SAFE_ACTIONS.has(action)) {
    return { level: 'safe', reason: `"${action}" cannot modify state` };
  }

  const patterns = target.risky_route_patterns ?? [];
  let route;
  try {
    route = routeOf(target, url ?? '/');
  } catch {
    // An unresolvable URL is not a licence to assume safety.
    return { level: 'risky', reason: 'Route could not be resolved; defaulting to risky' };
  }

  const matched = patterns.find((pattern) => route.includes(pattern));
  if (matched) {
    return { level: 'risky', reason: `Route "${route}" matches risky pattern "${matched}"` };
  }

  return { level: 'safe', reason: `"${action}" on "${route}" is not a declared state change` };
}

/**
 * Whether a capability may be advertised to — and invoked by — an external AI agent.
 *
 * Deliberately stricter than checkUnattendedAllowed: a safe draft may replay from the
 * operator console, where a human is watching, but the agent-facing catalog is
 * unattended by definition. What an autonomous agent can discover and call is an
 * explicit human grant, so only `approved` capabilities exist on that surface at all.
 *
 * @returns {{ allowed: boolean, reason: string }}
 */
export function checkAgentInvocable(capability) {
  if (capability.status !== 'approved') {
    return {
      allowed: false,
      reason:
        `Capability "${capability.id}" is "${capability.status}". Only approved capabilities ` +
        `are agent-invocable — a human promotes it via PATCH /api/artifacts/${capability.id}/status.`,
    };
  }
  return { allowed: true, reason: 'Capability is approved for agent invocation' };
}

/**
 * Whether a capability may replay without a human present.
 *
 * A risky capability stays unattended-ineligible until someone approves it. This is the
 * conservative half of the safety model: the system will happily replay a read-only
 * lookup a thousand times, but will not open a bank account on its own authority.
 *
 * @returns {{ allowed: boolean, reason: string }}
 */
export function checkUnattendedAllowed(capability) {
  if (capability.risk_level === 'safe') {
    return { allowed: true, reason: 'Capability is classified safe' };
  }
  if (capability.status === 'approved') {
    return { allowed: true, reason: 'Risky capability has been explicitly approved' };
  }
  return {
    allowed: false,
    reason:
      `Capability "${capability.id}" is risky and still in draft. ` +
      'Approve it (PATCH status to "approved") before unattended replay.',
  };
}
