/**
 * UI drift detection: an early-warning signal that a target's page has changed
 * meaningfully since the last time this capability established a baseline — even when
 * the replay that observed it still succeeded.
 *
 * Not a new failure mode. A step whose checkpoint holds is still SUCCESS; drift is a
 * side-channel warning logged to evidence and returned alongside the result, because the
 * gap between "still works today" and "still works next month" is exactly what a fixed,
 * one-time recording cannot see on its own.
 *
 * The baseline is established once — on a capability's first successful replay, in
 * schema/store.js — and never silently drifts along with the app afterward. If it did,
 * a slow, one-step-at-a-time UI migration would renormalize into the baseline and never
 * trip a warning at all.
 *
 * Hands off to: engine/replay.js, schema/store.js.
 */

/** Meaningful drift starts here — tolerates normal noise (dynamic text, minor
 *  reordering) while still catching a genuinely different page. */
export const DRIFT_THRESHOLD = 0.3;

/**
 * A compact, order-insensitive structural fingerprint of a page state.
 *
 * Deliberately not a hash — a hash says "different", never "how different" or "which
 * lines changed". This is the deduplicated, sorted set of non-blank lines from the
 * accessibility tree perception.js already captures, so reordering the same elements (a
 * common, harmless kind of change) never registers as drift.
 *
 * @param {string} ariaTree from perception.js's captureState()
 * @returns {string[]}
 */
export function fingerprint(ariaTree) {
  return [...new Set(String(ariaTree ?? '').split('\n').map((line) => line.trim()).filter(Boolean))].sort();
}

/**
 * How different two fingerprints are: 0 identical, 1 nothing in common. Symmetric set
 * difference over their union — the same shape as a Jaccard distance.
 */
export function driftScore(baseline, observed) {
  const a = new Set(baseline);
  const b = new Set(observed);
  if (a.size === 0 && b.size === 0) return 0;
  const union = new Set([...a, ...b]);
  const shared = [...a].filter((line) => b.has(line)).length;
  return 1 - shared / union.size;
}

/** Whether a comparison crosses the line from "normal noise" to "worth a human's attention". */
export const isDrifted = (score) => score > DRIFT_THRESHOLD;
