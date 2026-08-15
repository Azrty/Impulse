import 'dotenv/config';
import { createPresenceServer } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';
const secret = process.env.PRESENCE_JWT_SECRET ?? '';

const app = await createPresenceServer({ secret });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.close().finally(() => process.exit(0)));
}

await app.listen({ host, port });
