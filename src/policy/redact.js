/**
 * Redaction for regulated financial data.
 *
 * The rule: logs and artifacts record field NAMES and value SHAPES, never values.
 * Knowing that a 5-digit numeric string was typed into the member-ID field is enough to
 * debug a replay; knowing it was 10001 is a PII record we have no reason to keep.
 *
 * Applied at the point of logging rather than the point of use, so the live browser
 * still receives the real value while nothing durable ever does.
 *
 * Hands off to: engine/actions.js, evidence/logger.js.
 */

/** Field names always treated as sensitive, whatever an app's config says. */
const ALWAYS_REDACT = ['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'ssn', 'pin'];

const norm = (name) => String(name).toLowerCase().replace(/[_-]/g, '');

/**
 * Whether a field name is sensitive for this policy.
 *
 * Suffix match, not equality: the replay path logs env-var names like MY_APP_PASSWORD,
 * which must hit the "password" rule. Over-matching redacts too much — the safe
 * direction to err in.
 */
export function isSensitive(fieldName, policy = {}) {
  if (!fieldName) return false;
  const target = norm(fieldName);
  const configured = policy.redact_fields ?? [];
  return [...ALWAYS_REDACT, ...configured].some((candidate) => {
    const c = norm(candidate);
    return target === c || target.endsWith(c);
  });
}

/**
 * Describe a value without disclosing it.
 * Shape is enough to spot the common replay bugs — an empty string, a truncated input,
 * a number where text was expected — without keeping the data itself.
 */
export function shapeOf(value) {
  if (value === null) return '<null>';
  if (value === undefined) return '<undefined>';
  if (typeof value === 'boolean') return '<boolean>';
  if (typeof value === 'number') return `<number:${String(value).length}d>`;
  if (Array.isArray(value)) return `<array:${value.length}>`;
  if (typeof value === 'object') return `<object:${Object.keys(value).length}k>`;

  const str = String(value);
  if (str.length === 0) return '<empty-string>';
  if (/^\d+$/.test(str)) return `<numeric-string:${str.length}>`;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(str)) return '<email>';
  return `<string:${str.length}>`;
}

/**
 * Redact one value if its field name is sensitive; otherwise pass it through.
 * @returns {{ value: unknown, redacted: boolean }}
 */
export function redact(value, fieldName, policy = {}) {
  if (!isSensitive(fieldName, policy)) return { value, redacted: false };
  return { value: shapeOf(value), redacted: true };
}

/**
 * Redact a whole object by key. Recurses into nested objects so a sensitive field
 * cannot hide one level down in a structured log line.
 */
export function redactObject(input, policy = {}) {
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((item) => redactObject(item, policy));

  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (isSensitive(key, policy)) {
      output[key] = shapeOf(value);
    } else if (value !== null && typeof value === 'object') {
      output[key] = redactObject(value, policy);
    } else {
      output[key] = value;
    }
  }
  return output;
}

/**
 * Replace known secret VALUES wherever they appear in captured page text.
 *
 * The rules above redact by field NAME, at the moment a value is logged. This one is for
 * the other direction: a browser publishes a filled input's value in the accessibility
 * tree, so once a password has been typed it is sitting in every later snapshot of that
 * page — text nobody explicitly logged, but which flows into the evidence transcript, the
 * drift fingerprint that gets written into the artifact, and the observation the model is
 * shown on its next turn.
 *
 * Without this, "the model never sees a password" is only true until it types one.
 *
 * Split/join rather than a regex: a credential is arbitrary text and may contain
 * characters a regex would treat as syntax.
 *
 * @param {string} text captured page text
 * @param {string[]} values secret values to mask
 */
export function maskValues(text, values = []) {
  if (!text || values.length === 0) return text ?? '';
  return values.reduce((acc, value) => (value ? acc.split(value).join(shapeOf(value)) : acc), text);
}

/** The resolved values behind a target's declared credential env vars. */
export function credentialValues(target) {
  return Object.values(target?.credentials ?? {})
    .map((envName) => process.env[envName])
    .filter(Boolean);
}
