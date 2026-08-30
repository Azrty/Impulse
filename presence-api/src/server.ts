import crypto from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
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
  curseForgeApiKey?: string;
  curseForgeFetch?: typeof fetch;
  reportsDirectory?: string;
};

type CurseForgeRequestFile = { sha512: string; fingerprint: number };
type CurseForgeFile = {
  id?: number;
  modId?: number;
  fileName?: string;
  gameVersions?: string[];
};

export const BLOCKED_SERVER_REASON_CODES = new Set([
  'malware',
  'credential_theft',
  'phishing_impersonation',
  'compromised_server',
  'unsafe_mod_distribution',
  'fraud',
  'illegal_distribution',
  'abusive_content',
  'repeated_security_incidents',
  'policy_violation',
]);

export const SERVER_REPORT_CATEGORIES = new Set([
  'malicious_files',
  'credential_theft',
  'impersonation',
  'fraud',
  'abuse',
  'other_security',
]);

function cleanReportText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '').trim().slice(0, maxLength);
}

type BlockedServerEntry = { host: string; ipv4: string[]; reason_code: string };
type StandaloneUpdateSection = { icon: string; title: string; body: string };
type StandaloneUpdatePublication = {
  id: string;
  title: string;
  subtitle: string;
  versions: string[];
  published_at: string;
  hero_image_url: string | null;
  sections: StandaloneUpdateSection[];
};

const STANDALONE_UPDATE_ICONS = new Set(['sparkles', 'shield-check', 'package-plus', 'scan-check', 'wrench', 'rocket', 'server', 'download']);
const EXACT_MOD_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u;

function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim();
  if (!cleaned || [...cleaned].length > max) throw new Error(`${name} must contain between 1 and ${max} characters.`);
  return cleaned;
}

export function sanitizeStandaloneUpdates(value: unknown): { schema_version: 1; publications: StandaloneUpdatePublication[] } {
  const source = value as { schema_version?: unknown; publications?: unknown } | null;
  if (source?.schema_version !== 1 || !Array.isArray(source.publications)) throw new Error('Invalid standalone updates registry.');
  const ids = new Set<string>();
  const publications = source.publications.map((raw, publicationIndex) => {
    const item = raw as Record<string, unknown> | null;
    const id = boundedText(item?.id, `publications[${publicationIndex}].id`, 80).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate standalone update id: ${id}`);
    ids.add(id);
    if (!Array.isArray(item?.versions) || item.versions.length === 0 || item.versions.length > 100) throw new Error(`${id} must target between 1 and 100 versions.`);
    const versions = [...new Set(item.versions.map((version) => boundedText(version, `${id}.versions`, 64)))];
    if (versions.some((version) => !EXACT_MOD_VERSION.test(version))) throw new Error(`${id} contains an invalid exact version.`);
    const published = boundedText(item?.published_at, `${id}.published_at`, 64);
    if (!Number.isFinite(Date.parse(published))) throw new Error(`${id} has an invalid publication date.`);
    let heroImageUrl: string | null = null;
    if (item?.hero_image_url !== null && item?.hero_image_url !== undefined) {
      const candidate = new URL(boundedText(item.hero_image_url, `${id}.hero_image_url`, 2048));
      if (candidate.protocol !== 'https:') throw new Error(`${id} hero image must use HTTPS.`);
      heroImageUrl = candidate.toString();
    }
    if (!Array.isArray(item?.sections) || item.sections.length === 0 || item.sections.length > 8) throw new Error(`${id} must contain between 1 and 8 sections.`);
    const sections = item.sections.map((rawSection, sectionIndex) => {
      const section = rawSection as Record<string, unknown> | null;
      const icon = boundedText(section?.icon, `${id}.sections[${sectionIndex}].icon`, 32);
      if (!STANDALONE_UPDATE_ICONS.has(icon)) throw new Error(`${id} uses unsupported icon ${icon}.`);
      return {
        icon,
        title: boundedText(section?.title, `${id}.sections[${sectionIndex}].title`, 100),
        body: boundedText(section?.body, `${id}.sections[${sectionIndex}].body`, 500),
      };
    });
    return {
      id,
      title: boundedText(item?.title, `${id}.title`, 120),
      subtitle: boundedText(item?.subtitle, `${id}.subtitle`, 240),
      versions,
      published_at: new Date(published).toISOString(),
      hero_image_url: heroImageUrl,
      sections,
    };
  }).sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at));
  return { schema_version: 1, publications };
}

export function sanitizeBlockedServerRegistry(value: unknown): { schema_version: 1; servers: BlockedServerEntry[] } {
  const source = value as { servers?: unknown } | null;
  const servers: BlockedServerEntry[] = [];
  for (const raw of Array.isArray(source?.servers) ? source.servers : []) {
    const entry = raw as Record<string, unknown> | null;
    const host = typeof entry?.host === 'string' ? entry.host.trim().toLowerCase().replace(/\.$/u, '') : '';
    if (!host || host.length > 253 || !/^[a-z0-9.-]+$/u.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) continue;
    const ipv4 = [...new Set((Array.isArray(entry?.ipv4) ? entry.ipv4 : []).map(String).filter((address) => isIP(address) === 4))].sort();
    const requestedCode = typeof entry?.reason_code === 'string' ? entry.reason_code.trim().toLowerCase() : '';
    const reason_code = BLOCKED_SERVER_REASON_CODES.has(requestedCode) ? requestedCode : 'policy_violation';
    servers.push({ host, ipv4, reason_code });
  }
  servers.sort((left, right) => left.host.localeCompare(right.host));
  return { schema_version: 1, servers };
}

class CurseForgeRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

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

async function queryCurseForgeFingerprints(
  apiKey: string,
  fingerprints: number[],
  requestFetch: typeof fetch,
  logger: FastifyBaseLogger,
): Promise<Map<number, CurseForgeFile>> {
  let lastError: unknown = new Error('CurseForge verification failed.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const startedAt = Date.now();
    try {
      logger.info({ attempt: attempt + 1, maxAttempts: 3, fingerprintCount: fingerprints.length }, 'Sending CurseForge fingerprint request');
      const response = await requestFetch('https://api.curseforge.com/v1/fingerprints/432', {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'PrismLauncher/11.0.3',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ fingerprints }),
      });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable) {
          logger.warn({ attempt: attempt + 1, httpStatus: response.status, durationMs: Date.now() - startedAt }, 'CurseForge rejected fingerprint request');
          throw new CurseForgeRequestError(`CurseForge returned HTTP ${response.status}.`, false);
        }
        lastError = new Error(`CurseForge returned HTTP ${response.status}.`);
        if (attempt < 2) {
          const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
          const retryDelayMs = Number.isFinite(retryAfter) ? Math.min(5_000, retryAfter * 1_000) : [250, 750][attempt];
          logger.warn({ attempt: attempt + 1, httpStatus: response.status, retryDelayMs, durationMs: Date.now() - startedAt }, 'Retrying CurseForge fingerprint request');
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        throw lastError;
      }
      const payload = await response.json() as { data?: { exactMatches?: Array<{ id?: number; file?: CurseForgeFile }> } };
      const result = new Map<number, CurseForgeFile>();
      for (const match of payload.data?.exactMatches ?? []) {
        if (Number.isSafeInteger(match.id) && match.file) result.set(Number(match.id), match.file);
      }
      logger.info({ attempt: attempt + 1, httpStatus: response.status, exactMatchCount: result.size, durationMs: Date.now() - startedAt }, 'CurseForge fingerprint request completed');
      return result;
    } catch (error) {
      lastError = error;
      if (error instanceof CurseForgeRequestError && !error.retryable) throw error;
      if (attempt < 2) {
        const retryDelayMs = [250, 750][attempt];
        logger.warn({ attempt: attempt + 1, retryDelayMs, durationMs: Date.now() - startedAt, error }, 'Retrying CurseForge fingerprint request after network error');
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
    }
  }
  throw lastError;
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
  const curseForgeRequests = new Map<string, Promise<Map<number, CurseForgeFile>>>();
  const reportsDirectory = path.resolve(options.reportsDirectory ?? path.join(process.cwd(), 'reports'));
  const registryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/recognized-mods.json');
  let recognizedMods: { schema_version: number; mods: Record<string, { name: string }> } = { schema_version: 1, mods: {} };
  try { recognizedMods = JSON.parse(await readFile(registryPath, 'utf8')); } catch (error) { app.log.warn({ error }, 'Unable to read recognized mod registry'); }
  const recognizedModsBody = JSON.stringify(recognizedMods);
  const recognizedModsEtag = `"${crypto.createHash('sha256').update(recognizedModsBody).digest('hex')}"`;
  const blockedServersPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/blocked-servers.json');
  let blockedServers: { schema_version: 1; servers: BlockedServerEntry[] } = { schema_version: 1, servers: [] };
  try { blockedServers = sanitizeBlockedServerRegistry(JSON.parse(await readFile(blockedServersPath, 'utf8'))); } catch (error) { app.log.warn({ error }, 'Unable to read blocked server registry'); }
  async function currentBlockedServers(): Promise<{ body: string; etag: string }> {
    try {
      const candidate = JSON.parse(await readFile(blockedServersPath, 'utf8'));
      if (candidate?.schema_version !== 1 || !Array.isArray(candidate.servers)) throw new Error('Invalid blocked server registry.');
      blockedServers = sanitizeBlockedServerRegistry(candidate);
    } catch (error) {
      app.log.warn({ error }, 'Unable to refresh blocked server registry; serving last valid copy');
    }
    const body = JSON.stringify(blockedServers);
    return { body, etag: `"${crypto.createHash('sha256').update(body).digest('hex')}"` };
  }
  const standaloneUpdatesPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/standalone-updates.json');
  let standaloneUpdates = sanitizeStandaloneUpdates(JSON.parse(await readFile(standaloneUpdatesPath, 'utf8')));
  async function currentStandaloneUpdates(): Promise<{ body: string; etag: string }> {
    try {
      standaloneUpdates = sanitizeStandaloneUpdates(JSON.parse(await readFile(standaloneUpdatesPath, 'utf8')));
    } catch (error) {
      app.log.warn({ error }, 'Unable to refresh standalone updates; serving last valid copy');
    }
    const body = JSON.stringify(standaloneUpdates);
    return { body, etag: `"${crypto.createHash('sha256').update(body).digest('hex')}"` };
  }

  app.get('/v1/mod-verification/recognized-mods', async (request, reply) => {
    reply.header('Cache-Control', 'public, max-age=3600, stale-if-error=86400');
    reply.header('ETag', recognizedModsEtag);
    if (request.headers['if-none-match'] === recognizedModsEtag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(recognizedModsBody);
  });

  app.get('/v1/security/blocked-servers', async (request, reply) => {
    const registry = await currentBlockedServers();
    reply.header('Cache-Control', 'public, max-age=300, stale-if-error=86400');
    reply.header('ETag', registry.etag);
    if (request.headers['if-none-match'] === registry.etag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(registry.body);
  });

  app.get('/v1/standalone/updates', async (request, reply) => {
    const registry = await currentStandaloneUpdates();
    reply.header('Cache-Control', 'public, max-age=900, stale-if-error=86400');
    reply.header('ETag', registry.etag);
    if (request.headers['if-none-match'] === registry.etag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(registry.body);
  });

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

  app.post('/v1/security/server-reports', { config: { rateLimit: { max: 5, timeWindow: '24 hours' } } }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const serverName = cleanReportText(body?.server_name, 128);
    const serverAddress = cleanReportText(body?.server_address, 320).toLowerCase();
    const serverHost = cleanReportText(body?.server_host, 253).toLowerCase();
    const category = cleanReportText(body?.category, 40).toLowerCase();
    const details = cleanReportText(body?.details, 2000);
    const minecraftVersion = cleanReportText(body?.minecraft_version, 40);
    const loader = cleanReportText(body?.loader, 20).toLowerCase();
    const client = cleanReportText(body?.client, 24).toLowerCase();
    if (!serverName
      || serverAddress.length < 3
      || !serverHost
      || !SERVER_REPORT_CATEGORIES.has(category)
      || details.length < 20
      || !/^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u.test(minecraftVersion)
      || !['forge', 'neoforge'].includes(loader)
      || !['standalone', 'launcher'].includes(client)) {
      return reply.code(400).send({ error: 'The server report is incomplete or invalid.' });
    }

    const reportId = crypto.randomUUID();
    const submittedAt = new Date(now()).toISOString();
    const sourceId = crypto.createHmac('sha256', options.secret).update(request.ip).digest('hex');
    const report = {
      schema_version: 1,
      report_id: reportId,
      submitted_at: submittedAt,
      category,
      details,
      server: { name: serverName, address: serverAddress, host: serverHost },
      environment: { minecraft_version: minecraftVersion, loader, client },
      source_id: sourceId,
      user_agent: cleanReportText(request.headers['user-agent'], 200),
    };
    const fileName = `${submittedAt.replace(/[:.]/gu, '-')}-${reportId}.json`;
    await mkdir(reportsDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(reportsDirectory, fileName);
    const temporary = `${target}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      request.log.error({ error, reportId }, 'Unable to persist server report');
      return reply.code(500).send({ error: 'The report could not be saved. Please try again later.' });
    }
    request.log.info({ reportId, serverHost, category, client }, 'Server report received');
    return reply.code(201).send({ report_id: reportId, status: 'received' });
  });

  app.post('/v1/mod-verification/curseforge', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    const minecraftVersion = typeof body?.minecraft_version === 'string' ? body.minecraft_version.trim() : '';
    const loader = typeof body?.loader === 'string' ? body.loader.trim().toLowerCase() : '';
    const rawFiles = Array.isArray(body?.files) ? body.files : [];
    if (!/^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u.test(minecraftVersion)
      || !['forge', 'neoforge'].includes(loader)
      || rawFiles.length < 1
      || rawFiles.length > 100) {
      return reply.code(400).send({ error: 'Invalid CurseForge verification request.' });
    }
    const files: CurseForgeRequestFile[] = [];
    const seenHashes = new Set<string>();
    for (const raw of rawFiles) {
      const entry = raw as Record<string, unknown> | null;
      const sha512 = typeof entry?.sha512 === 'string' ? entry.sha512.trim().toLowerCase() : '';
      const fingerprint = Number(entry?.fingerprint);
      if (!/^[0-9a-f]{128}$/u.test(sha512)
        || !Number.isSafeInteger(fingerprint)
        || fingerprint < 0
        || fingerprint > 0xffffffff
        || seenHashes.has(sha512)) {
        return reply.code(400).send({ error: 'Invalid CurseForge verification file.' });
      }
      seenHashes.add(sha512);
      files.push({ sha512, fingerprint });
    }
    const apiKey = options.curseForgeApiKey?.trim();
    if (!apiKey) {
      request.log.warn({ minecraftVersion, loader, fileCount: files.length }, 'CurseForge verification requested while integration is disabled');
      return reply.code(503).send({ error: 'CurseForge verification is unavailable.' });
    }

    const requestKey = JSON.stringify({ minecraftVersion, loader, fingerprints: [...new Set(files.map((file) => file.fingerprint))].sort((a, b) => a - b) });
    let pending = curseForgeRequests.get(requestKey);
    request.log.info({ minecraftVersion, loader, fileCount: files.length, uniqueFingerprintCount: new Set(files.map((file) => file.fingerprint)).size }, 'CurseForge mod verification started');
    if (!pending) {
      pending = queryCurseForgeFingerprints(
        apiKey,
        [...new Set(files.map((file) => file.fingerprint))],
        options.curseForgeFetch ?? fetch,
        request.log,
      ).finally(() => curseForgeRequests.delete(requestKey));
      curseForgeRequests.set(requestKey, pending);
    } else {
      request.log.info({ minecraftVersion, loader, fileCount: files.length }, 'Reusing in-flight CurseForge fingerprint request');
    }
    try {
      const exactMatches = await pending;
      const matches: Record<string, unknown> = {};
      let compatibleCount = 0;
      let incompatibleCount = 0;
      let unverifiedCount = 0;
      for (const file of files) {
        const match = exactMatches.get(file.fingerprint);
        if (!match) {
          matches[file.sha512] = { status: 'Unverified' };
          unverifiedCount++;
          continue;
        }
        const versions = Array.isArray(match.gameVersions) ? match.gameVersions.map((value) => String(value).toLowerCase()) : [];
        const compatible = versions.includes(minecraftVersion.toLowerCase()) && versions.includes(loader);
        if (compatible) compatibleCount++;
        else incompatibleCount++;
        matches[file.sha512] = {
          status: compatible ? 'Matched on CurseForge' : 'Incompatible CurseForge listing',
          project_id: Number.isSafeInteger(match.modId) ? match.modId : null,
          file_id: Number.isSafeInteger(match.id) ? match.id : null,
          file_name: typeof match.fileName === 'string' ? match.fileName : null,
        };
      }
      request.log.info({ minecraftVersion, loader, fileCount: files.length, compatibleCount, incompatibleCount, unverifiedCount }, 'CurseForge mod verification completed');
      return { matches };
    } catch (error) {
      request.log.warn({ error }, 'CurseForge fingerprint verification failed');
      return reply.code(502).send({ error: 'CurseForge verification is unavailable.' });
    }
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
