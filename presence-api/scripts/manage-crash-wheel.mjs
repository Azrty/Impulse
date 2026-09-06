import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.resolve(process.env.IMPULSE_CRASH_WHEEL_FILE || path.join(root, 'data', 'crash-wheel.json'));
const action = process.argv[2];
const supplied = String(process.argv[3] || '').trim();
const validUsername = /^[A-Za-z0-9_]{3,16}$/u;

if (!['add', 'remove', 'list'].includes(action)) {
  throw new Error('Usage: node scripts/manage-crash-wheel.mjs <add|remove|list> [MinecraftUsername]');
}
if (action !== 'list' && !validUsername.test(supplied)) {
  throw new Error('Expected a Minecraft username containing 3-16 letters, numbers, or underscores.');
}

const registry = JSON.parse(await readFile(file, 'utf8'));
const usernames = Array.isArray(registry.usernames)
  ? registry.usernames.filter(value => typeof value === 'string' && validUsername.test(value))
  : [];
const byLowercase = new Map(usernames.map(value => [value.toLowerCase(), value]));

if (action === 'list') {
  const sorted = [...byLowercase.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
  console.log(sorted.length ? sorted.join('\n') : 'No Crash Wheel participants.');
  process.exit(0);
}

const key = supplied.toLowerCase();
if (action === 'add') {
  if (byLowercase.has(key)) throw new Error(`${supplied} is already registered.`);
  byLowercase.set(key, supplied);
} else {
  if (!byLowercase.delete(key)) throw new Error(`${supplied} is not registered.`);
}

const updated = {
  schema_version: 1,
  ...(typeof registry.active_until === 'string' ? { active_until: registry.active_until } : {}),
  usernames: [...byLowercase.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })),
};
const temporary = `${file}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
await rename(temporary, file);
console.log(action === 'add' ? `Added ${supplied} to the Crash Wheel.` : `Removed ${supplied} from the Crash Wheel.`);
