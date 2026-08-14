/**
 * Operational state: runs and interventions.
 *
 * SQLite for what is operational, JSON files for what is reviewable — artifacts are
 * deliverables a human diffs in review, so they live on disk; run rows and intervention
 * queues are workflow state nobody reviews line-by-line, so they live here.
 *
 * better-sqlite3 is synchronous by design. That is fine at this scale and it removes a
 * whole class of await-interleaving bugs from the write path.
 *
 * Hands off to: api/runs.js, api/escalation.js, agent/escalation.js.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Overridable so tests get a throwaway database. */
const DB_PATH = process.env.DB_PATH ?? path.resolve(here, '../../data/automation.db');

let db = null;

/** Open (and initialize) the database once per process. */
export function getDb() {
  if (db) return db;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,             -- discovery | replay
      app_id      TEXT NOT NULL,
      goal        TEXT,                      -- discovery only
      status      TEXT NOT NULL,             -- running | paused | recorded | escalated | failed | SUCCESS | BUSINESS_OUTCOME | HARD_FAILURE
      detail      TEXT,                      -- JSON: artifact ref, outcome, usage…
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS interventions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id      TEXT NOT NULL REFERENCES runs(id),
      reason      TEXT NOT NULL,
      context     TEXT,                      -- JSON: url, screenshot, goal, step…
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending | resolved
      created_at  TEXT NOT NULL,
      resolved_at TEXT,
      resolution  TEXT                       -- JSON: note, manual action count
    );
  `);
  return db;
}

const now = () => new Date().toISOString();

// ── runs ────────────────────────────────────────────────────────────────────

export function createRun({ id, kind, appId, goal = null, status = 'running', detail = {} }) {
  getDb()
    .prepare(
      `INSERT INTO runs (id, kind, app_id, goal, status, detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, kind, appId, goal, status, JSON.stringify(detail), now(), now());
}

export function updateRun(id, { status, detail }) {
  const current = getRun(id);
  if (!current) throw new Error(`No run with id "${id}"`);
  getDb()
    .prepare(`UPDATE runs SET status = ?, detail = ?, updated_at = ? WHERE id = ?`)
    .run(status ?? current.status, JSON.stringify(detail ?? current.detail), now(), id);
}

export function getRun(id) {
  const row = getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id);
  return row ? { ...row, detail: JSON.parse(row.detail ?? '{}') } : null;
}

export function listRuns({ limit = 50 } = {}) {
  return getDb()
    .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
    .all(limit)
    .map((row) => ({ ...row, detail: JSON.parse(row.detail ?? '{}') }));
}

// ── interventions ───────────────────────────────────────────────────────────

export function createIntervention({ runId, reason, context = {} }) {
  const info = getDb()
    .prepare(
      `INSERT INTO interventions (run_id, reason, context, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .run(runId, reason, JSON.stringify(context), now());
  return Number(info.lastInsertRowid);
}

export function resolveIntervention(id, resolution = {}) {
  getDb()
    .prepare(`UPDATE interventions SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ?`)
    .run(now(), JSON.stringify(resolution), id);
}

export function getIntervention(id) {
  const row = getDb().prepare(`SELECT * FROM interventions WHERE id = ?`).get(id);
  return row
    ? { ...row, context: JSON.parse(row.context ?? '{}'), resolution: JSON.parse(row.resolution ?? 'null') }
    : null;
}

/**
 * Boot-time hygiene. Live sessions do not survive a process restart, so any run still
 * marked running/paused — and any pending intervention — is orphaned: nothing can ever
 * resume it. Reconciling at startup keeps the console truthful instead of showing a
 * "paused" run nobody can touch.
 */
export function reconcileAtBoot() {
  const db = getDb();
  const orphanedInterventions = db
    .prepare(`UPDATE interventions SET status = 'resolved', resolved_at = ?, resolution = ? WHERE status = 'pending'`)
    .run(now(), JSON.stringify({ note: 'orphaned: control plane restarted while paused' })).changes;
  const orphanedRuns = db
    .prepare(`UPDATE runs SET status = 'failed', updated_at = ? WHERE status IN ('running', 'paused')`)
    .run(now()).changes;
  return { orphanedRuns, orphanedInterventions };
}

export function listInterventions({ status } = {}) {
  const rows = status
    ? getDb().prepare(`SELECT * FROM interventions WHERE status = ? ORDER BY created_at DESC`).all(status)
    : getDb().prepare(`SELECT * FROM interventions ORDER BY created_at DESC`).all();
  return rows.map((row) => ({
    ...row,
    context: JSON.parse(row.context ?? '{}'),
    resolution: JSON.parse(row.resolution ?? 'null'),
  }));
}
