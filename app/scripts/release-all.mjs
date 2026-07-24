import { loadEnv, requireEnv, run } from './release-lib.mjs'

loadEnv()
requireEnv(
  'UPDATE_FEED_URL',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
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

run('rm -rf dist_electron')
run('node scripts/release-mac.mjs')
run('rm -rf dist_electron')
run('node scripts/release-win.mjs')

console.log('\n✅  Impulse all-platform release complete!')
