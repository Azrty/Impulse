import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createPresenceServer } from './server.js';

// Resolve the service-local file even when systemd starts the API from the
// repository root or another working directory.
loadEnv({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';
const secret = process.env.PRESENCE_JWT_SECRET ?? '';
const curseForgeApiKey = process.env.CURSEFORGE_API_KEY ?? '';
const reportsDirectory = process.env.REPORTS_DIRECTORY;

const app = await createPresenceServer({ secret, curseForgeApiKey, reportsDirectory });
app.log.info({ curseForgeEnabled: Boolean(curseForgeApiKey.trim()) }, 'Optional integrations configured');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.close().finally(() => process.exit(0)));
}

await app.listen({ host, port });
