/**
 * Run and intervention records, stored as files in the evidence folder.
 *
 * There is no database. A run IS its timestamped folder — `result.json` is the record,
 * updated in place from `running` to its final outcome, and an escalation is
 * `intervention.json` beside it. Anything a reviewer can learn from this module they
 * can also learn by opening the folder, which is the point.
 *
 * Run ids are relative paths under evidence/: "some_app/discovery/2026-08-15_142233".
 *
 * Hands off to: api/runs.js, api/escalation.js, agent/discovery.js, agent/escalation.js.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE_DIR } from './logger.js';

const now = () => new Date().toISOString();

const runDir = (id) => path.join(EVIDENCE_DIR, id);
const resultPath = (id) => path.join(runDir(id), 'result.json');
const interventionPath = (id) => path.join(runDir(id), 'intervention.json');

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // a half-written file during a crash is a missing record, not a throw
  }
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return data;
}

/**
 * Open a run record. Written immediately rather than at completion, so a run that
 * crashes mid-flight still leaves a folder that explains what it was attempting.
 */
export function createRun({ id, kind, appId, goal = null, status = 'running', detail = {} }) {
  return writeJson(resultPath(id), {
    id,
    kind,
    app_id: appId,
    goal,
    status,
    detail,
    started_at: now(),
    updated_at: now(),
  });
}

/** Merge an update into an existing run record. */
export function updateRun(id, { status, detail }) {
  const current = readJson(resultPath(id)) ?? { id };
  return writeJson(resultPath(id), {
    ...current,
    ...(status === undefined ? {} : { status }),
    ...(detail === undefined ? {} : { detail: { ...current.detail, ...detail } }),
    updated_at: now(),
  });
}

export function getRun(id) {
  return readJson(resultPath(id));
}

/**
 * Every run, newest first. Walks evidence/<app>/<kind>/<stamp>/ rather than keeping an
 * index — the folder names are already sorted by timestamp, and an index would be a
 * second source of truth that can disagree with the folders.
 */
export function listRuns({ limit = 50 } = {}) {
  if (!existsSync(EVIDENCE_DIR)) return [];
  const runs = [];

  const dirs = (parent) =>
    existsSync(parent)
      ? readdirSync(parent, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      : [];

  for (const app of dirs(EVIDENCE_DIR)) {
    for (const kind of dirs(path.join(EVIDENCE_DIR, app))) {
      for (const stamp of dirs(path.join(EVIDENCE_DIR, app, kind))) {
        const id = `${app}/${kind}/${stamp}`;
        const record = readJson(resultPath(id));
        if (record) runs.push({ ...record, id, kind: record.kind ?? kind, app_id: record.app_id ?? app });
      }
    }
  }

  return runs.sort((a, b) => String(b.started_at ?? b.id).localeCompare(String(a.started_at ?? a.id))).slice(0, limit);
}

/**
 * Record a pause for human help. One pending intervention per run — the run is either
 * waiting for a human or it is not, and a queue of them would imply a concurrency the
 * single live session does not have. Its id IS the run id: one run, one pause.
 */
export function createIntervention({ runId, reason, context = {} }) {
  return writeJson(interventionPath(runId), {
    id: runId,
    run_id: runId,
    reason,
    context,
    status: 'pending',
    created_at: now(),
    resolved_at: null,
    resolution: {},
  });
}

export function resolveIntervention(id, resolution = {}) {
  const current = readJson(interventionPath(id));
  if (!current) return null;
  return writeJson(interventionPath(id), {
    ...current,
    status: 'resolved',
    resolution,
    resolved_at: now(),
  });
}

export function getIntervention(id) {
  return readJson(interventionPath(id));
}

export function listInterventions({ status } = {}) {
  return listRuns({ limit: Number.MAX_SAFE_INTEGER })
    .map((run) => readJson(interventionPath(run.id)))
    .filter((entry) => entry !== null)
    .filter((entry) => (status === undefined ? true : entry.status === status));
}

/**
 * Mark runs left "running" by a crash or a restart as interrupted.
 *
 * Without this, a killed process leaves a run that claims to be live forever, and the
 * console shows a spinner nobody will ever resolve.
 */
export function reconcileAtBoot() {
  let reconciled = 0;
  for (const run of listRuns({ limit: Number.MAX_SAFE_INTEGER })) {
    if (run.status !== 'running' && run.status !== 'paused') continue;
    updateRun(run.id, { status: 'interrupted', detail: { reconciled_at: now() } });
    const open = readJson(interventionPath(run.id));
    if (open?.status === 'pending') resolveIntervention(run.id, { note: 'process restarted' });
    reconciled += 1;
  }
  return reconciled;
}
