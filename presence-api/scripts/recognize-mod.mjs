import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/recognized-mods.json');
const hash = String(process.argv[2] || '').trim().toLowerCase();
const name = String(process.argv.slice(3).join(' ') || '').replace(/[\u0000-\u001f\u007f]/gu, '').trim().replace(/\s+/gu, ' ');
if (!/^[0-9a-f]{128}$/.test(hash)) throw new Error('Expected a 128-character hexadecimal SHA-512 hash.');
if (!name || name.length > 160) throw new Error('Mod name must contain 1 to 160 printable characters.');
const registry = JSON.parse(await readFile(file, 'utf8'));
registry.schema_version = 1;
registry.mods ||= {};
if (registry.mods[hash] && registry.mods[hash].name !== name) throw new Error(`This hash is already registered as "${registry.mods[hash].name}".`);
registry.mods[hash] = { name };
registry.mods = Object.fromEntries(Object.entries(registry.mods).sort(([left], [right]) => left.localeCompare(right)));
await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
console.log(`Recognized ${name}: ${hash}`);
