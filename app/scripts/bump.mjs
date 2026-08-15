/**
 * bump.mjs
 *
 * Bumps the Impulse launcher version, commits, and creates a git tag.
 *
 * Usage:
 *   npm run bump           # patch  0.1.3 -> 0.1.4
 *   npm run bump minor     # minor  0.1.3 -> 0.2.0
 *   npm run bump major     # major  0.1.3 -> 1.0.0
 *   npm run bump 0.2.0     # exact  -> 0.2.0
 *   npm run bump beta      # beta   0.1.8 -> 0.1.9-beta.1
 *   npm run bump stable    # stable 0.1.9-beta.2 -> 0.1.9
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PKG_PATH = join(ROOT, 'package.json')
const LOCK_PATH = join(ROOT, 'package-lock.json')

function run(cmd) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' })
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

const pkg = readJson(PKG_PATH)
const current = pkg.version
const versionMatch = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/)

if (!versionMatch) {
  console.error(`Invalid current version "${current}". Expected x.y.z or x.y.z-beta.n`)
  process.exit(1)
}

const major = Number(versionMatch[1])
const minor = Number(versionMatch[2])
const patch = Number(versionMatch[3])
const betaNumber = versionMatch[4] ? Number(versionMatch[4]) : null
const arg = process.argv[2] ?? 'patch'

let next
if (/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(arg)) {
  next = arg
} else if (arg === 'major') {
  next = `${major + 1}.0.0`
} else if (arg === 'minor') {
  next = `${major}.${minor + 1}.0`
} else if (arg === 'patch') {
  next = `${major}.${minor}.${patch + 1}`
} else if (arg === 'beta') {
  next = betaNumber === null
    ? `${major}.${minor}.${patch + 1}-beta.1`
    : `${major}.${minor}.${patch}-beta.${betaNumber + 1}`
} else if (arg === 'stable') {
  if (betaNumber === null) {
    console.error(`Version "${current}" is already stable.`)
    process.exit(1)
  }
  next = `${major}.${minor}.${patch}`
} else {
  console.error(`Unknown bump type "${arg}". Use patch | minor | major | beta | stable | x.y.z[-beta.n]`)
  process.exit(1)
}

console.log(`\nImpulse ${current} -> ${next}\n`)

pkg.version = next
writeJson(PKG_PATH, pkg)

const filesToCommit = ['package.json']
if (existsSync(LOCK_PATH)) {
  const lock = readJson(LOCK_PATH)
  lock.version = next
  if (lock.packages?.['']) lock.packages[''].version = next
  writeJson(LOCK_PATH, lock)
  filesToCommit.push('package-lock.json')
}

run(`git add ${filesToCommit.join(' ')}`)
run(`git commit -m "chore: bump version to ${next}"`)
run(`git tag v${next}`)

console.log(`\nVersion bumped to ${next} and tagged as v${next}`)
console.log(`Push with: git push && git push origin v${next}\n`)
