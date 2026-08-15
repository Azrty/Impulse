import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { execFileSync, execSync } from 'child_process'
import { join } from 'path'
import { createHash } from 'crypto'
import { DIST, ROOT, loadEnv, requireEnv, run } from './release-lib.mjs'

function getAzureToken() {
  console.log('\n▶  Fetching Azure access token...')
  const response = execFileSync('curl', [
    '-sf', '-X', 'POST',
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    '-d', 'grant_type=client_credentials',
    '-d', `client_id=${process.env.AZURE_CLIENT_ID}`,
    '-d', `client_secret=${process.env.AZURE_CLIENT_SECRET}`,
    '-d', 'scope=https://codesigning.azure.net/.default',
  ], { encoding: 'utf-8' })
  const token = JSON.parse(response).access_token
  if (!token) throw new Error('Failed to get Azure token — check AZURE_* credentials')
  console.log('✓  Token obtained')
  return token
}

function signExe(token) {
  console.log('\n▶  Signing dist_electron/*.exe via jsign + Azure Trusted Signing...')
  execSync(
    `jsign \
      --storetype TRUSTEDSIGNING \
      --keystore "${process.env.AZURE_TRUSTED_SIGNING_ENDPOINT}" \
      --storepass "${token}" \
      --alias "${process.env.AZURE_TRUSTED_SIGNING_ACCOUNT}/${process.env.AZURE_CERTIFICATE_PROFILE_NAME}" \
      --tsaurl http://timestamp.acs.microsoft.com \
      --tsmode RFC3161 \
      --alg SHA-256 \
      --name "Impulse" \
      --url "https://impulse.epivalent.com" \
      "${DIST}"/*.exe`,
    { cwd: ROOT, stdio: 'inherit', env: process.env }
  )
  console.log('✓  Signing complete')
}

function refreshUpdateMetadataForSignedExe() {
  const exe = readdirSync(DIST).find((file) => file.toLowerCase().endsWith('.exe'))
  if (!exe) throw new Error('No .exe found in dist_electron/ after build/sign step')

  const exePath = join(DIST, exe)
  const exeBuf = readFileSync(exePath)
  const sha512 = createHash('sha512').update(exeBuf).digest('base64')
  const size = statSync(exePath).size

  const metadataFiles = readdirSync(DIST).filter((file) => /^(latest|beta)\.yml$/i.test(file))
  if (!metadataFiles.length) throw new Error('No Windows update metadata found after build/sign step')
  for (const metadataFile of metadataFiles) {
    const metadataPath = join(DIST, metadataFile)
    let metadata = readFileSync(metadataPath, 'utf-8')
    metadata = metadata.replace(/(\n\s*-\s+url:\s+).*/i, `$1${exe}`)
    metadata = metadata.replace(/(\npath:\s+).*/i, `$1${exe}`)
    metadata = metadata.replace(/(\n\s+size:\s+)\d+/i, `$1${size}`)
    metadata = metadata.replace(/^(\s*sha512:\s*).+$/gm, `$1${sha512}`)
    writeFileSync(metadataPath, metadata)
    console.log(`✓  Refreshed dist_electron/${metadataFile} with signed exe hash/size`)
  }
}

loadEnv()
requireEnv(
  'UPDATE_FEED_URL',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TRUSTED_SIGNING_ENDPOINT',
  'AZURE_TRUSTED_SIGNING_ACCOUNT',
  'AZURE_CERTIFICATE_PROFILE_NAME',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
)

process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
delete process.env.CSC_LINK
delete process.env.CSC_KEY_PASSWORD
process.env.AZURE_SIGNING_TOKEN = getAzureToken()
process.env.IS_ELECTRON = 'true'

run('npx vite build')
run(`npx electron-builder --win --x64 --config.publish.url=${process.env.UPDATE_FEED_URL}`)
signExe(process.env.AZURE_SIGNING_TOKEN)
refreshUpdateMetadataForSignedExe()

process.env.R2_PLATFORM = 'win'
run('node scripts/upload-r2.mjs')

console.log('\n✅  Impulse Windows release complete!')
