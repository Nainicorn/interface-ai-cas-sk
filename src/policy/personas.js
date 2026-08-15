/**
 * Persona credentials: multiple named logins per target, values kept OUT of the repo.
 *
 * data/creds/<app_id>.json (gitignored) holds { personas: { name: { username, password,
 * note? } } }. At run start the chosen persona's values are injected into the env var
 * NAMES the target declares, so the model prompt, the artifact (value_from_env), replay,
 * and redaction keep their env-name indirection and never see this file.
 *
 * Hands off to: agent/discovery.js + api/run-replay.js (applyPersona before launch),
 * api/targets.js (listPersonas for the UI, savePersonas at registration).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CREDS_DIR = path.resolve(here, '../../data/creds');

const APP_ID = /^[a-z][a-z0-9-]*$/;
const PERSONA_NAME = /^[a-zA-Z0-9_-]+$/;

const PersonasFileSchema = z.object({
  personas: z.record(
    z.string().regex(PERSONA_NAME),
    z.object({
      username: z.string().min(1),
      password: z.string().min(1),
      note: z.string().optional(),
    }),
  ),
});

/** Path to a target's creds file. app_id is re-validated: it becomes a filename. */
function credsPath(appId, credsDir) {
  if (!APP_ID.test(appId)) {
    const err = new Error(`Not a valid app_id: "${appId}"`);
    err.status = 400;
    throw err;
  }
  return path.join(credsDir, `${appId}.json`);
}

/** Parsed personas file for a target, or null when none exists. */
export function loadPersonasFile(appId, { credsDir = CREDS_DIR } = {}) {
  const file = credsPath(appId, credsDir);
  if (!existsSync(file)) return null;
  return PersonasFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** Persona names + notes for the UI. Never values. */
export function listPersonas(appId, opts = {}) {
  const file = loadPersonasFile(appId, opts);
  if (!file) return [];
  return Object.entries(file.personas).map(([name, p]) => ({ name, note: p.note ?? null }));
}

/**
 * Resolve which login a run uses.
 * Named persona must exist (400 listing known NAMES otherwise). No name given: the
 * first declared persona if a creds file exists, else null — the legacy path where
 * values come straight from the environment (.env).
 */
export function resolvePersona(target, personaName, opts = {}) {
  const file = loadPersonasFile(target.app_id, opts);
  if (!file) {
    if (!personaName) return null;
    const err = new Error(`No personas configured for "${target.app_id}".`);
    err.status = 400;
    throw err;
  }
  const names = Object.keys(file.personas);
  const name = personaName ?? names[0];
  const persona = file.personas[name];
  if (!persona) {
    const err = new Error(`Unknown persona "${personaName}". Known: ${names.join(', ')}`);
    err.status = 400;
    throw err;
  }
  return { name, username: persona.username, password: persona.password };
}

/**
 * Inject the chosen persona's values into the env var names the target declares,
 * immediately before browser launch. Returns the applied persona NAME, or null when
 * the run falls back to plain env values. One run at a time per process — documented
 * single-operator limitation.
 */
export function applyPersona(target, personaName, opts = {}) {
  const resolved = resolvePersona(target, personaName, opts);
  if (!resolved) return null;
  const { username_env: userEnv, password_env: passEnv } = target.credentials ?? {};
  if (!userEnv || !passEnv) {
    const err = new Error(`Target "${target.app_id}" declares no credential env names.`);
    err.status = 400;
    throw err;
  }
  process.env[userEnv] = resolved.username;
  process.env[passEnv] = resolved.password;
  return resolved.name;
}

/** Write a target's personas file (0600 — values live only here, outside the repo). */
export function savePersonas(appId, personas, { credsDir = CREDS_DIR } = {}) {
  const file = credsPath(appId, credsDir);
  PersonasFileSchema.parse({ personas });
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ personas }, null, 2)}\n`, { mode: 0o600 });
  return Object.keys(personas);
}
