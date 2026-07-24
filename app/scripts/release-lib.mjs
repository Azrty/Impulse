import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

export const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(__dirname, '..')
export const EROZION_ROOT = join(ROOT, '..', '..')
export const DIST = join(ROOT, 'dist_electron')
export const UPDATE_FEED_URL = 'https://impulse.epivalent.com'
export const IMPULSE_R2_ACCOUNT_ID = '3d334fb51a4cc8a76f11eb16bc37a043'
export const IMPULSE_R2_BUCKET = 'impulse'

export function loadEnv() {
  const envPaths = [
    join(ROOT, '.env'),
    join(EROZION_ROOT, '.env'),
  ]

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim()
      if (key && !(key in process.env)) process.env[key] = val
    }
  }

  process.env.UPDATE_FEED_URL = UPDATE_FEED_URL
  process.env.R2_ACCOUNT_ID = IMPULSE_R2_ACCOUNT_ID
  process.env.R2_BUCKET = IMPULSE_R2_BUCKET

  if (process.env.CSC_LINK && !process.env.CSC_LINK.match(/^(https?:|file:)/i)) {
    const currentPath = join(ROOT, process.env.CSC_LINK)
    const erozionPath = join(EROZION_ROOT, process.env.CSC_LINK)
    if (!existsSync(currentPath) && existsSync(erozionPath)) {
      process.env.CSC_LINK = erozionPath
    }
  }
}

export function requireEnv(...names) {
  const missing = names.filter((name) => !process.env[name])
  if (missing.length) {
    console.error(`❌  Missing env vars: ${missing.join(', ')}`)
    process.exit(1)
  }
}

export function run(cmd) {
  console.log(`\n▶  ${cmd}\n`)
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', env: process.env })
}

export function runWithRetry(cmd, retries = 3, delayMs = 30_000) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      run(cmd)
      return
    } catch (error) {
      if (attempt === retries) throw error
      console.warn(`\n⚠️   Attempt ${attempt}/${retries} failed. Retrying in ${delayMs / 1000}s...`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
    }
  }
}
