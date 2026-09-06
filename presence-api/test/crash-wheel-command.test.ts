import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'manage-crash-wheel.mjs');

test('Crash Wheel command manages usernames case-insensitively and rejects invalid names', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'impulse-crash-wheel-'));
  const file = path.join(directory, 'crash-wheel.json');
  writeFileSync(file, '{"schema_version":1,"active_until":"2099-01-01T00:00:00.000Z","usernames":[]}\n');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, IMPULSE_CRASH_WHEEL_FILE: file },
  });

  assert.equal(run('add', 'PlayerOne').status, 0);
  assert.notEqual(run('add', 'playerone').status, 0);
  assert.equal(run('add', 'Second_Player').status, 0);
  assert.match(run('list').stdout, /PlayerOne/u);
  assert.notEqual(run('add', 'bad name').status, 0);
  assert.equal(run('remove', 'PLAYERONE').status, 0);
  const registry = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(registry.usernames, ['Second_Player']);
  assert.equal(registry.active_until, '2099-01-01T00:00:00.000Z');
});
