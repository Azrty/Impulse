import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createPresenceServer, minecraftOfflineUuid } from '../src/server.js';

const SECRET = 'test-secret-that-is-definitely-longer-than-thirty-two-characters';
const UUID = '39d9ec7970394f039078ad79e84ff976';

test('matches Minecraft offline UUID generation', () => {
  assert.equal(minecraftOfflineUuid('Notch'), 'b50ad385829d3141a2167e7d7539ba7f');
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
