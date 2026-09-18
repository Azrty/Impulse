import { readFile, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.resolve(process.env.IMPULSE_STANDALONE_MIGRATION_FILE || path.join(root, 'data', 'standalone-migration.json'));
const command = String(process.argv[2] || '').toLowerCase();

if (!['true', 'false', 'status'].includes(command)) {
  throw new Error('Usage: npm run migration:set -- <true|false> [YYYY-MM-DD], or npm run migration:status');
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const current = JSON.parse(await readFile(file, 'utf8'));
if (current?.schema_version !== 1 || typeof current.migrate !== 'boolean' || !validDate(current.migration_date)
    || !Number.isSafeInteger(current.revision) || current.revision < 1) throw new Error('Invalid standalone migration registry.');

if (command !== 'status') {
  const migrationDate = String(process.argv[3] || current.migration_date);
  if (!validDate(migrationDate)) throw new Error('Migration date must be a real date formatted as YYYY-MM-DD.');
  const next = { schema_version: 1, migrate: command === 'true', migration_date: migrationDate, revision: current.revision + 1 };
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
  Object.assign(current, next);
}

console.log(`Standalone migration is ${current.migrate ? 'open' : 'closed'} for ${current.migration_date} (revision ${current.revision}).`);

if (command !== 'status' && process.env.IMPULSE_MIGRATION_SKIP_TESTS !== '1') {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const tests = spawnSync(npm, ['test'], { cwd: root, stdio: 'inherit', env: { ...process.env, IMPULSE_MIGRATION_SKIP_TESTS: '1' } });
  if (tests.status !== 0) throw new Error(`Migration registry updated, but tests failed with exit code ${tests.status ?? 'unknown'}.`);
}
