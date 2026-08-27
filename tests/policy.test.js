/**
 * The safety layer, at its boundaries.
 *
 * Pure functions, so these run in milliseconds with no browser and no network — which is
 * the point: the guarantees the write-up makes about safety should be cheap to re-check
 * on every change.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PolicyViolation, checkAllowed, routeOf } from '../src/policy/allowlist.js';
import { isSensitive, maskValues, redact, redactObject, shapeOf } from '../src/policy/redact.js';
import { checkAgentInvocable, checkUnattendedAllowed, classifyRisk } from '../src/policy/risk.js';

const target = {
  app_id: 'demo',
  base_url: 'https://demo.example.com',
  allowlist: { route_prefixes: ['/accounts'], action_types: ['navigate', 'click', 'read'] },
  risky_route_patterns: ['/transfer'],
  redact_fields: [],
};

describe('allowlist', () => {
  test('permits an allowed action on an allowed route', () => {
    assert.equal(checkAllowed({ target, action: 'click', url: `${target.base_url}/accounts/1` }), true);
  });

  test('refuses an action type that is not permitted', () => {
    assert.throws(
      () => checkAllowed({ target, action: 'type', url: `${target.base_url}/accounts` }),
      PolicyViolation,
    );
  });

  test('refuses a route outside the prefixes', () => {
    assert.throws(() => checkAllowed({ target, action: 'click', url: `${target.base_url}/admin` }), PolicyViolation);
  });

  test('the origin is not widenable by any prefix — the hard edge', () => {
    const wide = { ...target, allowlist: { route_prefixes: ['/'], action_types: ['navigate'] } };
    assert.throws(() => checkAllowed({ target: wide, action: 'navigate', url: 'https://evil.example.com/' }), PolicyViolation);
    assert.throws(() => routeOf(wide, 'https://demo.example.com.evil.com/'), PolicyViolation);
  });

  test('a relative path resolves against the app, and is still prefix-checked', () => {
    // Anything parseable relative to base_url resolves rather than throwing, so the
    // prefix check — not the URL parser — is what refuses it.
    assert.equal(routeOf(target, '/accounts/7'), '/accounts/7');
    assert.throws(() => checkAllowed({ target, action: 'click', url: '/somewhere-else' }), PolicyViolation);
  });
});

describe('redaction', () => {
  test('always-sensitive names are caught however they are spelled', () => {
    for (const name of ['password', 'passwd', 'api_key', 'apiKey', 'secret', 'token', 'ssn', 'pin']) {
      assert.equal(isSensitive(name), true, `${name} should be sensitive`);
    }
  });

  test('suffix match catches derived env names — the leak this rule exists for', () => {
    assert.equal(isSensitive('HEROKU_APP_PASSWORD'), true);
    assert.equal(isSensitive('MY_APP_API_KEY'), true);
    assert.equal(redact('SuperSecret!', 'HEROKU_APP_PASSWORD').value, '<string:12>');
  });

  test('a configured field is redacted; an unrelated one is not', () => {
    const policy = { redact_fields: ['account_number'] };
    assert.equal(redact('12345678', 'account_number', policy).redacted, true);
    assert.equal(redact('Widgets Ltd', 'company', policy).redacted, false);
  });

  test('shapes describe without disclosing', () => {
    assert.equal(shapeOf('12345'), '<numeric-string:5>');
    assert.equal(shapeOf('a@b.co'), '<email>');
    assert.equal(shapeOf(''), '<empty-string>');
  });

  test('a secret cannot hide one level down in a structured log line', () => {
    const out = redactObject({ user: { name: 'ada', password: 'hunter2' } });
    assert.equal(out.user.name, 'ada');
    assert.equal(out.user.password, '<string:7>');
  });
});

describe('risk and approval', () => {
  test('reads and navigation cannot mutate, whatever the route', () => {
    assert.equal(classifyRisk({ target, action: 'read', url: `${target.base_url}/transfer` }).level, 'safe');
  });

  test('a declared risky route makes a mutating action risky', () => {
    assert.equal(classifyRisk({ target, action: 'click', url: `${target.base_url}/transfer` }).level, 'risky');
  });

  test('an unresolvable URL defaults to risky, never to safe', () => {
    assert.equal(classifyRisk({ target, action: 'click', url: 'https://elsewhere.example/' }).level, 'risky');
  });

  test('the approval gate truth table', () => {
    const cases = [
      // risk_level, status,     may replay, agent may call
      ['safe', 'draft', true, false],
      ['safe', 'approved', true, true],
      ['risky', 'draft', false, false],
      ['risky', 'approved', true, true],
    ];
    for (const [risk_level, status, replayable, invocable] of cases) {
      const cap = { id: 'c', risk_level, status };
      assert.equal(checkUnattendedAllowed(cap).allowed, replayable, `${risk_level}/${status} replay`);
      assert.equal(checkAgentInvocable(cap).allowed, invocable, `${risk_level}/${status} agent`);
    }
  });

  test('a draft is invisible to an agent even when it is safe', () => {
    assert.equal(checkAgentInvocable({ id: 'c', risk_level: 'safe', status: 'draft' }).allowed, false);
  });
});

/**
 * Masking by VALUE, the counterpart to redacting by NAME above.
 *
 * A browser publishes a filled input's value in the accessibility tree, so once the agent
 * types a password it is sitting in every later snapshot of that page — text nobody
 * explicitly logged. agent/discovery.js runs each observation through this before the
 * transcript and before the model sees it, which is what keeps "the model never sees a
 * password" true after the model has typed one.
 */
describe('masking captured page text', () => {
  test('a typed credential is replaced by its shape wherever it appears', () => {
    const tree = '- textbox "Password": hunter2\n- text: signed in as hunter2';
    const masked = maskValues(tree, ['hunter2']);
    assert.ok(!masked.includes('hunter2'), 'the credential survived masking');
    assert.equal(masked.split('<string:7>').length - 1, 2, 'both occurrences should be masked');
  });

  test('shape, not deletion — an empty field stays distinguishable from a filled one', () => {
    assert.equal(maskValues('value: abcd', ['abcd']), 'value: <string:4>');
  });

  test('a credential containing regex syntax is still masked', () => {
    // Split/join rather than a regex, precisely so this cannot blow up or under-match.
    const masked = maskValues('pw is a.*b[c]$ here', ['a.*b[c]$']);
    assert.ok(!masked.includes('a.*b[c]$'));
  });

  test('no secrets, or empty text, is a no-op rather than a throw', () => {
    assert.equal(maskValues('nothing to hide', []), 'nothing to hide');
    assert.equal(maskValues('', ['x']), '');
    assert.equal(maskValues(null, ['x']), '');
  });

  test('an empty-string secret cannot blank the whole page', () => {
    // ''.split('') would explode a string into every character; the guard matters.
    assert.equal(maskValues('untouched', ['']), 'untouched');
  });
});
