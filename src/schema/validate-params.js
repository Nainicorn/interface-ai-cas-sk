/**
 * Minimal JSON Schema validation for replay input parameters.
 *
 * Why not a full JSON Schema library: the schemas being validated are not arbitrary.
 * They are produced by z.toJSONSchema() at record time from a deliberately narrow Zod
 * subset — a flat object of scalars with `required` and `additionalProperties: false`.
 * Pulling in a general validator to check a shape we generate ourselves would be a
 * dependency doing 5% of its job.
 *
 * The tradeoff is explicit: this handles the subset the recorder emits and REFUSES
 * anything outside it rather than passing it silently, so an unexpected schema fails
 * loudly at the boundary instead of being waved through unchecked.
 *
 * Hands off to: engine/replay.js.
 */

const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/** Raised when supplied parameters do not satisfy a capability's input_schema. */
export class ParameterValidationError extends Error {
  constructor(errors) {
    super(`Invalid parameters: ${errors.join('; ')}`);
    this.name = 'ParameterValidationError';
    this.errors = errors;
  }
}

function checkScalar(name, spec, value, errors) {
  const expected = spec.type;

  if (!SUPPORTED_TYPES.has(expected)) {
    errors.push(`"${name}": schema type "${expected}" is not supported by this validator`);
    return;
  }
  if (expected === 'string' && typeof value !== 'string') {
    errors.push(`"${name}" must be a string, received ${typeof value}`);
    return;
  }
  if ((expected === 'number' || expected === 'integer') && typeof value !== 'number') {
    errors.push(`"${name}" must be a number, received ${typeof value}`);
    return;
  }
  if (expected === 'integer' && !Number.isInteger(value)) {
    errors.push(`"${name}" must be an integer`);
    return;
  }
  if (expected === 'boolean' && typeof value !== 'boolean') {
    errors.push(`"${name}" must be a boolean, received ${typeof value}`);
    return;
  }

  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
    errors.push(`"${name}" must be one of: ${spec.enum.join(', ')}`);
  }
  if (typeof spec.pattern === 'string' && !new RegExp(spec.pattern).test(String(value))) {
    errors.push(`"${name}" does not match required pattern ${spec.pattern}`);
  }
}

/**
 * Validate params against a capability's input_schema.
 * @returns {object} the validated params (unchanged; this does not coerce)
 * @throws {ParameterValidationError}
 */
export function validateParams(schema, params) {
  const errors = [];
  const input = params ?? {};

  if (!schema || schema.type !== 'object') {
    throw new ParameterValidationError(['input_schema must describe an object']);
  }

  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const name of required) {
    if (input[name] === undefined || input[name] === null) {
      errors.push(`"${name}" is required`);
    }
  }

  for (const [name, value] of Object.entries(input)) {
    const spec = properties[name];
    if (!spec) {
      if (schema.additionalProperties === false) {
        errors.push(`"${name}" is not an accepted parameter`);
      }
      continue;
    }
    if (value === undefined || value === null) continue;
    checkScalar(name, spec, value, errors);
  }

  if (errors.length > 0) throw new ParameterValidationError(errors);
  return input;
}
