import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('../scripts/manage-launcher-availability.mjs', import.meta.url);

test('launcher availability command enables, reports, and disables the launcher', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'impulse-launcher-command-'));
  const file = path.join(directory, 'launcher-availability.json');
  const env = { ...process.env, IMPULSE_LAUNCHER_AVAILABILITY_FILE: file };
  const run = (command: string) => spawnSync(process.execPath, [script.pathname, command], { env, encoding: 'utf8' });

  assert.equal(run('enable').status, 0);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).isLauncherAvailable, true);
  const status = run('status');
  assert.equal(status.status, 0);
  assert.match(status.stdout, /available/u);
  assert.equal(run('disable').status, 0);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).isLauncherAvailable, false);
});
