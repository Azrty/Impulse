import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.resolve(process.env.IMPULSE_LAUNCHER_AVAILABILITY_FILE || path.join(root, 'data', 'launcher-availability.json'));
const command = String(process.argv[2] || '').toLowerCase();
if (!['enable', 'disable', 'status'].includes(command)) {
  throw new Error('Usage: node scripts/manage-launcher-availability.mjs <enable|disable|status>');
}

let current = { schema_version: 1, isLauncherAvailable: false };
try {
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (parsed?.schema_version !== 1 || typeof parsed.isLauncherAvailable !== 'boolean') throw new Error('Invalid registry format.');
  current = parsed;
} catch (error) {
  if (command === 'status') throw error;
}

if (command !== 'status') {
  current = { schema_version: 1, isLauncherAvailable: command === 'enable' };
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

console.log(`Impulse Launcher is ${current.isLauncherAvailable ? 'available' : 'unavailable'}.`);
