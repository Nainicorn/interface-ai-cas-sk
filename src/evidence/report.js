/**
 * Run reports: project a run's evidence folder (transcript.jsonl, screenshots,
 * result.json) into something an HTTP route can serve and the report page can render.
 * Pure file reading — no Express, no engine imports.
 *
 * Hands off to: api/runs.js.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE_DIR } from './logger.js';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCREENSHOT = /^\d{3}-[A-Za-z0-9._-]+\.png$/;
const DROP_KEYS = new Set(['ariaTree', 'visibleText']);
const TEXT_CAP = 500;
const MAX_EVENTS = 2000;

/** Run ids become path segments — reject anything that could traverse. */
export const isSafeRunId = (id) => RUN_ID.test(String(id ?? ''));

/** Screenshot names follow logger.js's NNN-label.png scheme; nothing else is served. */
export const isSafeScreenshotName = (name) => SCREENSHOT.test(String(name ?? ''));

/** Trim the size bombs out of a transcript event, keep everything else verbatim. */
function slim(value) {
  if (typeof value === 'string') {
    return value.length > TEXT_CAP ? `${value.slice(0, TEXT_CAP)}… [+${value.length - TEXT_CAP} chars]` : value;
  }
  if (Array.isArray(value)) return value.map(slim);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (DROP_KEYS.has(key)) continue;
      out[key] = slim(inner);
    }
    return out;
  }
  return value;
}

/** Sorted evidence screenshots for a run. */
export function listScreenshots(runId, { baseDir = EVIDENCE_DIR } = {}) {
  const dir = path.join(baseDir, runId);
  if (!isSafeRunId(runId) || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => SCREENSHOT.test(f)).sort();
}

/**
 * Everything the report page needs for one run:
 * { result, screenshots, events } — result.json parsed (null when the run is still
 * writing), screenshot filenames, and the transcript with observations slimmed to
 * url/title/screenshot and long strings truncated. Null when no evidence exists.
 */
export function buildRunReport(runId, { baseDir = EVIDENCE_DIR } = {}) {
  const dir = path.join(baseDir, runId);
  if (!isSafeRunId(runId) || !existsSync(dir)) return null;

  let result = null;
  const resultPath = path.join(dir, 'result.json');
  if (existsSync(resultPath)) {
    try {
      result = JSON.parse(readFileSync(resultPath, 'utf8'));
    } catch {
      /* mid-write; the poller will catch it next round */
    }
  }

  const events = [];
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  if (existsSync(transcriptPath)) {
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(0, MAX_EVENTS)) {
      try {
        events.push(slim(JSON.parse(line)));
      } catch {
        /* torn tail line during a live run */
      }
    }
  }

  return { result, screenshots: listScreenshots(runId, { baseDir }), events };
}
