import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createPresenceServer, sanitizeStandaloneMigration } from '../src/server.js';

const SECRET = 'test-secret-that-is-definitely-longer-than-thirty-two-characters';

test('validates and serves the reloadable standalone migration campaign', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'impulse-migration-api-'));
  const file = path.join(directory, 'standalone-migration.json');
  writeFileSync(file, '{"schema_version":1,"migrate":false,"migration_date":"2026-09-19","revision":1}\n');
  const app = await createPresenceServer({ secret: SECRET, logger: false, standaloneMigrationFile: file });
  try {
    const first = await app.inject({ method: 'GET', url: '/v1/standalone/migration' });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().migrate, false);
    assert.match(String(first.headers['cache-control']), /no-store/u);
    const cached = await app.inject({ method: 'GET', url: '/v1/standalone/migration', headers: { 'if-none-match': String(first.headers.etag) } });
    assert.equal(cached.statusCode, 304);
    writeFileSync(file, '{"schema_version":1,"migrate":true,"migration_date":"2026-09-20","revision":2}\n');
    const second = await app.inject({ method: 'GET', url: '/v1/standalone/migration' });
    assert.deepEqual(second.json(), { schema_version: 1, migrate: true, migration_date: '2026-09-20', revision: 2 });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects invalid standalone migration dates and revisions', () => {
  assert.equal(sanitizeStandaloneMigration({ schema_version: 1, migrate: false, migration_date: '2026-09-19', revision: 1 }).revision, 1);
  assert.throws(() => sanitizeStandaloneMigration({ schema_version: 1, migrate: true, migration_date: '2026-02-30', revision: 2 }));
  assert.throws(() => sanitizeStandaloneMigration({ schema_version: 1, migrate: true, migration_date: '2026-09-19', revision: 0 }));
});

test('migration command updates atomically and increments revision', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'impulse-migration-command-'));
  const file = path.join(directory, 'standalone-migration.json');
  writeFileSync(file, '{"schema_version":1,"migrate":false,"migration_date":"2026-09-19","revision":4}\n');
  try {
    const result = spawnSync(process.execPath, ['scripts/manage-standalone-migration.mjs', 'true', '2026-09-20'], {
      cwd: process.cwd(), env: { ...process.env, IMPULSE_STANDALONE_MIGRATION_FILE: file, IMPULSE_MIGRATION_SKIP_TESTS: '1' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schema_version: 1, migrate: true, migration_date: '2026-09-20', revision: 5 });
    const invalid = spawnSync(process.execPath, ['scripts/manage-standalone-migration.mjs', 'false', '2026-02-30'], {
      cwd: process.cwd(), env: { ...process.env, IMPULSE_STANDALONE_MIGRATION_FILE: file, IMPULSE_MIGRATION_SKIP_TESTS: '1' }, encoding: 'utf8',
    });
    assert.notEqual(invalid.status, 0);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).revision, 5);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
