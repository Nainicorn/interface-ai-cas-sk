/**
 * Artifact persistence: versioned capability JSON on disk.
 *
 * Deliberately files, not database rows. Artifacts are a deliverable meant to be read
 * and diffed by humans in a code review — "reviewable" is an explicit requirement, and
 * a row in SQLite is not reviewable without a client. Runs and interventions, which are
 * operational rather than reviewable, do live in SQLite.
 *
 * Layout: artifacts/{capability-id}/v{n}.json
 *
 * Hands off to: engine/replay.js, api/artifacts.js, cli/*.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCapability } from './capability.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ARTIFACTS_DIR = path.resolve(here, '../../artifacts');

const versionFile = (id, version) => path.join(ARTIFACTS_DIR, id, `v${version}.json`);

/** Parse "v3.json" -> 3. Returns null for anything else. */
function versionFromFilename(filename) {
  const match = /^v(\d+)\.json$/.exec(filename);
  return match ? Number(match[1]) : null;
}

/**
 * Every stored version number for a capability, ascending.
 * @returns {Promise<number[]>} empty if the capability has never been saved
 */
export async function listVersions(id) {
  const dir = path.join(ARTIFACTS_DIR, id);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries.map(versionFromFilename).filter((v) => v !== null).sort((a, b) => a - b);
}

/** The next unused version number for a capability id (1 if it's new). */
export async function nextVersion(id) {
  const versions = await listVersions(id);
  return versions.length === 0 ? 1 : versions[versions.length - 1] + 1;
}

/**
 * Validate and write a capability.
 *
 * Validation happens on the way in AND on the way out (see loadCapability). Writing an
 * artifact that would fail to load is the kind of bug that only surfaces during a demo,
 * so the boundary is checked in both directions.
 *
 * Refuses to overwrite an existing version — artifact history is append-only, because
 * a replay result in evidence/ references a specific version and must stay meaningful.
 *
 * @returns {Promise<{path: string, capability: object}>}
 */
export async function saveCapability(input, { overwrite = false } = {}) {
  const capability = parseCapability(input);
  const file = versionFile(capability.id, capability.version);

  if (!overwrite && existsSync(file)) {
    throw new Error(
      `Capability ${capability.id} v${capability.version} already exists. ` +
        `Bump the version rather than overwriting — evidence records reference versions.`,
    );
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(capability, null, 2)}\n`, 'utf8');
  return { path: file, capability };
}

/**
 * Read a capability back, validating as it loads.
 * @param {string} id
 * @param {number} [version] latest if omitted
 */
export async function loadCapability(id, version) {
  let resolved = version;
  if (resolved === undefined) {
    const versions = await listVersions(id);
    if (versions.length === 0) throw new Error(`No capability found with id "${id}"`);
    resolved = versions[versions.length - 1];
  }

  const file = versionFile(id, resolved);
  if (!existsSync(file)) throw new Error(`Capability ${id} v${resolved} not found at ${file}`);

  return parseCapability(JSON.parse(await readFile(file, 'utf8')));
}

/**
 * Summaries of the latest version of every capability.
 * Backs both the operator console's artifact list and the agent-facing catalog.
 */
export async function listCapabilities() {
  if (!existsSync(ARTIFACTS_DIR)) return [];
  const ids = (await readdir(ARTIFACTS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const summaries = [];
  for (const id of ids) {
    const versions = await listVersions(id);
    if (versions.length === 0) continue;
    const capability = await loadCapability(id, versions[versions.length - 1]);
    summaries.push({
      id: capability.id,
      name: capability.name,
      version: capability.version,
      versions,
      status: capability.status,
      description: capability.description,
      risk_level: capability.risk_level,
      app_id: capability.target.app_id,
      input_schema: capability.input_schema,
      output_schema: capability.output_schema,
      confidence: capability.confidence,
    });
  }
  return summaries;
}

/**
 * Apply a partial update to an existing version, in place.
 *
 * Only for fields that legitimately change after recording — `status` (the approval
 * gate) and `confidence` (the rolling reliability signal). Changing recorded STEPS is
 * a new version, never an edit, which is why this validates the merged result.
 */
export async function updateCapability(id, version, patch) {
  const current = await loadCapability(id, version);
  const merged = { ...current, ...patch };
  return saveCapability(merged, { overwrite: true });
}
