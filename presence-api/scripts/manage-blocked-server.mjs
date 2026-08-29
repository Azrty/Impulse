import { resolve4 } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.IMPULSE_BLOCKED_SERVERS_FILE || path.join(root, 'data', 'blocked-servers.json');
const reasonCodes = [
  'malware',
  'credential_theft',
  'phishing_impersonation',
  'compromised_server',
  'unsafe_mod_distribution',
  'fraud',
  'illegal_distribution',
  'abusive_content',
  'repeated_security_incidents',
  'policy_violation',
];
const remove = process.argv[2] === '--remove';
const offset = remove ? 3 : 2;
const rawHost = String(process.argv[offset] || '').trim().toLowerCase().replace(/\.$/u, '');
const reasonCode = String(process.argv[offset + 1] || '').trim().toLowerCase();
const usage = remove
  ? 'Usage: npm run servers:unblock <hostname-or-ipv4>'
  : `Usage: npm run servers:block <hostname-or-ipv4> <reason-code>\nReason codes: ${reasonCodes.join(', ')}`;

if (!rawHost || rawHost.length > 253 || rawHost.includes('/') || rawHost.includes(':')
  || (!/^[a-z0-9.-]+$/u.test(rawHost)) || rawHost.startsWith('.') || rawHost.endsWith('.') || rawHost.includes('..')) {
  throw new Error(`Expected a hostname or IPv4 address without a port.\n${usage}`);
}
if (!remove && (!reasonCodes.includes(reasonCode) || process.argv.length !== offset + 2)) {
  throw new Error(`Expected exactly one preset reason code.\n${usage}`);
}

const registry = JSON.parse(await readFile(file, 'utf8'));
registry.schema_version = 1;
registry.servers = Array.isArray(registry.servers) ? registry.servers : [];

if (remove) {
  const before = registry.servers.length;
  registry.servers = registry.servers.filter((entry) => entry.host !== rawHost);
  if (before === registry.servers.length) throw new Error(`Server ${rawHost} is not blocked.`);
  console.log(`Unblocked ${rawHost}.`);
} else {
  const ipv4 = isIP(rawHost) === 4 ? [rawHost] : [...new Set(await resolve4(rawHost))].sort();
  if (ipv4.length === 0) throw new Error(`Could not resolve an IPv4 address for ${rawHost}.`);
  const entry = { host: rawHost, ipv4, reason_code: reasonCode };
  registry.servers = registry.servers.filter((candidate) => candidate.host !== rawHost);
  registry.servers.push(entry);
  console.log(`Blocked ${rawHost} and ${ipv4.join(', ')} for ${reasonCode}.`);
}

registry.servers.sort((left, right) => left.host.localeCompare(right.host));
await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

if (process.env.IMPULSE_SKIP_TESTS !== '1') {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const tests = spawnSync(npm, ['test'], { cwd: root, stdio: 'inherit' });
  if (tests.status !== 0) throw new Error(`Registry updated, but tests failed with exit code ${tests.status ?? 'unknown'}.`);
}
