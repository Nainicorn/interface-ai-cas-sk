/**
 * Runtime target registration + personas. No browser, no network — the writer and the
 * resolver work against scratch files, and the assertions replicate the exact shape
 * rules tests/boundaries.test.js enforces on the shipped config.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { applyPersona, listPersonas, resolvePersona, savePersonas } from '../src/policy/personas.js';
import { deleteTarget, deriveAppId, deriveEnvNames, registerTarget, updateTarget } from '../src/policy/register-target.js';

const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-targets-'));
  const configPath = path.join(dir, 'targets.json');
  writeFileSync(configPath, JSON.stringify({ _README: ['scratch'] }, null, 2));
  return { configPath, credsDir: path.join(dir, 'creds') };
};

const PAYLOAD = {
  display_name: 'Acme Banking Sandbox',
  base_url: 'https://sandbox.acme.example',
  entry_route: '/login',
  goal: 'Look up a member and read their savings balance',
  allowlist: { route_prefixes: ['/'] },
  personas: {
    teller: { username: 'teller07', password: 'hunter2-teller', note: 'read-only' },
    admin: { username: 'admin01', password: 'hunter2-admin' },
  },
};

describe('registration', () => {
  it('derives ids and env names the boundary shape requires', () => {
    assert.equal(deriveAppId('Acme Banking Sandbox'), 'acme-banking-sandbox');
    assert.deepEqual(deriveEnvNames('acme-crm'), {
      username_env: 'ACME_CRM_USERNAME',
      password_env: 'ACME_CRM_PASSWORD',
    });
  });

  it('writes a target block that passes the boundary-test shape rules', () => {
    const { configPath, credsDir } = scratch();
    const { app_id } = registerTarget(PAYLOAD, { configPath, credsDir });

    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const target = raw[app_id];
    assert.ok(target.base_url, 'needs a base_url');
    assert.ok(target.allowlist?.route_prefixes?.length, 'needs allowed route prefixes');
    assert.ok(target.allowlist?.action_types?.length, 'needs allowed action types');
    assert.ok(/_ENV|_env/.test(JSON.stringify(target.credentials ?? {})), 'credentials must be env names');
    assert.equal(raw._README[0], 'scratch', 'documentation keys survive the write');
  });

  it('never writes a persona value into targets.json', () => {
    const { configPath, credsDir } = scratch();
    registerTarget(PAYLOAD, { configPath, credsDir });
    const written = readFileSync(configPath, 'utf8');
    assert.ok(!written.includes('hunter2-teller') && !written.includes('teller07'), 'secret leaked into config');
  });

  it('unions the derived env names into redact_fields — defense in depth', () => {
    const { configPath, credsDir } = scratch();
    const { target } = registerTarget(PAYLOAD, { configPath, credsDir });
    assert.ok(target.redact_fields.includes('ACME_BANKING_SANDBOX_PASSWORD'));
    assert.ok(target.redact_fields.includes('password'));
  });

  it('rejects a payload carrying literal credentials', () => {
    const { configPath, credsDir } = scratch();
    assert.throws(
      () => registerTarget({ ...PAYLOAD, credentials: { username: 'x', password: 'y' } }, { configPath, credsDir }),
      (err) => err.status === 400,
    );
  });

  it('rejects the shapes the boundary test would refuse', () => {
    const { configPath, credsDir } = scratch();
    const bad = (patch) => {
      assert.throws(
        () => registerTarget({ ...PAYLOAD, ...patch }, { configPath, credsDir }),
        (err) => err.status === 400,
        `should reject ${JSON.stringify(patch)}`,
      );
    };
    bad({ base_url: 'not-a-url' });
    bad({ base_url: 'ftp://files.example' });
    bad({ allowlist: { route_prefixes: [] } });
    bad({ entry_route: 'login' });
  });

  it('refuses a duplicate app_id with a 409', () => {
    const { configPath, credsDir } = scratch();
    registerTarget(PAYLOAD, { configPath, credsDir });
    assert.throws(
      () => registerTarget(PAYLOAD, { configPath, credsDir }),
      (err) => err.status === 409,
    );
  });
});

describe('personas', () => {
  const setup = () => {
    const { credsDir } = scratch();
    savePersonas('acme', PAYLOAD.personas, { credsDir });
    const target = {
      app_id: 'acme',
      credentials: { username_env: 'ACME_TEST_USERNAME', password_env: 'ACME_TEST_PASSWORD' },
    };
    return { credsDir, target };
  };

  it('lists names and notes, never values', () => {
    const { credsDir } = setup();
    const listed = listPersonas('acme', { credsDir });
    assert.deepEqual(listed.map((p) => p.name).sort(), ['admin', 'teller']);
    assert.ok(!JSON.stringify(listed).includes('hunter2'), 'a value escaped the listing');
  });

  it('resolves by name, defaults to the first, 400s the unknown', () => {
    const { credsDir, target } = setup();
    assert.equal(resolvePersona(target, 'admin', { credsDir }).username, 'admin01');
    assert.equal(resolvePersona(target, undefined, { credsDir }).name, 'teller');
    assert.throws(() => resolvePersona(target, 'nobody', { credsDir }), (err) => err.status === 400);
  });

  it('injects values into the declared env names, and only those', () => {
    const { credsDir, target } = setup();
    try {
      const applied = applyPersona(target, 'admin', { credsDir });
      assert.equal(applied, 'admin');
      assert.equal(process.env.ACME_TEST_USERNAME, 'admin01');
      assert.equal(process.env.ACME_TEST_PASSWORD, 'hunter2-admin');
    } finally {
      delete process.env.ACME_TEST_USERNAME;
      delete process.env.ACME_TEST_PASSWORD;
    }
  });

  it('falls back to plain env values when no creds file exists', () => {
    const { credsDir } = scratch();
    const target = { app_id: 'legacy-app', credentials: { username_env: 'X_USERNAME', password_env: 'X_PASSWORD' } };
    assert.equal(resolvePersona(target, undefined, { credsDir }), null);
    assert.equal(applyPersona(target, undefined, { credsDir }), null);
  });
});

describe('update & delete', () => {
  it('update keeps a stored password when the submitted one is empty', () => {
    const { configPath, credsDir } = scratch();
    registerTarget(PAYLOAD, { configPath, credsDir });
    const { personas } = updateTarget(
      'acme-banking-sandbox',
      { ...PAYLOAD, personas: { teller: { username: 'teller07', password: '' } } },
      { configPath, credsDir },
    );
    assert.deepEqual(personas, ['teller']);
    const target = { app_id: 'acme-banking-sandbox', credentials: deriveEnvNames('acme-banking-sandbox') };
    assert.equal(resolvePersona(target, 'teller', { credsDir }).password, 'hunter2-teller');
  });

  it('update refuses a NEW login with no password', () => {
    const { configPath, credsDir } = scratch();
    registerTarget(PAYLOAD, { configPath, credsDir });
    assert.throws(
      () =>
        updateTarget(
          'acme-banking-sandbox',
          { ...PAYLOAD, personas: { fresh: { username: 'x', password: '' } } },
          { configPath, credsDir },
        ),
      (err) => err.status === 400,
    );
  });

  it('saved goals land on the target; delete removes target and creds', () => {
    const { configPath, credsDir } = scratch();
    registerTarget({ ...PAYLOAD, goals: { 'balance check': 'Read the savings balance' } }, { configPath, credsDir });
    const written = JSON.parse(readFileSync(configPath, 'utf8'))['acme-banking-sandbox'];
    assert.equal(written.goals['balance check'], 'Read the savings balance');

    deleteTarget('acme-banking-sandbox', { configPath, credsDir });
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8'))['acme-banking-sandbox'], undefined);
    assert.deepEqual(listPersonas('acme-banking-sandbox', { credsDir }), []);
    assert.throws(() => deleteTarget('acme-banking-sandbox', { configPath, credsDir }), (err) => err.status === 404);
  });
});
