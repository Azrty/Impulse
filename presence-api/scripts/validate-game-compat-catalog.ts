import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { sanitizeGameCompatCatalog } from '../src/server.ts';

const input = readFileSync(0, 'utf8');
const candidate = JSON.parse(input);
const sanitized = sanitizeGameCompatCatalog(candidate);
if (!isDeepStrictEqual(sanitized, candidate)) {
  throw new Error('Game Compat catalog contains fields or values the API would change while publishing.');
}
