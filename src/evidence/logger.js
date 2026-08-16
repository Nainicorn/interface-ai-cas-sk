/**
 * The evidence trail: one folder per run, readable standalone with no code.
 *
 * A run folder contains transcript.jsonl (the blow-by-blow, one JSON line per event),
 * numbered screenshots, and result.json (the summary). One format serves all three
 * actors — the LLM discovery loop, deterministic replay, and the human operator —
 * because an evidence trail that needed three readers would prove nothing.
 *
 * Redaction happens BEFORE lines reach this file (engine/actions.js redacts at the
 * point of logging). This module writes what it is given and never sees a secret.
 *
 * Hands off to: agent/discovery.js, engine/replay.js, agent/escalation.js.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_DIR = path.resolve(here, '../../evidence');

/**
 * A run id IS its path under evidence/: "some_app/discovery/2026-08-15_142233".
 *
 * Grouping by app and kind is what lets a reviewer open one app's folder and see its
 * whole history, and it means the id needs no lookup to locate the run on disk.
 */
export function newRunId(appId, kind = 'run') {
  const iso = new Date().toISOString(); // 2026-08-15T14:22:33.123Z
  const stamp = `${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/g, '')}`;
  return `${appId}/${kind}/${stamp}`;
}

export class RunLogger {
  /**
   * @param {string} runId folder name under evidence/
   * @param {{baseDir?: string}} [options]
   */
  constructor(runId, { baseDir = EVIDENCE_DIR } = {}) {
    this.runId = runId;
    this.dir = path.join(baseDir, runId);
    mkdirSync(this.dir, { recursive: true });
    this.transcriptPath = path.join(this.dir, 'transcript.jsonl');
    this.screenshotCount = 0;
  }

  /** Append one event line. Synchronous on purpose: evidence must survive a crash. */
  #append(line) {
    appendFileSync(this.transcriptPath, `${JSON.stringify(line)}\n`, 'utf8');
  }

  /**
   * Record one action. This is the shape engine/actions.js emits — {actor, action,
   * detail, result, ...} — shared verbatim across llm / replay / human callers.
   */
  logStep(entry) {
    this.#append({ ts: new Date().toISOString(), type: 'action', ...entry });
  }

  /** Record anything that is not an action: model turns, observations, escalations. */
  logEvent(type, data) {
    this.#append({ ts: new Date().toISOString(), type, ...data });
  }

  /**
   * Save a PNG and return its filename, so transcript lines can reference it.
   * @param {string|Buffer|null} image base64 string or raw buffer
   * @param {string} [label] short slug worked into the filename
   */
  saveScreenshot(image, label = 'state') {
    if (!image) return null;
    const buffer = typeof image === 'string' ? Buffer.from(image, 'base64') : image;
    const name = `${String(this.screenshotCount++).padStart(3, '0')}-${label}.png`;
    writeFileSync(path.join(this.dir, name), buffer);
    return name;
  }

  /** Write an arbitrary named JSON document into the run folder (e.g. intervention.json). */
  saveJson(filename, data) {
    const file = path.join(this.dir, filename);
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return file;
  }

  /** The run summary a reviewer opens first. */
  saveResult(result) {
    return this.saveJson('result.json', result);
  }
}
