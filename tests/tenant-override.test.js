/**
 * Cross-tenant reuse, at its two pure boundaries: patching a recording for a tenant
 * (applyTenantOverride) and suggesting a canonical route pattern (suggestRoutePattern).
 * Both are plain data transforms — no browser needed to prove either is correct, the
 * same reasoning tests/policy.test.js gives for testing safety logic this way.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyTenantOverride } from '../src/engine/replay.js';
import { suggestCapabilityPatterns, suggestRoutePattern } from '../src/schema/canonicalize.js';

const baseLocator = {
  description: 'Add Element button',
  candidates: [{ kind: 'role', role: 'button', value: 'Add Element', confidence: 0.9 }],
};

const capability = () => ({
  id: 'add-remove-elements-cycle',
  version: 1,
  target: {
    app_id: 'internet',
    entry_route: '/',
    tenant_overrides: [
      {
        tenant_id: 'acme-credit-union',
        base_url: 'https://acme.example.com',
        step_overrides: [
          {
            index: 1,
            locator: { description: 'Create Element button', candidates: [{ kind: 'role', role: 'button', value: 'Create Element', confidence: 0.9 }] },
          },
        ],
        note: 'Acme relabels the button; everything else is identical.',
      },
    ],
  },
  steps: [
    { index: 0, action: 'navigate', url: '/add_remove_elements/' },
    { index: 1, action: 'click', locator: baseLocator },
    { index: 2, action: 'click', locator: { description: 'Delete button', candidates: [{ kind: 'role', role: 'button', value: 'Delete', confidence: 0.9 }] } },
  ],
});

describe('cross-tenant reuse', () => {
  test('no tenant id leaves the recording untouched', () => {
    const { capability: patched, baseUrl } = applyTenantOverride(capability(), null);
    assert.deepEqual(patched, capability());
    assert.equal(baseUrl, null);
  });

  test('an unknown tenant id leaves the recording untouched, not an error', () => {
    const { capability: patched, baseUrl } = applyTenantOverride(capability(), 'nobody-registered');
    assert.deepEqual(patched, capability());
    assert.equal(baseUrl, null);
  });

  test('a matching tenant patches only the named step, nothing else', () => {
    const original = capability();
    const { capability: patched, baseUrl } = applyTenantOverride(original, 'acme-credit-union');
    assert.equal(baseUrl, 'https://acme.example.com');
    assert.equal(patched.steps[1].locator.candidates[0].value, 'Create Element');
    // Steps 0 and 2 are untouched — reference-equal to the ORIGINAL step objects, not just
    // deep-equal, proving nothing was rebuilt that did not need to be.
    assert.equal(patched.steps[0], original.steps[0]);
    assert.equal(patched.steps[2], original.steps[2]);
    assert.equal(patched.steps[2].locator.candidates[0].value, 'Delete');
  });

  test('the base recording keeps its own id and version through a patch', () => {
    const { capability: patched } = applyTenantOverride(capability(), 'acme-credit-union');
    assert.equal(patched.id, 'add-remove-elements-cycle');
    assert.equal(patched.version, 1);
  });
});

describe('route canonicalization', () => {
  test('a numeric id segment becomes a placeholder', () => {
    assert.equal(suggestRoutePattern('/members/12345'), '/members/:id');
  });

  test('a route with no id-shaped segment is left exactly as it is', () => {
    assert.equal(suggestRoutePattern('/add_remove_elements/'), '/add_remove_elements/');
  });

  test('a long hex token is treated as an id too', () => {
    assert.equal(suggestRoutePattern('/sessions/8f14e45fceea167a'), '/sessions/:id');
  });

  test('capability-level suggestions skip routes that are already canonical', () => {
    const cap = {
      target: { entry_route: '/' },
      steps: [
        { index: 0, action: 'navigate', url: '/members/12345' },
        { index: 1, action: 'navigate', url: '/dashboard' },
        { index: 2, action: 'click' }, // no url — must not blow up
      ],
    };
    const suggestions = suggestCapabilityPatterns(cap);
    assert.deepEqual(suggestions, [{ source: 'step 0', route: '/members/12345', pattern: '/members/:id' }]);
  });
});
