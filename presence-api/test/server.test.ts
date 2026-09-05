import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BLOCKED_SERVER_REASON_CODES, createPresenceServer, minecraftOfflineUuid, sanitizeBlockedServerRegistry } from '../src/server.js';
const registry = JSON.parse(readFileSync(new URL('../data/recognized-mods.json', import.meta.url), 'utf8'));
const blockedServers = JSON.parse(readFileSync(new URL('../data/blocked-servers.json', import.meta.url), 'utf8'));

const SECRET = 'test-secret-that-is-definitely-longer-than-thirty-two-characters';
const UUID = '39d9ec7970394f039078ad79e84ff976';

function multipart(parts: Array<{ field: string; name: string; type: string; value: string | Buffer }>) {
  const boundary = `ImpulseTest${crypto.randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"; filename="${part.name}"\r\nContent-Type: ${part.type}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, payload: Buffer.concat(chunks) };
}

test('matches Minecraft offline UUID generation', () => {
  assert.equal(minecraftOfflineUuid('Notch'), 'b50ad385829d3141a2167e7d7539ba7f');
});

test('keeps CurseForge verification disabled without an Impulse API key', async () => {
  const app = await createPresenceServer({ secret: SECRET, logger: false });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/mod-verification/curseforge',
    payload: {
      minecraft_version: '1.21.1',
      loader: 'neoforge',
      files: [{ sha512: 'a'.repeat(128), fingerprint: 1234567890 }],
    },
  });
  assert.equal(response.statusCode, 503);
  await app.close();
});

test('proxies CurseForge fingerprints and validates Minecraft and loader compatibility', async () => {
  const calls: Array<{ url: string; headers: HeadersInit; body: string }> = [];
  const app = await createPresenceServer({
    secret: SECRET,
    logger: false,
    curseForgeApiKey: 'impulse-test-key',
    curseForgeFetch: async (input, init) => {
      calls.push({ url: String(input), headers: init?.headers ?? {}, body: String(init?.body ?? '') });
      return new Response(JSON.stringify({
        data: {
          exactMatches: [
            { id: 123, file: { id: 55, modId: 77, fileName: 'good.jar', gameVersions: ['1.21.1', 'NeoForge'] } },
            { id: 456, file: { id: 56, modId: 78, fileName: 'forge.jar', gameVersions: ['1.21.1', 'Forge'] } },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/mod-verification/curseforge',
    payload: {
      minecraft_version: '1.21.1',
      loader: 'neoforge',
      files: [
        { sha512: 'a'.repeat(128), fingerprint: 123 },
        { sha512: 'b'.repeat(128), fingerprint: 456 },
        { sha512: 'c'.repeat(128), fingerprint: 789 },
      ],
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().matches['a'.repeat(128)].status, 'Matched on CurseForge');
  assert.equal(response.json().matches['b'.repeat(128)].status, 'Incompatible CurseForge listing');
  assert.equal(response.json().matches['c'.repeat(128)].status, 'Unverified');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.curseforge.com/v1/fingerprints/432');
  assert.equal((calls[0].headers as Record<string, string>)['x-api-key'], 'impulse-test-key');
  assert.equal((calls[0].headers as Record<string, string>)['User-Agent'], 'PrismLauncher/11.0.3');
  await app.close();
});

test('retries transient CurseForge failures', async () => {
  let calls = 0;
  const app = await createPresenceServer({
    secret: SECRET,
    logger: false,
    curseForgeApiKey: 'impulse-test-key',
    curseForgeFetch: async () => {
      calls++;
      if (calls < 3) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ data: { exactMatches: [] } }), { status: 200 });
    },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/mod-verification/curseforge',
    payload: { minecraft_version: '1.21.1', loader: 'neoforge', files: [{ sha512: 'd'.repeat(128), fingerprint: 42 }] },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(calls, 3);
  await app.close();
});

test('does not retry permanent CurseForge authentication failures', async () => {
  let calls = 0;
  const app = await createPresenceServer({
    secret: SECRET,
    logger: false,
    curseForgeApiKey: 'impulse-test-key',
    curseForgeFetch: async () => {
      calls++;
      return new Response('{}', { status: 401 });
    },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/mod-verification/curseforge',
    payload: { minecraft_version: '1.21.1', loader: 'neoforge', files: [{ sha512: 'e'.repeat(128), fingerprint: 43 }] },
  });
  assert.equal(response.statusCode, 502);
  assert.equal(calls, 1);
  await app.close();
});

test('verifies a challenge and reports ephemeral presence', async () => {
  let clock = 1_000_000;
  const app = await createPresenceServer({
    secret: SECRET,
    logger: false,
    now: () => clock,
    verifyMojang: async (username) => ({ id: UUID, name: username }),
  });

  const challenge = await app.inject({ method: 'POST', url: '/v1/auth/challenge' });
  const challengeBody = challenge.json();
  const verify = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { challenge_id: challengeBody.challenge_id, username: 'Azrty' },
  });
  assert.equal(verify.statusCode, 200);
  const token = verify.json().token;

  const replay = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { challenge_id: challengeBody.challenge_id, username: 'Azrty' },
  });
  assert.equal(replay.statusCode, 400);

  assert.equal((await app.inject({ method: 'POST', url: '/v1/presence/heartbeat', headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
  const query = await app.inject({
    method: 'POST',
    url: '/v1/presence/query',
    headers: { authorization: `Bearer ${token}` },
    payload: { uuids: [UUID] },
  });
  assert.deepEqual(query.json().active, [UUID]);

  clock += 121_000;
  const expired = await app.inject({
    method: 'POST',
    url: '/v1/presence/query',
    headers: { authorization: `Bearer ${token}` },
    payload: { uuids: [UUID] },
  });
  assert.deepEqual(expired.json().active, []);
  await app.close();
});

test('publishes sanitized short-lived music activity without history', async () => {
  let current = 1_000_000;
  const app = await createPresenceServer({
    secret: 'a sufficiently long test secret value',
    logger: false,
    now: () => current,
    verifyMojang: async () => ({ id: UUID, name: 'Azrty' }),
  });
  const challenge = (await app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: {} })).json();
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { challenge_id: challenge.challenge_id, username: 'Azrty' } });
  const token = verified.json().token as string;

  const heartbeat = await app.inject({
    method: 'POST',
    url: '/v1/presence/heartbeat',
    headers: { authorization: `Bearer ${token}` },
    payload: { music: { title: '  A\nSong  ', artist: ' An\tArtist ' } },
  });
  assert.equal(heartbeat.statusCode, 200);
  let query = await app.inject({
    method: 'POST',
    url: '/v1/presence/query',
    headers: { authorization: `Bearer ${token}` },
    payload: { uuids: [UUID] },
  });
  assert.deepEqual(query.json().music, [{ uuid: UUID, title: 'A Song', artist: 'An Artist' }]);

  current += 30_001;
  query = await app.inject({
    method: 'POST',
    url: '/v1/presence/query',
    headers: { authorization: `Bearer ${token}` },
    payload: { uuids: [UUID] },
  });
  assert.deepEqual(query.json().music, []);
  assert.deepEqual(query.json().active, [UUID]);
  await app.close();
});

test('resolves verified premium presence through the standard offline-mode UUID', async () => {
  const app = await createPresenceServer({
    secret: SECRET,
    logger: false,
    verifyMojang: async () => ({ id: UUID, name: 'Azrty' }),
  });
  const challenge = (await app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: {} })).json();
  const verified = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: { challenge_id: challenge.challenge_id, username: 'Azrty' },
  });
  const headers = { authorization: `Bearer ${verified.json().token as string}` };
  await app.inject({
    method: 'POST',
    url: '/v1/presence/heartbeat',
    headers,
    payload: { music: { title: 'Offline Server', artist: 'Premium Player' } },
  });

  const offlineUuid = minecraftOfflineUuid('Azrty');
  const query = await app.inject({
    method: 'POST',
    url: '/v1/presence/query',
    headers,
    payload: { uuids: [offlineUuid] },
  });
  assert.deepEqual(query.json().active, [offlineUuid]);
  assert.deepEqual(query.json().music, [{
    uuid: offlineUuid,
    title: 'Offline Server',
    artist: 'Premium Player',
  }]);
  await app.close();
});

test('rejects invalid music activity and allows explicit clearing', async () => {
  const app = await createPresenceServer({
    secret: 'a sufficiently long test secret value',
    logger: false,
    verifyMojang: async () => ({ id: UUID, name: 'Azrty' }),
  });
  const challenge = (await app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: {} })).json();
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { challenge_id: challenge.challenge_id, username: 'Azrty' } });
  const token = verified.json().token as string;
  const headers = { authorization: `Bearer ${token}` };

  assert.equal((await app.inject({ method: 'POST', url: '/v1/presence/heartbeat', headers, payload: { music: { title: '', artist: 'Artist' } } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/presence/heartbeat', headers, payload: { music: null } })).statusCode, 200);
  const query = await app.inject({ method: 'POST', url: '/v1/presence/query', headers, payload: { uuids: [UUID] } });
  assert.deepEqual(query.json().music, []);
  await app.close();
});

test('stores validated artwork ephemerally and returns it through the authenticated endpoint', async () => {
  const app = await createPresenceServer({
    secret: SECRET,
    logger: false,
    verifyMojang: async () => ({ id: UUID, name: 'Azrty' }),
  });
  const challenge = (await app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: {} })).json();
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { challenge_id: challenge.challenge_id, username: 'Azrty' } });
  const token = verified.json().token as string;
  const headers = { authorization: `Bearer ${token}` };
  const artwork = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64');
  const artworkId = crypto.createHash('sha256').update(artwork).digest('hex');

  const heartbeat = await app.inject({
    method: 'POST',
    url: '/v1/presence/heartbeat',
    headers,
    payload: { music: { title: 'Song', artist: 'Artist', artwork_id: artworkId, artwork_base64: artwork.toString('base64') } },
  });
  assert.equal(heartbeat.statusCode, 200);
  const query = await app.inject({ method: 'POST', url: '/v1/presence/query', headers, payload: { uuids: [UUID] } });
  assert.equal(query.json().music[0].artwork_id, artworkId);
  assert.equal(Object.prototype.hasOwnProperty.call(query.json().music[0], 'artwork_base64'), false);

  const response = await app.inject({ method: 'GET', url: `/v1/presence/artwork/${artworkId}`, headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/jpeg');
  assert.deepEqual(response.rawPayload, artwork);
  await app.close();
});

test('rejects mismatched or malformed artwork', async () => {
  const app = await createPresenceServer({ secret: SECRET, logger: false, verifyMojang: async () => ({ id: UUID, name: 'Azrty' }) });
  const challenge = (await app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: {} })).json();
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { challenge_id: challenge.challenge_id, username: 'Azrty' } });
  const headers = { authorization: `Bearer ${verified.json().token as string}` };
  const response = await app.inject({
    method: 'POST',
    url: '/v1/presence/heartbeat',
    headers,
    payload: { music: { title: 'Song', artist: 'Artist', artwork_id: '0'.repeat(64), artwork_base64: Buffer.from('not an image').toString('base64') } },
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test('rejects invalid authentication and oversized queries', async () => {
  const app = await createPresenceServer({ secret: SECRET, logger: false, verifyMojang: async () => null });
  assert.equal((await app.inject({ method: 'POST', url: '/v1/presence/heartbeat' })).statusCode, 401);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/presence/query',
    headers: { authorization: 'Bearer invalid' },
    payload: { uuids: Array.from({ length: 201 }, () => UUID) },
  });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test('accepts legacy empty form POST requests', async () => {
  const app = await createPresenceServer({ secret: SECRET, logger: false, verifyMojang: async () => null });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/challenge',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: '',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.json().challenge_id, 'string');
  await app.close();
});

test('serves the recognized mod registry with an ETag', async () => {
  const app = await createPresenceServer({ secret: SECRET, logger: false, verifyMojang: async () => null });
  const response = await app.inject({ method: 'GET', url: '/v1/mod-verification/recognized-mods' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), registry);
  assert.match(String(response.headers.etag), /^"[0-9a-f]{64}"$/);
  const cached = await app.inject({ method: 'GET', url: '/v1/mod-verification/recognized-mods', headers: { 'if-none-match': String(response.headers.etag) } });
  assert.equal(cached.statusCode, 304);
  await app.close();
});

test('serves the blocked server registry with an ETag', async () => {
  const app = await createPresenceServer({ secret: SECRET, logger: false });
  const response = await app.inject({ method: 'GET', url: '/v1/security/blocked-servers' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), blockedServers);
  assert.ok(response.headers.etag);
  const cached = await app.inject({ method: 'GET', url: '/v1/security/blocked-servers', headers: { 'if-none-match': String(response.headers.etag) } });
  assert.equal(cached.statusCode, 304);
  await app.close();
});

test('serves launcher availability without HTTP caching and retains the last valid value', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'impulse-launcher-availability-'));
  const file = path.join(directory, 'launcher-availability.json');
  writeFileSync(file, JSON.stringify({ schema_version: 1, isLauncherAvailable: true }));
  const app = await createPresenceServer({ secret: SECRET, logger: false, launcherAvailabilityFile: file });

  const available = await app.inject({ method: 'GET', url: '/v1/launcher/isLauncherAvailable' });
  assert.equal(available.statusCode, 200);
  assert.deepEqual(available.json(), { isLauncherAvailable: true });
  assert.equal(available.headers['cache-control'], 'no-store');

  writeFileSync(file, '{invalid json');
  const retained = await app.inject({ method: 'GET', url: '/v1/launcher/isLauncherAvailable' });
  assert.deepEqual(retained.json(), { isLauncherAvailable: true });

  writeFileSync(file, JSON.stringify({ schema_version: 1, isLauncherAvailable: false }));
  const unavailable = await app.inject({ method: 'GET', url: '/v1/launcher/isLauncherAvailable' });
  assert.deepEqual(unavailable.json(), { isLauncherAvailable: false });
  await app.close();
});

test('stores validated server reports atomically without retaining the source IP', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'impulse-server-reports-'));
  const app = await createPresenceServer({ secret: SECRET, logger: false, reportsDirectory: directory });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/security/server-reports',
    headers: { 'user-agent': 'Impulse-Standalone/test' },
    payload: {
      server_name: 'SMPFun',
      server_address: 'play.example.com:25565',
      server_host: 'play.example.com',
      category: 'malicious_files',
      details: 'The server distributed an unexpected executable mod file.',
      minecraft_version: '1.21.1',
      loader: 'neoforge',
      client: 'standalone',
    },
  });
  assert.equal(response.statusCode, 201);
  assert.match(response.json().report_id, /^[0-9a-f-]{36}$/u);
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  assert.equal(files[0].endsWith('.tmp'), false);
  const stored = JSON.parse(readFileSync(path.join(directory, files[0]), 'utf8'));
  assert.equal(stored.server.host, 'play.example.com');
  assert.equal(stored.category, 'malicious_files');
  assert.match(stored.source_id, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(stored).includes('127.0.0.1'), false);
  await app.close();
});

test('rejects incomplete server reports', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'impulse-server-reports-invalid-'));
  const app = await createPresenceServer({ secret: SECRET, logger: false, reportsDirectory: directory });
  const response = await app.inject({ method: 'POST', url: '/v1/security/server-reports', payload: { category: 'other_security' } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(readdirSync(directory), []);
  await app.close();
});

test('stores anonymous bug reports atomically with optional diagnostics and screenshots', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'impulse-bug-reports-'));
  const app = await createPresenceServer({ secret: SECRET, logger: false, bugReportsDirectory: directory });
  const metadata = {
    schema_version: 1,
    description: 'The standalone selector stopped while it was checking the server.',
    installation_id: crypto.randomUUID(),
    impulse_version: '1.3.0-beta.6', minecraft_version: '1.21.1', loader: 'neoforge',
    loader_version: '21.1.248', java_version: '21', os: 'Test OS', arch: 'arm64',
    server_address: 'play.example.com:25565', diagnostics_included: true,
  };
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const upload = multipart([
    { field: 'metadata', name: 'metadata.json', type: 'application/json', value: JSON.stringify(metadata) },
    { field: 'files', name: 'impulse.log', type: 'text/plain', value: '[INFO] launch failed' },
    { field: 'files', name: '../../escape.png', type: 'image/png', value: png },
  ]);
  const response = await app.inject({
    method: 'POST', url: '/v1/support/bug-reports',
    headers: { 'content-type': `multipart/form-data; boundary=${upload.boundary}`, 'user-agent': 'Impulse-Standalone/test' },
    payload: upload.payload,
  });
  assert.equal(response.statusCode, 201, response.body);
  const folders = readdirSync(directory);
  assert.equal(folders.length, 1);
  assert.equal(folders[0].startsWith('.'), false);
  const report = JSON.parse(readFileSync(path.join(directory, folders[0], 'report.json'), 'utf8'));
  assert.match(report.source_id, /^[0-9a-f]{64}$/u);
  assert.match(report.installation_source_id, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(report).includes(metadata.installation_id), false);
  assert.equal(JSON.stringify(report).includes('127.0.0.1'), false);
  assert.deepEqual(readdirSync(path.join(directory, folders[0], 'attachments')), ['impulse.log']);
  assert.deepEqual(readdirSync(path.join(directory, folders[0], 'screenshots')), ['screenshot-1.png']);
  await app.close();
});

test('rejects diagnostics that were not explicitly included', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'impulse-bug-reports-invalid-'));
  const app = await createPresenceServer({ secret: SECRET, logger: false, bugReportsDirectory: directory });
  const upload = multipart([
    { field: 'metadata', name: 'metadata.json', type: 'application/json', value: JSON.stringify({
      schema_version: 1, description: 'This report has an attachment without diagnostic consent.',
      installation_id: crypto.randomUUID(), impulse_version: '1.3.0', minecraft_version: '1.21.1', loader: 'neoforge',
      diagnostics_included: false,
    }) },
    { field: 'files', name: 'minecraft.log', type: 'text/plain', value: 'not allowed' },
  ]);
  const response = await app.inject({ method: 'POST', url: '/v1/support/bug-reports', headers: { 'content-type': `multipart/form-data; boundary=${upload.boundary}` }, payload: upload.payload });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(readdirSync(directory), []);
  await app.close();
});

test('accepts every blocked-server preset and migrates invalid reasons safely', () => {
  const presets = [...BLOCKED_SERVER_REASON_CODES];
  const sanitized = sanitizeBlockedServerRegistry({
    servers: [
      ...presets.map((reason_code, index) => ({ host: `server-${index}.example.com`, ipv4: [`192.0.2.${index + 1}`], reason_code })),
      { host: 'legacy.example.com', ipv4: ['198.51.100.2'], reason: 'free-form legacy text' },
      { host: 'future.example.com', ipv4: ['203.0.113.5'], reason_code: 'future_reason' },
    ],
  });
  assert.deepEqual(new Set(sanitized.servers.slice(0, presets.length + 2).map((entry) => entry.reason_code)), new Set([...presets, 'policy_violation']));
  assert.equal(sanitized.servers.find((entry) => entry.host === 'legacy.example.com')?.reason_code, 'policy_violation');
  assert.equal(sanitized.servers.find((entry) => entry.host === 'future.example.com')?.reason_code, 'policy_violation');
  assert.equal(JSON.stringify(sanitized).includes('free-form legacy text'), false);
});
