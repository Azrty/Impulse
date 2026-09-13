import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./generate-game-compat-key.mjs', import.meta.url));

test('keygen writes a usable private key once without printing it', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'impulse-game-compat-key-'));
  try {
    const destination = path.join(directory, 'private', 'key.pem');
    const first = spawnSync(process.execPath, [script, destination], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const pem = readFileSync(destination, 'utf8');
    const publicDer = crypto.createPublicKey(crypto.createPrivateKey(pem)).export({ format: 'der', type: 'spki' });
    assert.match(first.stdout, new RegExp(publicDer.toString('base64url')));
    assert.doesNotMatch(first.stdout, /BEGIN PRIVATE KEY/u);
    if (process.platform !== 'win32') assert.equal(statSync(destination).mode & 0o777, 0o600);

    const second = spawnSync(process.execPath, [script, destination], { encoding: 'utf8' });
    assert.notEqual(second.status, 0);
    assert.equal(readFileSync(destination, 'utf8'), pem);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
