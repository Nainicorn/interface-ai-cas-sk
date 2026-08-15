/**
 * Guardrails. No browser, no network.
 *
 * The allowlist tests matter more than they look: checkAllowed() is the single gate
 * every action primitive passes through, so these are the tests standing behind the
 * claim that the agent, replay, and a human operator are all equally constrained.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PolicyViolation, checkAllowed, getTarget, loadTargets, routeOf } from '../src/policy/allowlist.js';
import { checkUnattendedAllowed, classifyRisk } from '../src/policy/risk.js';
import { isSensitive, redact, redactObject, shapeOf } from '../src/policy/redact.js';
import { buildLookupSavingsBalance } from './fixtures/lookup-savings-balance.js';

// A representative target, inline: targets.json ships empty (apps are registered at
// runtime), so the gate is tested against the shape rather than the file.
const target = {
  app_id: 'mock-bank',
  display_name: 'Corevance Core Banking Admin (local fixture)',
  base_url: 'http://localhost:3001',
  entry_route: '/login',
  credentials: { username_env: 'MOCK_BANK_USERNAME', password_env: 'MOCK_BANK_PASSWORD' },
  allowlist: {
    route_prefixes: ['/login', '/search', '/member'],
    action_types: ['navigate', 'click', 'type', 'read', 'wait_for'],
  },
  risky_route_patterns: ['/open-account'],
  redact_fields: ['password', 'username', 'memberId', 'member_id', 'accountNumber', 'initialDeposit'],
  viewport: { width: 1024, height: 768 },
};

describe('target configuration', () => {
  it('drops underscore-prefixed documentation keys', () => {
    const targets = loadTargets({ reload: true });
    assert.ok(Object.keys(targets).every((key) => !key.startsWith('_')));
  });

  it('refuses an unconfigured app_id rather than guessing', () => {
    assert.throws(() => getTarget('some-bank-we-never-approved'), PolicyViolation);
  });
});

describe('allowlist', () => {
  it('permits an approved action on an approved route', () => {
    assert.equal(checkAllowed({ target, action: 'click', url: '/member/10001' }), true);
  });

  it('blocks a route outside the allowlist', () => {
    // /reset exists on the target but was never approved for automation.
    assert.throws(
      () => checkAllowed({ target, action: 'navigate', url: '/reset' }),
      /outside the allowlist/,
    );
  });

  it('blocks an action type that is not permitted for this app', () => {
    assert.throws(
      () => checkAllowed({ target, action: 'download', url: '/search' }),
      /not permitted/,
    );
  });

  it('blocks off-origin navigation — this is the free-text URL guard', () => {
    assert.throws(
      () => checkAllowed({ target, action: 'navigate', url: 'https://evil.example/login' }),
      /Off-origin navigation blocked/,
    );
  });

  it('carries structured detail for the evidence log', () => {
    try {
      checkAllowed({ target, action: 'navigate', url: '/reset' });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof PolicyViolation);
      assert.equal(err.detail.route, '/reset');
      assert.ok(Array.isArray(err.detail.allowed_prefixes));
    }
  });

  it('normalises a route from an absolute URL', () => {
    assert.equal(routeOf(target, 'http://localhost:3001/member/10001'), '/member/10001');
  });
});

describe('risk classification', () => {
  it('treats reads and navigation as inherently safe', () => {
    assert.equal(classifyRisk({ target, action: 'read', url: '/member/10001' }).level, 'safe');
    assert.equal(classifyRisk({ target, action: 'navigate', url: '/member/10001' }).level, 'safe');
  });

  it('treats a click on a non-mutating route as safe', () => {
    assert.equal(classifyRisk({ target, action: 'click', url: '/search' }).level, 'safe');
  });

  it('treats a click on a declared mutating route as risky', () => {
    const verdict = classifyRisk({ target, action: 'click', url: '/member/10001/open-account' });
    assert.equal(verdict.level, 'risky');
  });

  it('defaults to risky when the route cannot be resolved', () => {
    const verdict = classifyRisk({ target, action: 'click', url: 'https://elsewhere.example/x' });
    assert.equal(verdict.level, 'risky');
  });
});

describe('approval gate', () => {
  it('lets a safe capability replay unattended', () => {
    const capability = buildLookupSavingsBalance();
    assert.equal(checkUnattendedAllowed(capability).allowed, true);
  });

  it('blocks a risky draft capability', () => {
    const capability = { ...buildLookupSavingsBalance(), risk_level: 'risky', status: 'draft' };
    assert.equal(checkUnattendedAllowed(capability).allowed, false);
  });

  it('allows a risky capability once approved', () => {
    const capability = { ...buildLookupSavingsBalance(), risk_level: 'risky', status: 'approved' };
    assert.equal(checkUnattendedAllowed(capability).allowed, true);
  });
});

describe('redaction', () => {
  const policy = { redact_fields: target.redact_fields };

  it('always redacts a password, whatever the config says', () => {
    assert.equal(isSensitive('password', {}), true);
    assert.equal(redact('hunter2', 'password', {}).redacted, true);
  });

  it('redacts fields named in the target config', () => {
    assert.equal(redact('10001', 'memberId', policy).redacted, true);
  });

  it('matches field names irrespective of case and separators', () => {
    assert.equal(isSensitive('MEMBER_ID', policy), true);
    assert.equal(isSensitive('member-id', policy), true);
  });

  it('matches env-var field names by suffix — the replay path logs those', () => {
    // Regression: MOCK_BANK_PASSWORD normalized to "mockbankpassword" and never
    // EQUALED "password", so replay transcripts logged the typed value in the clear.
    assert.equal(isSensitive('MOCK_BANK_PASSWORD', {}), true);
    assert.equal(isSensitive('ACME_CRM_USERNAME', { redact_fields: ['username'] }), true);
    assert.equal(redact('demo-password', 'MOCK_BANK_PASSWORD', {}).redacted, true);
  });

  it('keeps enough shape to debug without keeping the value', () => {
    assert.equal(shapeOf('10001'), '<numeric-string:5>');
    assert.equal(shapeOf(''), '<empty-string>');
    assert.equal(shapeOf('a@b.co'), '<email>');
    assert.equal(redact('10001', 'memberId', policy).value, '<numeric-string:5>');
  });

  it('passes non-sensitive values through untouched', () => {
    assert.deepEqual(redact('Savings', 'accountType', policy), { value: 'Savings', redacted: false });
  });

  it('recurses so a secret cannot hide one level down', () => {
    const out = redactObject({ outer: { password: 'hunter2', keep: 'yes' } }, policy);
    assert.equal(out.outer.password, '<string:7>');
    assert.equal(out.outer.keep, 'yes');
  });
});
