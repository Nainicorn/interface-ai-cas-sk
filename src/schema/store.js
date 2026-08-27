/**
 * Capability persistence: the recorded `goal.json` inside each discovery run folder.
 *
 * Deliberately files, not database rows. A capability is a deliverable meant to be read
 * and diffed by a human in a code review — "reviewable" is an explicit requirement, and
 * a row in SQLite is not reviewable without a client.
 *
 * Layout: evidence/{app}/{kind}/{stamp}/goal.json — the recording lives in the run that
 * produced it, beside the screenshots and transcript proving it ran. There is no
 * separate artifacts tree and no promotion step; apps/ holds user-authored config
 * only. A discovery folder WITH a goal.json passed its gates and is replayable; one
 * without did not.
 *
 * Hands off to: engine/replay.js, api/capabilities.js, agent/artifact-writer.js, cli/*.
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE_DIR } from '../evidence/logger.js';
import { parseCapability } from './capability.js';

export const CAPABILITY_FILE = 'goal.json';

const dirsIn = (parent) =>
  existsSync(parent)
    ? readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];

/**
 * Every recorded capability on disk, with the run folder that produced it.
 * Walked rather than indexed — the folders are already the source of truth, and an
 * index beside them is one more thing that can disagree.
 * @returns {Array<{runId: string, file: string, capability: object}>}
 */
export function listRecordings() {
  const found = [];
  for (const app of dirsIn(EVIDENCE_DIR)) {
    for (const kind of dirsIn(path.join(EVIDENCE_DIR, app))) {
      for (const stamp of dirsIn(path.join(EVIDENCE_DIR, app, kind))) {
        const runId = `${app}/${kind}/${stamp}`;
        const file = path.join(EVIDENCE_DIR, runId, CAPABILITY_FILE);
        if (!existsSync(file)) continue;
        try {
          found.push({ runId, file, capability: JSON.parse(readFileSync(file, 'utf8')) });
        } catch {
          // A half-written recording is not a capability. It stays in the folder as evidence.
        }
      }
    }
  }
  // Oldest first: run ids sort chronologically because the stamp is fixed-width.
  return found.sort((a, b) => a.runId.localeCompare(b.runId));
}

/** Every stored version number for a capability id, ascending. */
export function listVersions(id) {
  return listRecordings()
    .filter((r) => r.capability.id === id)
    .map((r) => r.capability.version)
    .sort((a, b) => a - b);
}

/** The next unused version number for a capability id (1 if it's new). */
export function nextVersion(id) {
  const versions = listVersions(id);
  return versions.length === 0 ? 1 : versions[versions.length - 1] + 1;
}

/**
 * Validate and write a capability into the run folder that produced it.
 *
 * Validation happens on the way in AND on the way out (see loadCapability). Writing a
 * recording that would fail to load is the kind of bug that only surfaces during a
 * demo, so the boundary is checked in both directions.
 *
 * @returns {{path: string, capability: object}}
 */
export function saveCapabilityToRun(runId, input) {
  const capability = parseCapability(input);
  const file = path.join(EVIDENCE_DIR, runId, CAPABILITY_FILE);
  if (!existsSync(path.dirname(file))) {
    throw new Error(`No run folder at evidence/${runId} — the recording has nowhere to live.`);
  }
  writeFileSync(file, `${JSON.stringify(capability, null, 2)}\n`, 'utf8');
  return { path: file, capability };
}

/** Locate a recording by capability id, newest version when none is given. */
function findRecording(id, version) {
  const matches = listRecordings().filter((r) => r.capability.id === id);
  if (matches.length === 0) throw new Error(`No capability found with id "${id}"`);
  if (version === undefined) return matches[matches.length - 1];

  const exact = matches.find((r) => r.capability.version === Number(version));
  if (!exact) throw new Error(`Capability ${id} v${version} not found`);
  return exact;
}

/**
 * Read a capability back, validating as it loads.
 * @param {string} id
 * @param {number} [version] latest if omitted
 */
export function loadCapability(id, version) {
  return parseCapability(findRecording(id, version).capability);
}

/**
 * Summaries of the latest version of every capability.
 * Backs the operator console's capability table.
 */
export function listCapabilities() {
  const latest = new Map();
  for (const record of listRecordings()) latest.set(record.capability.id, record);

  return [...latest.values()].map(({ runId, capability }) => ({
    id: capability.id,
    name: capability.name,
    version: capability.version,
    versions: listVersions(capability.id),
    status: capability.status,
    description: capability.description,
    risk_level: capability.risk_level,
    app_id: capability.target.app_id,
    input_schema: capability.input_schema,
    output_schema: capability.output_schema,
    confidence: capability.confidence,
    run_id: runId, // where it was recorded — the path IS its provenance
  }));
}

/**
 * Apply a partial update to a stored recording, in place.
 *
 * Only for fields that legitimately change after recording — `status` (the approval
 * gate) and `confidence` (the rolling reliability signal). Changing recorded STEPS is a
 * new discovery run, never an edit, which is why this validates the merged result.
 */
export function updateCapability(id, version, patch) {
  const record = findRecording(id, version);
  const merged = parseCapability({ ...record.capability, ...patch });
  writeFileSync(record.file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return { path: record.file, capability: merged };
}

/**
 * Delete a capability by removing its goal.json — and nothing else.
 *
 * The run folder around it stays. A run is evidence of something that actually happened,
 * and a later decision to stop offering the capability it produced is not a reason to
 * destroy the proof: the folder simply reverts to being a discovery that yielded no
 * capability, which is a state the store already understands.
 *
 * @returns {{run_id: string}} the run that keeps its evidence
 */
export function deleteCapability(id, version) {
  const record = findRecording(id, version);
  rmSync(record.file, { force: true });
  return { run_id: record.runId };
}


/**
 * Fold one replay outcome into the capability's rolling confidence signal.
 *
 * "Success" here means the RECORDING executed as designed — SUCCESS, BUSINESS_OUTCOME,
 * and RECOVERABLE all count, because in each the locators resolved and the outcome was
 * classified by a declared rule. Only HARD_FAILURE counts against the recording.
 */
export function recordReplayOutcome(id, version, outcome) {
  const current = loadCapability(id, version);
  return updateCapability(id, version, {
    confidence: {
      runs: current.confidence.runs + 1,
      successes: current.confidence.successes + (outcome === 'HARD_FAILURE' ? 0 : 1),
      last_outcome: outcome,
      updated_at: new Date().toISOString(),
    },
  });
}
