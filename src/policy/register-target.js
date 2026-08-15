/**
 * Runtime target registration — "point it at your own app" as a form, not a config edit.
 *
 * Validates the payload, derives credential env-var NAMES from the app id, writes the
 * target block to config/targets.json (never a secret — the writer re-asserts the exact
 * shape tests/boundaries.test.js enforces and refuses to write otherwise), saves persona
 * values to the gitignored creds file, and reloads the target cache.
 *
 * Hands off to: api/targets.js (the POST route), policy/personas.js.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ACTION_TYPES } from '../schema/enums.js';
import { CONFIG_PATH, loadTargets } from './allowlist.js';
import { savePersonas } from './personas.js';

const APP_ID = /^[a-z][a-z0-9-]*$/;

const httpUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be a valid http(s) URL');

const routePrefix = z.string().regex(/^\//, 'routes start with "/"');

/**
 * The registration contract. strict(): unknown keys are rejected — in particular a
 * literal `credentials` object, because credentials in targets.json are derived env
 * NAMES and secrets go to the personas file, never here.
 */
export const RegistrationSchema = z
  .object({
    app_id: z.string().regex(APP_ID).optional(),
    display_name: z.string().trim().min(1),
    base_url: httpUrl,
    entry_route: routePrefix.default('/'),
    goal: z.string().trim().optional(),
    allowlist: z
      .object({
        route_prefixes: z.array(routePrefix).min(1).default(['/']),
        action_types: z.array(z.enum(ACTION_TYPES)).min(1).default([...ACTION_TYPES]),
      })
      .default({ route_prefixes: ['/'], action_types: [...ACTION_TYPES] }),
    risky_route_patterns: z.array(z.string()).default([]),
    redact_fields: z.array(z.string()).default([]),
    viewport: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .default({ width: 1024, height: 768 }),
    personas: z
      .record(
        z.string().regex(/^[a-zA-Z0-9_-]+$/),
        z.object({ username: z.string().min(1), password: z.string().min(1), note: z.string().optional() }),
      )
      .default({}),
  })
  .strict();

/** "Acme Banking Sandbox" → "acme-banking-sandbox". Exported for tests. */
export function deriveAppId(displayName) {
  const slug = String(displayName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!APP_ID.test(slug)) {
    const err = new Error(`Cannot derive an app id from "${displayName}".`);
    err.status = 400;
    throw err;
  }
  return slug;
}

/** "acme-crm" → { username_env: "ACME_CRM_USERNAME", password_env: "ACME_CRM_PASSWORD" }. */
export function deriveEnvNames(appId) {
  const prefix = appId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return { username_env: `${prefix}_USERNAME`, password_env: `${prefix}_PASSWORD` };
}

/**
 * The same predicate tests/boundaries.test.js applies to every shipped target.
 * Running it here means the writer structurally cannot produce a config the suite
 * would reject.
 */
function assertBoundaryShape(appId, target) {
  const ok =
    Boolean(target.base_url) &&
    target.allowlist?.route_prefixes?.length > 0 &&
    target.allowlist?.action_types?.length > 0 &&
    (/_ENV|_env/.test(JSON.stringify(target.credentials ?? {})) ||
      JSON.stringify(target.credentials ?? {}) === '{}');
  if (!ok) {
    throw new Error(`Refusing to write "${appId}": composed target fails the boundary shape.`);
  }
}

/**
 * Register a target at runtime. Returns { app_id, target, personas: [names] } — never
 * persona values. err.status: 400 validation, 409 duplicate.
 */
export function registerTarget(payload, { configPath = CONFIG_PATH, credsDir } = {}) {
  const parsed = RegistrationSchema.safeParse(payload);
  if (!parsed.success) {
    const err = new Error('Invalid registration');
    err.status = 400;
    err.detail = { problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`) };
    throw err;
  }
  const input = parsed.data;
  const appId = input.app_id ?? deriveAppId(input.display_name);

  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  if (raw[appId]) {
    const err = new Error(`Target "${appId}" already exists.`);
    err.status = 409;
    throw err;
  }

  const credentials = deriveEnvNames(appId);
  const target = {
    display_name: input.display_name,
    base_url: input.base_url.replace(/\/+$/, ''),
    entry_route: input.entry_route,
    ...(input.goal ? { goal: input.goal } : {}),
    credentials,
    allowlist: input.allowlist,
    risky_route_patterns: input.risky_route_patterns,
    // Suffix-matched at log time; the derived env names are the exact-match belt.
    redact_fields: [
      ...new Set([...input.redact_fields, 'username', 'password', credentials.username_env, credentials.password_env]),
    ],
    viewport: input.viewport,
  };
  assertBoundaryShape(appId, target);

  raw[appId] = target;
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);

  const personaNames = Object.keys(input.personas).length
    ? savePersonas(appId, input.personas, credsDir ? { credsDir } : {})
    : [];

  if (configPath === CONFIG_PATH) loadTargets({ reload: true });

  return { app_id: appId, target, personas: personaNames };
}
