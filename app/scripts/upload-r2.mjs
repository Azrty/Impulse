import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const DIST_DIR = new URL('../dist_electron', import.meta.url).pathname
const PLATFORM_FILTER = process.env['R2_PLATFORM'] ?? null
const ALLOWED_EXT = new Set(['.dmg', '.exe', '.yml', '.yaml', '.blockmap', '.zip'])
const PLATFORM_EXT = {
  mac: new Set(['.dmg', '.zip', '.blockmap']),
  win: new Set(['.exe', '.blockmap']),
}

function getEnv(name, fallback = null) {
  const val = process.env[name] || fallback
  if (!val) throw new Error(`Missing env var: ${name}`)
  return val
}

const accountId = process.env.IMPULSE_R2_ACCOUNT_ID || '3d334fb51a4cc8a76f11eb16bc37a043'
const bucket = process.env.IMPULSE_R2_BUCKET || 'impulse'
const jurisdiction = process.env['R2_JURISDICTION'] ?? ''
const endpoint = jurisdiction
  ? `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`
  : `https://${accountId}.r2.cloudflarestorage.com`

const client = new S3Client({
  region: 'auto',
  endpoint,
  credentials: {
    accessKeyId: getEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: getEnv('R2_SECRET_ACCESS_KEY'),
  },
})

function mimeFor(ext) {
  if (ext === '.yml' || ext === '.yaml') return 'text/yaml'
  return 'application/octet-stream'
}

async function uploadFile(localPath, key) {
  const body = readFileSync(localPath)
  const ext = extname(localPath).toLowerCase()
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: mimeFor(ext),
    CacheControl: 'no-cache',
  }))
  console.log(`✓ Uploaded ${key} (${(body.length / 1024 / 1024).toFixed(2)} MB)`)
}

async function main() {
  const allowedForPlatform = PLATFORM_FILTER ? PLATFORM_EXT[PLATFORM_FILTER] ?? ALLOWED_EXT : ALLOWED_EXT
  const files = readdirSync(DIST_DIR).filter((file) => {
    const ext = extname(file).toLowerCase()
    if (!ALLOWED_EXT.has(ext)) return false
    if (!statSync(join(DIST_DIR, file)).isFile()) return false
    if (ext === '.yml' || ext === '.yaml') {
      if (PLATFORM_FILTER === 'win') return file === 'latest.yml'
      if (PLATFORM_FILTER === 'mac') return file === 'latest-mac.yml'
      return file.startsWith('latest')
    }
    return allowedForPlatform.has(ext)
  })

  if (files.length === 0) {
    console.error('No artifacts found in dist_electron/. Run the build first.')
    process.exit(1)
  }

  console.log(`Uploading ${files.length} file(s) to R2 bucket "${bucket}" for https://impulse.epivalent.com...\n`)
  for (const file of files) {
    await uploadFile(join(DIST_DIR, file), file)
  }
  console.log('\nDone. Impulse update feed is live.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
