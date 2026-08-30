import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sanitizeStandaloneUpdates } from '../src/server.js';

const file = resolve(process.cwd(), 'data/standalone-updates.json');
const registry = sanitizeStandaloneUpdates(JSON.parse(await readFile(file, 'utf8')));
console.log(`Validated ${registry.publications.length} standalone update publication(s).`);
