import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BLOCKED_SERVER_REASON_CODES } from '../src/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'manage-blocked-server.mjs');

function run(file: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, IMPULSE_BLOCKED_SERVERS_FILE: file, IMPULSE_SKIP_TESTS: '1' },
  });
}

test('server block command accepts every preset and rejects free-form reasons', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'impulse-blocked-servers-'));
  const file = path.join(directory, 'blocked-servers.json');
  writeFileSync(file, '{"schema_version":1,"servers":[]}\n');
  let index = 1;
  for (const code of BLOCKED_SERVER_REASON_CODES) {
    const result = run(file, [`192.0.2.${index++}`, code]);
    assert.equal(result.status, 0, result.stderr);
  }
  const registry = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(new Set(registry.servers.map((entry: { reason_code: string }) => entry.reason_code)), BLOCKED_SERVER_REASON_CODES);
  const before = readFileSync(file, 'utf8');
  const invalid = run(file, ['198.51.100.10', 'custom free-form reason']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Reason codes:/u);
  assert.equal(readFileSync(file, 'utf8'), before);
});
