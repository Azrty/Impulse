import { createHash } from 'crypto'
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { spawnSync } from 'child_process'
import { basename, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import AdmZip from 'adm-zip'
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
if (bytes.length < 1 || bytes.length > 64 * 1024 * 1024) throw new Error('Patch size must be between 1 byte and 64 MiB.')
const zip = new AdmZip(bytes)
const readEntry = name => {
  const entry = zip.getEntry(name)
  if (!entry || entry.header.size > 1024 * 1024) throw new Error(`Patch is missing a valid ${name}.`)
  return entry.getData().toString('utf8')
}
const descriptor = JSON.parse(readEntry('META-INF/impulse-patch.json'))
for (const key of ['id', 'version', 'mode']) if (descriptor[key] !== metadata[key]) throw new Error(`Patch descriptor ${key} does not match release metadata.`)
const service = metadata.mode === 'live' ? 'com.impulse.gamecompat.ImpulseCompatPatch' : 'com.impulse.gamecompat.ImpulseStartupPatch'
const transformService = 'com.impulse.bootstrap.neoforge121.ImpulseClassTransformer'
const providers = [service, ...(metadata.mode === 'startup' ? [transformService] : [])]
  .flatMap(name => {
    const entry = zip.getEntry(`META-INF/services/${name}`)
    if (entry && entry.header.size > 32 * 1024) throw new Error(`Patch service file is too large: ${name}`)
    return entry ? entry.getData().toString('utf8').split(/\r?\n/u).map(line => line.split('#')[0].trim()).filter(Boolean) : []
  })
if (!providers.length) throw new Error('Patch has no service provider for its mode.')
for (const name of providers) {
  const classEntry = zip.getEntry(`${name.replaceAll('.', '/')}.class`)
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u.test(name) || !classEntry || classEntry.header.size > 1024 * 1024
    || classEntry.getData().subarray(0, 4).toString('hex') !== 'cafebabe')
    throw new Error(`Patch service class is missing: ${name}`)
}
if (metadata.target_classes !== undefined && !zip.getEntry(`META-INF/services/${transformService}`))
  throw new Error('target_classes requires an ImpulseClassTransformer service.')
if (zip.getEntry(`META-INF/services/${transformService}`)) {
  if (metadata.mode !== 'startup' || !Array.isArray(metadata.target_classes) || !metadata.target_classes.length
    || JSON.stringify(metadata.target_classes) !== JSON.stringify(descriptor.target_classes))
    throw new Error('Startup transformer target_classes must match the patch descriptor and release metadata.')
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
if (catalog.patches.some(item => item.id === entry.id && item.version === entry.version))
  throw new Error(`Patch ${entry.id} ${entry.version} is already in the catalog. Publish a new version.`)
catalog.revision = (catalog.revision || 0) + 1
catalog.patches = [...catalog.patches, entry]
  .sort((left, right) => `${left.id}:${left.version}`.localeCompare(`${right.id}:${right.version}`, undefined, { numeric: true }))
const validation = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/validate-game-compat-catalog.ts'], {
  cwd: API_ROOT, input: JSON.stringify(catalog), encoding: 'utf8', timeout: 30_000,
})
if (validation.status !== 0) throw new Error(`Catalog validation failed before upload: ${validation.stderr || validation.error || validation.status}`)

loadEnv()
requireEnv('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.IMPULSE_R2_ACCOUNT_ID || IMPULSE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
})
try {
  await client.send(new HeadObjectCommand({ Bucket: process.env.IMPULSE_R2_BUCKET || IMPULSE_R2_BUCKET, Key: `patches/${fileName}` }))
  throw new Error(`Patch filename already exists on R2: ${fileName}. Use a new version and filename.`)
} catch (error) {
  if (error.name !== 'NotFound' && error.$metadata?.httpStatusCode !== 404) throw error
}
await client.send(new PutObjectCommand({
  Bucket: process.env.IMPULSE_R2_BUCKET || IMPULSE_R2_BUCKET,
  Key: `patches/${fileName}`,
  Body: bytes,
  ContentType: 'application/java-archive',
  CacheControl: 'public, max-age=31536000, immutable',
}))
const temporaryCatalog = `${catalogPath}.tmp-${process.pid}`
try {
  writeFileSync(temporaryCatalog, `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx' })
  renameSync(temporaryCatalog, catalogPath)
} catch (error) {
  try { unlinkSync(temporaryCatalog) } catch { /* no temporary file */ }
  throw new Error(`Patch uploaded, but local catalog publication failed: ${error.message}. Do not reuse this filename.`)
}
console.log(`Published ${entry.id} ${entry.version}`)
console.log(`SHA-512 ${sha512}`)
console.log(`Updated ${catalogPath}; deploy presence-api to publish the newly signed catalog.`)
