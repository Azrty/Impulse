import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import AdmZip from 'adm-zip'

const script = fileURLToPath(new URL('./publish-game-compat-patch.mjs', import.meta.url))
const base = {
  id: 'fixture', name: 'Fixture', description: 'Fixture patch', version: '1.0.0', mode: 'live',
  minecraft_versions: ['1.21.1'], loaders: ['neoforge'], operating_systems: ['any'],
  architectures: ['any'], required_mods: [{ id: 'example', version_range: '*' }],
}

function run(metadata, descriptor = { id: 'fixture', version: '1.0.0', mode: 'live' }) {
  const directory = mkdtempSync(join(tmpdir(), 'impulse-patch-test-'))
  try {
    const jar = join(directory, 'fixture-1.0.0.patch.jar')
    const metadataPath = join(directory, 'metadata.json')
    const catalogPath = join(directory, 'catalog.json')
    const filesDirectory = join(directory, 'files')
    writeFileSync(catalogPath, '{"schema_version":1,"revision":1,"patches":[]}\n')
    const zip = new AdmZip()
    zip.addFile('META-INF/impulse-patch.json', Buffer.from(JSON.stringify(descriptor)))
    zip.addFile('META-INF/services/com.impulse.gamecompat.ImpulseCompatPatch', Buffer.from('example.Fixture\n'))
    zip.addFile('example/Fixture.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe]))
    zip.writeZip(jar)
    writeFileSync(metadataPath, JSON.stringify(metadata))
    const result = spawnSync(process.execPath, [script, jar, metadataPath], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, GAME_COMPAT_CATALOG_FILE: catalogPath, GAME_COMPAT_FILES_DIRECTORY: filesDirectory },
    })
    return {
      ...result,
      catalog: JSON.parse(readFileSync(catalogPath, 'utf8')),
      files: existsSync(filesDirectory) ? readdirSync(filesDirectory) : [],
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('publisher rejects a descriptor mismatch before writing an artifact', () => {
  const result = run(base, { id: 'wrong', version: '1.0.0', mode: 'live' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /descriptor id does not match/u)
  assert.deepEqual(result.files, [])
})

test('publisher rejects a catalog invalid for the API before writing an artifact', () => {
  const result = run({ ...base, loaders: ['fabric'] })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Catalog validation failed before publication/u)
  assert.deepEqual(result.files, [])
})

test('publisher stores a patch and updates the Presence API catalog without R2 credentials', () => {
  const result = run(base)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.files, ['fixture-1.0.0.patch.jar'])
  assert.equal(result.catalog.revision, 2)
  assert.equal(result.catalog.patches[0].download_url,
    'https://api.impulsemc.com/v1/game-compat/files/fixture-1.0.0.patch.jar')
})
