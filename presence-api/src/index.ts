import 'dotenv/config';
import { createPresenceServer } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';
const secret = process.env.PRESENCE_JWT_SECRET ?? '';
const curseForgeApiKey = process.env.CURSEFORGE_API_KEY ?? '';

const app = await createPresenceServer({ secret, curseForgeApiKey });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.close().finally(() => process.exit(0)));
}

await app.listen({ host, port });
