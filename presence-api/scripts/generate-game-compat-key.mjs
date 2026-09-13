import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const destination = path.resolve(process.argv[2] || path.join(apiRoot, 'secrets', 'game-compat-ed25519.pem'));
if (process.argv.length > 3) throw new Error('Usage: npm run patches:keygen -- [private-key-file]');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicDer = publicKey.export({ format: 'der', type: 'spki' });
mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
writeFileSync(destination, pem, { flag: 'wx', mode: 0o600 });

console.log(`Private key written to ${destination} (do not commit or share it).`);
console.log(`Public key for ImpulseGameCompat.PINNED_PUBLIC_KEY: ${publicDer.toString('base64url')}`);
console.log(`Key ID: ${crypto.createHash('sha256').update(publicDer).digest('hex')}`);
console.log('Set GAME_COMPAT_SIGNING_PRIVATE_KEY_FILE to the private-key path in the API environment.');
console.log('A newly generated key will NOT work with already released clients until their pinned public key is updated.');
