import { loadEnv, requireEnv, run, runWithRetry } from './release-lib.mjs'

loadEnv()
requireEnv(
  'UPDATE_FEED_URL',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
)

if (!process.env.CSC_LINK) {
  console.warn('⚠️   CSC_LINK not set — will use the same Keychain certificate discovery as Erozion.')
}

process.env.IS_ELECTRON = 'true'
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'true'

run('npx vite build')
runWithRetry(`npx electron-builder --mac --arm64 --x64 --config.publish.url=${process.env.UPDATE_FEED_URL} --config.mac.notarize.teamId=${process.env.APPLE_TEAM_ID}`, 3, 30_000)

process.env.R2_PLATFORM = 'mac'
run('node scripts/upload-r2.mjs')

console.log('\n✅  Impulse macOS release complete!')
