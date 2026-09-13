import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    const zip = new AdmZip()
    zip.addFile('META-INF/impulse-patch.json', Buffer.from(JSON.stringify(descriptor)))
    zip.addFile('META-INF/services/com.impulse.gamecompat.ImpulseCompatPatch', Buffer.from('example.Fixture\n'))
    zip.addFile('example/Fixture.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe]))
    zip.writeZip(jar)
    writeFileSync(metadataPath, JSON.stringify(metadata))
    return spawnSync(process.execPath, [script, jar, metadataPath], { encoding: 'utf8', timeout: 30_000 })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('publisher rejects a descriptor mismatch before R2', () => {
  const result = run(base, { id: 'wrong', version: '1.0.0', mode: 'live' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /descriptor id does not match/u)
})

test('publisher rejects a catalog invalid for the API before R2', () => {
  const result = run({ ...base, loaders: ['fabric'] })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Catalog validation failed before upload/u)
})
