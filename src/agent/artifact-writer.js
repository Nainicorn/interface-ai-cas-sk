/**
 * Turns a validated emission from the model into a saved, versioned capability.
 *
 * The model gives simple typed input/output lists, not raw JSON Schema — this file
 * builds the schema from them, so every capability stays inside the subset
 * schema/validate-params.js can check.
 *
 * Also catches what that validator can't (e.g. a step using an undeclared parameter)
 * and returns readable errors so the model can fix its emission and retry.
 *
 * Called only by agent/discovery.js; saves via schema/store.js.
 */

import { safeParseCapability } from '../schema/capability.js';
import { nextVersion, saveCapabilityToRun } from '../schema/store.js';

/** Build the flat input_schema replay's parameter validator understands. */
function buildInputSchema(inputs) {
  const properties = {};
  const required = [];
  for (const input of inputs) {
    properties[input.name] = {
      type: input.type,
      description: input.description,
      ...(input.pattern ? { pattern: input.pattern } : {}),
    };
    if (input.required) required.push(input.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Outputs are extracted from rendered pages, so every output is a string. */
function buildOutputSchema(outputs) {
  const properties = {};
  for (const output of outputs) {
    properties[output.name] = { type: 'string', description: output.description };
  }
  return { type: 'object', properties, required: outputs.map((o) => o.name), additionalProperties: false };
}

/**
 * Referential checks between the step list and the declared contract.
 * @returns {string[]} human-readable problems; empty when coherent
 */
function crossCheck(emission, target) {
  const problems = [];
  const inputNames = new Set(emission.inputs.map((i) => i.name));
  const outputNames = new Set(emission.outputs.map((o) => o.name));
  const credentialEnvNames = new Set(Object.values(target.credentials ?? {}));
  const extracted = new Set();

  for (const step of emission.steps) {
    const at = `step ${step.index} (${step.action})`;

    if (step.action === 'navigate' && !step.url) problems.push(`${at}: navigate needs a url`);
    if (['click', 'type', 'read'].includes(step.action) && !step.locator) {
      problems.push(`${at}: ${step.action} needs a locator`);
    }

    if (step.action === 'type') {
      const sources = ['value_from', 'value_from_env', 'value_literal'].filter((k) => step[k] !== undefined);
      if (sources.length !== 1) {
        problems.push(`${at}: needs exactly one of value_from / value_from_env / value_literal, got ${sources.length}`);
      }
      if (step.value_from !== undefined && !inputNames.has(step.value_from)) {
        problems.push(`${at}: value_from "${step.value_from}" is not a declared input`);
      }
      if (step.value_from_env !== undefined && !credentialEnvNames.has(step.value_from_env)) {
        problems.push(
          `${at}: value_from_env "${step.value_from_env}" is not a credential this target declares ` +
            `(known: ${[...credentialEnvNames].join(', ')})`,
        );
      }
    }

    if (step.extract_as !== undefined) {
      if (!outputNames.has(step.extract_as)) {
        problems.push(`${at}: extract_as "${step.extract_as}" is not a declared output`);
      }
      extracted.add(step.extract_as);
    }
  }

  for (const name of outputNames) {
    if (!extracted.has(name)) problems.push(`output "${name}" is declared but no step extracts it`);
  }

  const stepSaysRisky = emission.steps.some((s) => s.risk === 'risky');
  if (stepSaysRisky && emission.risk_level !== 'risky') {
    problems.push('a step is marked risky, so risk_level must be "risky"');
  }

  return problems;
}

/**
 * Assemble, validate, and persist a capability from an emission.
 *
 * New recordings are ALWAYS status "draft" — promotion to "approved" is a human act,
 * never something the recorder grants itself. A safe draft may still replay unattended;
 * a risky draft may not.
 *
 * @param {object} args
 * @param {object} args.emission validated EmissionSchema payload from the model
 * @param {object} args.target   resolved target config
 * @param {string} args.runId    discovery run this recording came from
 * @param {string} args.model    model id that performed the discovery
 * @returns {Promise<{ok: true, capability: object, path: string} | {ok: false, problems: string[]}>}
 */
export async function writeCapability({ emission, target, runId, model }) {
  const problems = crossCheck(emission, target);
  if (problems.length > 0) return { ok: false, problems };

  const candidate = {
    schema_version: 1,
    id: emission.id,
    name: emission.name,
    version: nextVersion(emission.id),
    status: 'draft',
    description: emission.description,

    target: {
      app_id: target.app_id,
      entry_route: target.entry_route,
      tenant_overrides: [],
    },

    input_schema: buildInputSchema(emission.inputs),
    output_schema: buildOutputSchema(emission.outputs),

    risk_level: emission.risk_level,
    steps: emission.steps,
    success_checkpoint: emission.success_checkpoint,

    created_from: { run_id: runId, model, recorded_at: new Date().toISOString() },

    // Union of the target's sensitive fields and its credential env var names, so a
    // future log line about any of them records shape, never value.
    redaction_policy: {
      redact_fields: [
        ...new Set([...(target.redact_fields ?? []), ...Object.values(target.credentials ?? {})]),
      ],
    },

    confidence: { runs: 0, successes: 0, last_outcome: null, updated_at: null },
  };

  const parsed = safeParseCapability(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }

  // The recording lands in the run folder that produced it, as goal.json.
  const { path, capability } = saveCapabilityToRun(runId, parsed.data);
  return { ok: true, capability, path };
}
