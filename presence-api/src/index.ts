import { config as loadEnv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPresenceServer } from './server.js';

// Source and compiled entry points live at different depths; Docker copies the
// compiled entry point directly into dist.
let configDirectory = process.cwd();
for (const relativePath of ['../.env', '../../.env']) {
  const candidate = fileURLToPath(new URL(relativePath, import.meta.url));
  if (existsSync(candidate)) {
    loadEnv({ path: candidate });
    configDirectory = path.dirname(candidate);
    break;
  }
}

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';
const secret = process.env.PRESENCE_JWT_SECRET ?? '';
const curseForgeApiKey = process.env.CURSEFORGE_API_KEY ?? '';
const reportsDirectory = process.env.REPORTS_DIRECTORY;
const bugReportsDirectory = process.env.BUG_REPORTS_DIRECTORY;
const bugReportRetentionDays = Number.parseInt(process.env.BUG_REPORT_RETENTION_DAYS ?? '90', 10);
const bugReportMaxStorageBytes = Number.parseInt(process.env.BUG_REPORT_MAX_STORAGE_BYTES ?? String(20 * 1024 * 1024 * 1024), 10);
const crashWheelFile = process.env.IMPULSE_CRASH_WHEEL_FILE;
let gameCompatSigningPrivateKey = process.env.GAME_COMPAT_SIGNING_PRIVATE_KEY;
let gameCompatKeyLoadError: unknown;
if (!gameCompatSigningPrivateKey?.trim() && process.env.GAME_COMPAT_SIGNING_PRIVATE_KEY_FILE?.trim()) {
  try {
    const keyPath = path.resolve(configDirectory, process.env.GAME_COMPAT_SIGNING_PRIVATE_KEY_FILE.trim());
    gameCompatSigningPrivateKey = readFileSync(keyPath, 'utf8');
  } catch (error) {
    gameCompatKeyLoadError = error;
  }
}

const app = await createPresenceServer({ secret, curseForgeApiKey, reportsDirectory, bugReportsDirectory, bugReportRetentionDays, bugReportMaxStorageBytes, crashWheelFile, gameCompatSigningPrivateKey });
app.log.info({ curseForgeEnabled: Boolean(curseForgeApiKey.trim()) }, 'Optional integrations configured');
if (gameCompatKeyLoadError) app.log.error({ error: gameCompatKeyLoadError }, 'Unable to read Game Compat signing key file.');
if (!gameCompatSigningPrivateKey?.trim())
  app.log.warn('Game Compat signing key is missing; catalog requests will return HTTP 503.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.close().finally(() => process.exit(0)));
}

await app.listen({ host, port });
