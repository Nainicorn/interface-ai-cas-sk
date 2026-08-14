/**
 * Typed engine errors.
 *
 * These exist so replay can CLASSIFY rather than guess. A bare Error with a message
 * string would force the outcome logic to pattern-match on prose, which is exactly the
 * kind of fuzziness the determinism argument rules out.
 *
 * Note what is NOT here: "member not found" and friends. Those are business outcomes
 * declared in the artifact, not exceptions — conflating them is the mistake this whole
 * design is organised around avoiding.
 *
 * Hands off to: engine/replay.js (classification), evidence/logger.js (reporting).
 */

/** No locator candidate resolved to exactly one usable element. */
export class LocatorResolutionError extends Error {
  constructor(description, attempts) {
    super(`Could not resolve "${description}" — all ${attempts.length} candidate(s) failed`);
    this.name = 'LocatorResolutionError';
    this.description = description;
    /** @type {Array<{candidate: object, matchCount: number, reason: string}>} */
    this.attempts = attempts;
  }
}

/** An action ran but its declared checkpoint did not hold afterwards. */
export class CheckpointFailed extends Error {
  constructor(condition, observed) {
    super(`Checkpoint failed: expected ${condition.type} "${condition.value}"`);
    this.name = 'CheckpointFailed';
    this.condition = condition;
    this.observed = observed;
  }
}

/** A step is internally inconsistent — e.g. a `type` action with no value source. */
export class MalformedStep extends Error {
  constructor(stepIndex, reason) {
    super(`Step ${stepIndex} is malformed: ${reason}`);
    this.name = 'MalformedStep';
    this.stepIndex = stepIndex;
  }
}

/** A credential named by a step is not present in the environment. */
export class MissingCredential extends Error {
  constructor(envVar) {
    super(`Environment variable ${envVar} is not set. Add it to .env (see .env.example).`);
    this.name = 'MissingCredential';
    this.envVar = envVar;
  }
}
