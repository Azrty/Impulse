/**
 * Bump every Impulse mod version source without changing the launcher version.
 *
 * Usage:
 *   npm run bump:mods -- patch
 *   npm run bump:mods -- minor
 *   npm run bump:mods -- major
 *   npm run bump:mods -- beta
 *   npm run bump:mods -- stable
 *   npm run bump:mods -- 1.2.3
 */

import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD_ROOT = join(APP_ROOT, '..', 'mod')
const VERSION_FILE = join(MOD_ROOT, 'build.gradle')
const LAUNCHER_MOD_VERSION_FILE = join(APP_ROOT, 'src', 'version.ts')

function nextVersion(current, requested) {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/)
  if (!match) throw new Error(`Invalid current mod version "${current}".`)
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const beta = match[4] ? Number(match[4]) : null

  if (/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(requested)) return requested
  if (requested === 'major') return `${major + 1}.0.0`
  if (requested === 'minor') return `${major}.${minor + 1}.0`
  if (requested === 'patch') return `${major}.${minor}.${patch + 1}`
  if (requested === 'beta') return beta === null
    ? `${major}.${minor}.${patch + 1}-beta.1`
    : `${major}.${minor}.${patch}-beta.${beta + 1}`
  if (requested === 'stable' && beta !== null) return `${major}.${minor}.${patch}`
  if (requested === 'stable') throw new Error(`Mod version ${current} is already stable.`)
  throw new Error(`Unknown bump type "${requested}". Use patch, minor, major, beta, stable, or x.y.z[-beta.n].`)
}

function replaceExactly(path, pattern, replacement, label) {
  const source = readFileSync(path, 'utf8')
  const matches = source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) || []
  if (matches.length !== 1) throw new Error(`Expected one ${label} in ${path}, found ${matches.length}.`)
  return source.replace(pattern, replacement)
}

const versionSource = readFileSync(VERSION_FILE, 'utf8')
const currentMatch = versionSource.match(/version\s*=\s*['"]([^'"]+)['"]/) 
if (!currentMatch) throw new Error('Could not read the current mod version.')

const current = currentMatch[1]
const next = nextVersion(current, process.argv[2] || 'patch')
if (next === current) throw new Error(`Mod version is already ${current}.`)

const updates = [
  {
    path: VERSION_FILE,
    pattern: new RegExp(`version\\s*=\\s*['\"]${current.replace(/\./g, '\\.')}['\"]`),
    replacement: `version = '${next}'`,
    label: 'Gradle mod version',
  },
  {
    path: LAUNCHER_MOD_VERSION_FILE,
    pattern: new RegExp(`IMPULSE_MOD_VERSION = ['"]${current.replace(/\./g, '\\.')}['"]`),
    replacement: `IMPULSE_MOD_VERSION = '${next}'`,
    label: 'launcher supported mod version',
  },
  ...[
    'forge-1.20.1/src/main/java/com/impulse/forge120/ImpulseForge120.java',
    'forge-1.21.1/src/main/java/com/impulse/forge121/ImpulseForge121.java',
    'neoforge-1.21.1/src/main/java/com/impulse/neoforge121/ImpulseNeoForge121.java',
  ].map((relative) => ({
    path: join(MOD_ROOT, relative),
    pattern: new RegExp(`return [\"]${current.replace(/\./g, '\\.')}[\"];`),
    replacement: `return "${next}";`,
    label: 'modern wrapper fallback version',
  })),
  ...[
    'forge-1.7.10/src/main/java/com/impulse/forge17/ImpulseForge17.java',
    'forge-1.12.2/src/main/java/com/impulse/forge112/ImpulseForge112.java',
  ].map((relative) => ({
    path: join(MOD_ROOT, relative),
    pattern: new RegExp(`VERSION = [\"]${current.replace(/\./g, '\\.')}[\"];`),
    replacement: `VERSION = "${next}";`,
    label: 'legacy wrapper version',
  })),
]

const prepared = updates.map((update) => ({
  path: update.path,
  content: replaceExactly(update.path, update.pattern, update.replacement, update.label),
}))
for (const update of prepared) writeFileSync(update.path, update.content)

console.log(`Impulse mod ${current} -> ${next}`)
console.log('Build and publish with: npm run release:mods')
