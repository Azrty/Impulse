import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

const CHALLENGE_TTL_MS = 90_000;
const PRESENCE_TTL_MS = 120_000;
const MUSIC_TTL_MS = 30_000;
const TOKEN_TTL_SECONDS = 12 * 60 * 60;
const MAX_QUERY_UUIDS = 200;
const MAX_MUSIC_FIELD_LENGTH = 128;
const MAX_ARTWORK_BYTES = 24 * 1024;
const MAX_ARTWORK_CACHE_BYTES = 8 * 1024 * 1024;

type Challenge = {
  serverId: string;
  expiresAt: number;
  used: boolean;
};

type TokenPayload = {
  sub: string;
  offline?: string;
  exp: number;
  iat: number;
  jti: string;
};

type RateBucket = { startedAt: number; count: number };
type MusicActivity = { title: string; artist: string; artworkId?: string; expiresAt: number };
type PresenceEntry = { expiresAt: number; music?: MusicActivity };
type ArtworkEntry = { bytes: Buffer; contentType: 'image/jpeg' | 'image/png'; expiresAt: number };

export type MojangProfile = { id: string; name: string };
export type MojangVerifier = (username: string, serverId: string) => Promise<MojangProfile | null>;

export type PresenceServerOptions = {
  secret: string;
  logger?: boolean;
  now?: () => number;
  verifyMojang?: MojangVerifier;
};

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function normalizeUuid(value: string): string | null {
  const compact = value.replaceAll('-', '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(compact) ? compact : null;
}

export function minecraftOfflineUuid(username: string): string {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('hex');
}

function sanitizeMusicField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/gu, ' ').trim();
  if (!cleaned || [...cleaned].length > MAX_MUSIC_FIELD_LENGTH) return null;
  return cleaned;
}

function normalizeArtworkId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function decodeArtwork(value: unknown, expectedId: string): { bytes: Buffer; contentType: 'image/jpeg' | 'image/png' } | null {
  if (typeof value !== 'string' || value.length > 36_000) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_ARTWORK_BYTES || bytes.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) return null;
  const actualId = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualId !== expectedId) return null;
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!jpeg && !png) return null;
  return { bytes, contentType: jpeg ? 'image/jpeg' : 'image/png' };
}

function signToken(payload: TokenPayload, secret: string): string {
  const encoded = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyToken(token: string, secret: string, nowSeconds: number): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(parts[1], 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as TokenPayload;
    const subject = normalizeUuid(payload.sub);
    const offline = payload.offline === undefined ? undefined : normalizeUuid(payload.offline);
    if (!subject || (payload.offline !== undefined && !offline) || payload.exp <= nowSeconds) return null;
    return { ...payload, sub: subject, ...(offline ? { offline } : {}) };
  } catch {
    return null;
  }
}

async function defaultMojangVerifier(username: string, serverId: string): Promise<MojangProfile | null> {
  const url = new URL('https://sessionserver.mojang.com/session/minecraft/hasJoined');
  url.searchParams.set('username', username);
  url.searchParams.set('serverId', serverId);
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Mojang session server returned HTTP ${response.status}`);
  const body = await response.json() as Partial<MojangProfile>;
  const id = typeof body.id === 'string' ? normalizeUuid(body.id) : null;
  return id && typeof body.name === 'string' ? { id, name: body.name } : null;
}

export async function createPresenceServer(options: PresenceServerOptions): Promise<FastifyInstance> {
  if (options.secret.length < 32) throw new Error('PRESENCE_JWT_SECRET must contain at least 32 characters.');
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 64 * 1024 });
  const now = options.now ?? Date.now;
  const verifyMojang = options.verifyMojang ?? defaultMojangVerifier;
  const challenges = new Map<string, Challenge>();
  const presence = new Map<string, PresenceEntry>();
  const presenceAliases = new Map<string, string>();
  const artwork = new Map<string, ArtworkEntry>();
  const tokenRates = new Map<string, RateBucket>();

  // Older Impulse clients sent bodyless POST requests through HttpURLConnection,
  // which labels them as form data. Accept only an empty form for compatibility.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    if (String(body).trim().length > 0) {
      done(new Error('Form request bodies are not supported.'));
      return;
    }
    done(null, {});
  });

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });

  function consumeTokenRate(header: string | undefined): TokenPayload | false | null {
    if (!header?.startsWith('Bearer ')) return null;
    const rawToken = header.slice(7).trim();
    const payload = verifyToken(rawToken, options.secret, Math.floor(now() / 1000));
    if (!payload) return null;
    const key = crypto.createHash('sha256').update(rawToken).digest('hex');
    const current = now();
    const bucket = tokenRates.get(key);
    if (!bucket || current - bucket.startedAt >= 60_000) {
      tokenRates.set(key, { startedAt: current, count: 1 });
      return payload;
    }
    if (bucket.count >= 40) return false;
    bucket.count += 1;
    return payload;
  }

  function cleanup(): void {
    const current = now();
    for (const [id, challenge] of challenges) {
      if (challenge.used || challenge.expiresAt <= current) challenges.delete(id);
    }
    for (const [uuid, entry] of presence) {
      if (entry.expiresAt <= current) presence.delete(uuid);
      else if (entry.music && entry.music.expiresAt <= current) delete entry.music;
    }
    for (const [alias, source] of presenceAliases) {
      if (!presence.has(source)) presenceAliases.delete(alias);
    }
    for (const [id, entry] of artwork) {
      if (entry.expiresAt <= current) artwork.delete(id);
    }
    let artworkBytes = [...artwork.values()].reduce((total, entry) => total + entry.bytes.length, 0);
    for (const [id, entry] of artwork) {
      if (artworkBytes <= MAX_ARTWORK_CACHE_BYTES) break;
      artwork.delete(id);
      artworkBytes -= entry.bytes.length;
    }
    for (const [key, bucket] of tokenRates) {
      if (current - bucket.startedAt >= 60_000) tokenRates.delete(key);
    }
  }

  const cleanupTimer = setInterval(cleanup, 30_000);
  cleanupTimer.unref();
  app.addHook('onClose', async () => clearInterval(cleanupTimer));

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/v1/auth/challenge', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => {
    cleanup();
    const challengeId = crypto.randomUUID();
    const serverId = crypto.randomBytes(20).toString('hex');
    challenges.set(challengeId, { serverId, expiresAt: now() + CHALLENGE_TTL_MS, used: false });
    return { challenge_id: challengeId, server_id: serverId, expires_in: 90 };
  });

  app.post<{ Body: { challenge_id?: unknown; username?: unknown } }>('/v1/auth/verify', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    cleanup();
    const challengeId = typeof request.body?.challenge_id === 'string' ? request.body.challenge_id : '';
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    if (!/^[0-9A-Za-z_]{1,16}$/.test(username)) return reply.code(400).send({ error: 'invalid_username' });
    const challenge = challenges.get(challengeId);
    if (!challenge || challenge.used || challenge.expiresAt <= now()) {
      return reply.code(400).send({ error: 'invalid_or_expired_challenge' });
    }
    challenge.used = true;
    const profile = await verifyMojang(username, challenge.serverId);
    if (!profile) return reply.code(401).send({ error: 'identity_not_verified' });
    const uuid = normalizeUuid(profile.id);
    if (!uuid || profile.name.toLowerCase() !== username.toLowerCase()) {
      return reply.code(401).send({ error: 'identity_not_verified' });
    }
    const issuedAt = Math.floor(now() / 1000);
    const token = signToken({
      sub: uuid,
      offline: minecraftOfflineUuid(profile.name),
      iat: issuedAt,
      exp: issuedAt + TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
    }, options.secret);
    return { token, uuid, expires_in: TOKEN_TTL_SECONDS };
  });

  app.post<{ Body: { music?: unknown } }>('/v1/presence/heartbeat', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const token = consumeTokenRate(request.headers.authorization);
    if (token === false) return reply.code(429).send({ error: 'rate_limited' });
    if (!token) return reply.code(401).send({ error: 'invalid_token' });
    const current = now();
    const previous = presence.get(token.sub);
    const next: PresenceEntry = { expiresAt: current + PRESENCE_TTL_MS, music: previous?.music };
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'music')) {
      if (request.body?.music === null) delete next.music;
      else if (typeof request.body?.music === 'object' && request.body.music !== null) {
        const candidate = request.body.music as { title?: unknown; artist?: unknown; artwork_id?: unknown; artwork_base64?: unknown };
        const title = sanitizeMusicField(candidate.title);
        const artist = sanitizeMusicField(candidate.artist);
        if (!title || !artist) return reply.code(400).send({ error: 'invalid_music_activity' });
        let artworkId: string | undefined;
        if (candidate.artwork_id !== undefined || candidate.artwork_base64 !== undefined) {
          const normalizedId = normalizeArtworkId(candidate.artwork_id);
          if (!normalizedId) return reply.code(400).send({ error: 'invalid_music_artwork' });
          artworkId = normalizedId;
          if (candidate.artwork_base64 !== undefined) {
            const decoded = decodeArtwork(candidate.artwork_base64, normalizedId);
            if (!decoded) return reply.code(400).send({ error: 'invalid_music_artwork' });
            artwork.set(normalizedId, { ...decoded, expiresAt: current + MUSIC_TTL_MS });
          } else {
            const existing = artwork.get(normalizedId);
            if (existing) existing.expiresAt = current + MUSIC_TTL_MS;
          }
        }
        next.music = { title, artist, artworkId, expiresAt: current + MUSIC_TTL_MS };
      } else {
        return reply.code(400).send({ error: 'invalid_music_activity' });
      }
    }
    presence.set(token.sub, next);
    if (token.offline && token.offline !== token.sub) presenceAliases.set(token.offline, token.sub);
    const artworkMissing = Boolean(next.music?.artworkId && !artwork.has(next.music.artworkId));
    return { active: true, expires_in: 120, ...(artworkMissing ? { artwork_missing: true } : {}) };
  });

  app.post<{ Body: { uuids?: unknown } }>('/v1/presence/query', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const token = consumeTokenRate(request.headers.authorization);
    if (token === false) return reply.code(429).send({ error: 'rate_limited' });
    if (!token) return reply.code(401).send({ error: 'invalid_token' });
    if (!Array.isArray(request.body?.uuids) || request.body.uuids.length > MAX_QUERY_UUIDS) {
      return reply.code(400).send({ error: 'invalid_uuid_list' });
    }
    cleanup();
    const requested = new Set(request.body.uuids.map((value) => typeof value === 'string' ? normalizeUuid(value) : null).filter(Boolean) as string[]);
    const current = now();
    const resolvePresence = (uuid: string): PresenceEntry | undefined => {
      const direct = presence.get(uuid);
      if (direct) return direct;
      const source = presenceAliases.get(uuid);
      return source ? presence.get(source) : undefined;
    };
    const active = [...requested].filter((uuid) => (resolvePresence(uuid)?.expiresAt ?? 0) > current);
    const music = active.flatMap((uuid) => {
      const activity = resolvePresence(uuid)?.music;
      return activity && activity.expiresAt > current
        ? [{ uuid, title: activity.title, artist: activity.artist, ...(activity.artworkId ? { artwork_id: activity.artworkId } : {}) }]
        : [];
    });
    return { active, music };
  });

  app.get<{ Params: { id: string } }>('/v1/presence/artwork/:id', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const token = consumeTokenRate(request.headers.authorization);
    if (token === false) return reply.code(429).send({ error: 'rate_limited' });
    if (!token) return reply.code(401).send({ error: 'invalid_token' });
    cleanup();
    const id = normalizeArtworkId(request.params.id);
    const entry = id ? artwork.get(id) : undefined;
    if (!entry || entry.expiresAt <= now()) return reply.code(404).send({ error: 'artwork_not_found' });
    reply.header('Cache-Control', 'private, max-age=20');
    reply.header('Content-Type', entry.contentType);
    reply.header('Content-Length', String(entry.bytes.length));
    return reply.send(entry.bytes);
  });

  return app;
}
