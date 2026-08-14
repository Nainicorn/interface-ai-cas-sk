/**
 * A hand-authored capability, used to exercise replay before the discovery agent exists.
 *
 * This is deliberately NOT in artifacts/ — that directory is reserved for genuine
 * recorded output from a real discovery run, and passing a hand-written file off as a
 * recording would undercut the one claim the submission actually rests on. Its purpose
 * is to prove the replay path is correct independently of the model, so that when the
 * real recording lands there is only one new variable.
 *
 * Every locator below was verified against the live app before being written down —
 * including the ones that were REJECTED. `tr:has-text("Savings") td:nth-child(4)` looks
 * correct and matches three elements, because the page nests the accounts table inside
 * two layout tables that also "contain" that text. Scoping to table[border="1"] is what
 * makes it unique. That is the entire argument for ranked candidates in one example.
 */

import { z } from 'zod';

/** Typed inputs. The same Zod definition produces the artifact's JSON Schema. */
const InputSchema = z.object({
  member_id: z
    .string()
    .regex(/^\d+$/, 'Member ID is numeric')
    .describe('The member identifier to look up, e.g. "10001"'),
});

/** Typed outputs — what a calling agent gets back. */
const OutputSchema = z.object({
  account_number: z.string().describe('Savings account number, e.g. SAV-10001-01'),
  savings_balance: z.string().describe('Savings balance as a decimal string, e.g. 18320.40'),
});

/**
 * The accounts-table row for the savings account.
 *
 * Both outputs are read from this one row with different extraction patterns, which is
 * cheaper and more robust than locating two separate cells by column index.
 */
/**
 * Not every member holds a savings account, and when they don't, the row simply isn't
 * on the page — the locator resolves to nothing. That is an ANSWER, not a fault, so it
 * is declared here rather than being left to surface as a locator failure.
 */
const noSavingsAccount = {
  code: 'NO_SAVINGS_ACCOUNT',
  detect: { type: 'text_absent', value: 'Savings', timeout_ms: 1000 },
  message: 'This member record exists but holds no savings account. A valid result, not a failure.',
};

const savingsRow = {
  description: 'Accounts table row for the Savings account',
  candidates: [
    {
      kind: 'css',
      value: 'table[border="1"] tr:has-text("Savings")',
      confidence: 0.6,
      note:
        'Scoped to the bordered accounts table. Unscoped, this matches 3 elements because ' +
        'the layout nests tables. Breaks if the member holds two Savings accounts.',
    },
    {
      kind: 'css',
      value: 'table[border="1"] tr:has-text("SAV-")',
      confidence: 0.5,
      note: 'Fallback keyed on the account-number prefix rather than the type label.',
    },
  ],
};

/** Build the capability. A function so tests can vary id/version without cloning JSON. */
export function buildLookupSavingsBalance({ id = 'lookup-savings-balance', version = 1 } = {}) {
  return {
    schema_version: 1,
    id,
    name: 'Look up a member savings balance',
    version,
    status: 'approved',
    description:
      'Given a member ID, sign in to the core banking admin, open that member record, ' +
      'and return their savings account number and balance.',

    target: {
      app_id: 'mock-bank',
      entry_route: '/login',
      tenant_overrides: [],
    },

    input_schema: z.toJSONSchema(InputSchema),
    output_schema: z.toJSONSchema(OutputSchema),

    // Read-only throughout: no step creates or modifies a record.
    risk_level: 'safe',

    steps: [
      {
        index: 0,
        intent: 'Start from the sign-in screen so the flow is reproducible from any state',
        action: 'navigate',
        url: '/login',
        expected_outcome: { type: 'url_contains', value: '/login', timeout_ms: 5000 },
        business_outcomes: [],
        risk: 'safe',
      },
      {
        index: 1,
        intent: 'Enter the operator username',
        action: 'type',
        locator: {
          description: 'Username field on the sign-in form',
          candidates: [
            {
              kind: 'placeholder',
              value: 'Username',
              confidence: 0.75,
              note: 'Placeholder supplies the accessible name. Tenant rebranding may change it.',
            },
            {
              kind: 'css',
              value: 'input[name="username"]',
              confidence: 0.7,
              note: 'Form field name. Less semantic, but the server depends on it, so it rarely moves.',
            },
          ],
        },
        // Credentials arrive by env var NAME. The secret is never stored in the artifact,
        // which is also what lets this recording run against a different tenant.
        value_from_env: 'MOCK_BANK_USERNAME',
        expected_outcome: { type: 'url_contains', value: '/login', timeout_ms: 3000 },
        business_outcomes: [],
        risk: 'safe',
      },
      {
        index: 2,
        intent: 'Enter the operator password',
        action: 'type',
        locator: {
          description: 'Password field on the sign-in form',
          candidates: [
            { kind: 'placeholder', value: 'Password', confidence: 0.75 },
            { kind: 'css', value: 'input[name="password"]', confidence: 0.7 },
          ],
        },
        value_from_env: 'MOCK_BANK_PASSWORD',
        expected_outcome: { type: 'url_contains', value: '/login', timeout_ms: 3000 },
        business_outcomes: [],
        risk: 'safe',
      },
      {
        index: 3,
        intent: 'Submit the sign-in form and land on member search',
        action: 'click',
        locator: {
          description: 'Sign In submit button',
          candidates: [
            { kind: 'role', role: 'button', value: 'Sign In', confidence: 0.9, note: 'Real <button> with visible text.' },
            { kind: 'css', value: 'form[action^="/login"] button', confidence: 0.6 },
          ],
        },
        expected_outcome: { type: 'url_contains', value: '/search', timeout_ms: 8000 },
        business_outcomes: [
          {
            code: 'INVALID_CREDENTIALS',
            detect: { type: 'text_visible', value: 'Invalid username or password', timeout_ms: 1500 },
            message: 'The configured operator credentials were rejected by the target application.',
          },
        ],
        risk: 'safe',
      },
      {
        index: 4,
        intent: 'Enter the member ID supplied by the caller',
        action: 'type',
        locator: {
          description: 'Member ID field on the search form',
          candidates: [
            { kind: 'placeholder', value: 'Member ID', confidence: 0.75 },
            { kind: 'css', value: 'input[name="memberId"]', confidence: 0.7 },
          ],
        },
        value_from: 'member_id',
        expected_outcome: { type: 'url_contains', value: '/search', timeout_ms: 3000 },
        business_outcomes: [],
        risk: 'safe',
      },
      {
        index: 5,
        intent: 'Run the search and open the member record',
        action: 'click',
        locator: {
          description: 'Search submit button',
          candidates: [
            { kind: 'role', role: 'button', value: 'Search', confidence: 0.9 },
            { kind: 'css', value: 'form[action="/search"] button', confidence: 0.6 },
          ],
        },
        expected_outcome: { type: 'url_contains', value: '/member/', timeout_ms: 8000 },
        // THE important line in this artifact. A missing member is an answer the caller
        // asked for, so it is declared here as a business outcome and checked before the
        // checkpoint — otherwise it would surface as a spurious HARD_FAILURE.
        business_outcomes: [
          {
            code: 'MEMBER_NOT_FOUND',
            detect: { type: 'text_visible', value: 'No member found with ID', timeout_ms: 2000 },
            message: 'No member exists with the supplied ID. This is a valid result, not a failure.',
          },
        ],
        risk: 'safe',
      },
      {
        index: 6,
        intent: 'Read the savings account number from the accounts table',
        action: 'read',
        locator: savingsRow,
        extract_as: 'account_number',
        extract_pattern: '(SAV-\\d+-\\d+)',
        expected_outcome: { type: 'element_exists', value: 'table[border="1"]', timeout_ms: 5000 },
        business_outcomes: [noSavingsAccount],
        risk: 'safe',
      },
      {
        index: 7,
        intent: 'Read the savings balance from the same row',
        action: 'read',
        locator: savingsRow,
        extract_as: 'savings_balance',
        extract_pattern: '\\$([\\d,]+\\.\\d{2})',
        expected_outcome: { type: 'element_exists', value: 'table[border="1"]', timeout_ms: 5000 },
        business_outcomes: [noSavingsAccount],
        risk: 'safe',
      },
    ],

    success_checkpoint: { type: 'url_contains', value: '/member/', timeout_ms: 5000 },

    created_from: {
      run_id: 'handwritten-fixture',
      model: null,
      recorded_at: '2026-01-01T00:00:00.000Z',
    },

    redaction_policy: {
      redact_fields: ['MOCK_BANK_USERNAME', 'MOCK_BANK_PASSWORD', 'member_id'],
    },

    confidence: { runs: 0, successes: 0, last_outcome: null, updated_at: null },
  };
}
