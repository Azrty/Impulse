import { createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { loadEnv, requireEnv, IMPULSE_R2_ACCOUNT_ID, IMPULSE_R2_BUCKET } from './release-lib.mjs'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const API_ROOT = join(APP_ROOT, '..', 'presence-api')
const [jarArgument, metadataArgument] = process.argv.slice(2)
if (!jarArgument || !metadataArgument) throw new Error('Usage: npm run release:patch -- <patch.jar> <metadata.json>')

const jarPath = resolve(jarArgument)
const metadataPath = resolve(metadataArgument)
const bytes = readFileSync(jarPath)
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
const fileName = basename(jarPath)
if (!/^[A-Za-z0-9._+-]+\.patch\.jar$/.test(fileName)) throw new Error('Patch filename must end in .patch.jar and contain only safe filename characters.')
if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(metadata.id || '')) throw new Error('Patch metadata has an invalid id.')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version || '')) throw new Error('Patch metadata has an invalid version.')
if (!['live', 'startup'].includes(metadata.mode)) throw new Error('Patch mode must be live or startup.')
for (const field of ['name', 'description']) if (typeof metadata[field] !== 'string' || !metadata[field].trim()) throw new Error(`Patch metadata requires ${field}.`)
for (const field of ['minecraft_versions', 'loaders', 'operating_systems', 'architectures', 'required_mods']) {
  if (!Array.isArray(metadata[field]) || metadata[field].length === 0) throw new Error(`Patch metadata requires a non-empty ${field} list.`)
}

const sha512 = createHash('sha512').update(bytes).digest('hex')
const entry = {
  ...metadata,
  file_name: fileName,
  download_url: `https://impulse.epivalent.com/patches/${encodeURIComponent(fileName)}`,
  sha512,
  size: bytes.length,
}
const catalogPath = join(API_ROOT, 'data', 'game-compat-patches.json')
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
catalog.patches = [...catalog.patches.filter(item => !(item.id === entry.id && item.version === entry.version)), entry]
  .sort((left, right) => `${left.id}:${left.version}`.localeCompare(`${right.id}:${right.version}`, undefined, { numeric: true }))

loadEnv()
requireEnv('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.IMPULSE_R2_ACCOUNT_ID || IMPULSE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
})
await client.send(new PutObjectCommand({
  Bucket: process.env.IMPULSE_R2_BUCKET || IMPULSE_R2_BUCKET,
  Key: `patches/${fileName}`,
  Body: bytes,
  ContentType: 'application/java-archive',
  CacheControl: 'public, max-age=31536000, immutable',
}))
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(`Published ${entry.id} ${entry.version}`)
console.log(`SHA-512 ${sha512}`)
console.log(`Updated ${catalogPath}; deploy presence-api to publish the newly signed catalog.`)
