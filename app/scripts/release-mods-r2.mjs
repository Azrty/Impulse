import { createHash } from 'crypto'
import { execFileSync, spawnSync } from 'child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { basename, join } from 'path'
import { fileURLToPath } from 'url'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { loadEnv, requireEnv, IMPULSE_R2_ACCOUNT_ID, IMPULSE_R2_BUCKET } from './release-lib.mjs'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MOD_ROOT = join(APP_ROOT, '..', 'mod')
const DIST = join(MOD_ROOT, 'dist')
const PUBLIC_ORIGIN = process.env.IMPULSE_MOD_ORIGIN || 'https://impulse.epivalent.com'
const SKIP_BUILD = process.argv.includes('--skip-build')
const BUILD_ONLY = process.argv.includes('--build-only')
const VERSION_OVERRIDE = process.argv.find((arg) => arg.startsWith('--version='))?.slice('--version='.length)
const ARTIFACT_OVERRIDE = process.argv.find((arg) => arg.startsWith('--artifact='))?.slice('--artifact='.length)

const allTargets = [
  { project: 'forge-1.20.1', minecraft: '1.20.1', loader: 'forge', java: 17, gradle: 'wrapper' },
  { project: 'forge-1.21.1', minecraft: '1.21.1', loader: 'forge', java: 25, toolchain: 21, gradle: '9.3.0' },
  { project: 'neoforge-1.21.1', minecraft: '1.21.1', loader: 'neoforge', java: 21, gradle: 'wrapper' },
]

function requestedTargetNames() {
  const cliValue = process.argv.find((arg) => arg.startsWith('--targets='))?.slice('--targets='.length)
    || process.argv.find((arg) => arg.startsWith('--target='))?.slice('--target='.length)
  const value = cliValue || process.env.IMPULSE_MOD_TARGETS || 'neoforge-1.21.1'
  return value.split(',').map((target) => target.trim()).filter(Boolean)
}

function selectTargets() {
  const names = requestedTargetNames()
  const known = new Map(allTargets.map((target) => [target.project, target]))
  return names.map((name) => {
    const target = known.get(name)
    if (!target) throw new Error(`Unknown mod release target "${name}". Known targets: ${allTargets.map((item) => item.project).join(', ')}`)
    return target
  })
}

function version() {
  if (VERSION_OVERRIDE) {
    if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(VERSION_OVERRIDE)) throw new Error(`Invalid release version "${VERSION_OVERRIDE}".`)
    return VERSION_OVERRIDE
  }
  const source = readFileSync(join(MOD_ROOT, 'build.gradle'), 'utf8')
  const match = source.match(/version\s*=\s*['"]([^'"]+)['"]/) 
  if (!match) throw new Error('Could not read the Impulse mod version from mod/build.gradle.')
  return match[1]
}

function javaHome(major) {
  const configured = process.env[`JAVA${major}_HOME`] || (major === 21 ? process.env.JAVA_HOME : '')
  if (configured && existsSync(configured)) return configured
  const homebrewCandidates = [
    `/opt/homebrew/opt/openjdk@${major}/libexec/openjdk.jdk/Contents/Home`,
    `/usr/local/opt/openjdk@${major}/libexec/openjdk.jdk/Contents/Home`,
  ]
  for (const candidate of homebrewCandidates) if (existsSync(candidate)) return candidate
  if (process.platform === 'darwin') {
    const selector = major === 8 ? '1.8' : String(major)
    try {
      return execFileSync('/usr/libexec/java_home', ['-v', selector], { encoding: 'utf8' }).trim()
    } catch {
      // The actionable error below names the expected environment variable.
    }
  }
  throw new Error(`Java ${major} was not found. Set JAVA${major}_HOME before running the mod release.`)
}

function gradleExecutable(version) {
  if (version === 'wrapper') return process.platform === 'win32' ? join(MOD_ROOT, 'gradlew.bat') : join(MOD_ROOT, 'gradlew')
  const tools = join(MOD_ROOT, '.release-tools')
  const directory = join(tools, `gradle-${version}`)
  const executable = join(directory, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle')
  if (existsSync(executable)) return executable
  if (process.platform === 'win32') throw new Error(`Gradle ${version} is required at ${directory}. Automatic tool setup currently runs on macOS/Linux.`)
  mkdirSync(tools, { recursive: true })
  const archive = join(tools, `gradle-${version}-bin.zip`)
  execFileSync('curl', ['-fL', `https://services.gradle.org/distributions/gradle-${version}-bin.zip`, '-o', archive], { stdio: 'inherit' })
  execFileSync('unzip', ['-q', '-o', archive, '-d', tools], { stdio: 'inherit' })
  if (!existsSync(executable)) throw new Error(`Gradle ${version} could not be prepared.`)
  return executable
}

function buildTarget(target) {
  const executable = gradleExecutable(target.gradle)
  console.log(`\n▶ Building ${target.project} with Java ${target.java}${target.toolchain ? ` and Java ${target.toolchain} toolchain` : ''}`)
  const args = [
    '--no-daemon',
    `-PimpulseTargets=${target.project}`,
    `:${target.project}:clean`,
    `:${target.project}:build`,
  ]
  if (target.toolchain) args.splice(1, 0, `-Dorg.gradle.java.installations.paths=${javaHome(target.toolchain)}`)
  const result = spawnSync(executable, args, {
    cwd: MOD_ROOT,
    env: { ...process.env, JAVA_HOME: javaHome(target.java) },
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error(`${target.project} build failed with exit code ${result.status}.`)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function artifactFor(target, releaseVersion) {
  const fileName = `impulse-${target.project}-${releaseVersion}.jar`
  if (ARTIFACT_OVERRIDE) {
    if (!existsSync(ARTIFACT_OVERRIDE)) throw new Error(`Missing release artifact: ${ARTIFACT_OVERRIDE}`)
    return { path: ARTIFACT_OVERRIDE, fileName }
  }
  const path = join(MOD_ROOT, target.project, 'build', 'libs', fileName)
  if (!existsSync(path)) throw new Error(`Missing release artifact: ${path}`)
  return { path, fileName }
}

async function bodyText(body) {
  if (!body) return ''
  if (typeof body.transformToString === 'function') return body.transformToString()
  const chunks = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function existingIndex(client, bucket, key) {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const parsed = JSON.parse(await bodyText(response.Body))
    return Array.isArray(parsed.releases) ? parsed.releases : []
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode
    if (status && status !== 404) console.warn(`Could not read ${key}: ${error.message}`)
    return []
  }
}

function releaseChannel(release) {
  if (release?.channel === 'stable' || release?.channel === 'beta') return release.channel
  return String(release?.version || '').includes('-') ? 'beta' : 'stable'
}

function mergeReleases(candidates, supportedTargets, allowedChannels) {
  const merged = new Map()
  for (const item of candidates) {
    const target = `${item?.loader}:${item?.minecraft_version}`
    const key = `${target}:${item?.version}`
    if (!supportedTargets.has(target) || !allowedChannels.has(releaseChannel(item)) || merged.has(key)) continue
    merged.set(key, { ...item, channel: releaseChannel(item) })
  }
  return [...merged.values()].sort((a, b) =>
    `${a.loader}:${a.minecraft_version}:${b.version}`.localeCompare(
      `${b.loader}:${b.minecraft_version}:${a.version}`,
      undefined,
      { numeric: true },
    ))
}

async function upload(client, bucket, key, body, contentType, cacheControl) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl,
  }))
  console.log(`✓ Uploaded ${key}`)
}

async function main() {
  loadEnv()
  if (!BUILD_ONLY) requireEnv('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
  const releaseVersion = version()
  const targets = selectTargets()
  if (ARTIFACT_OVERRIDE && targets.length !== 1) throw new Error('--artifact requires exactly one release target.')
  if (!SKIP_BUILD) targets.forEach(buildTarget)

  mkdirSync(DIST, { recursive: true })
  const releases = targets.map((target) => {
    const artifact = artifactFor(target, releaseVersion)
    const output = join(DIST, artifact.fileName)
    copyFileSync(artifact.path, output)
    const checksum = sha256(output)
    writeFileSync(`${output}.sha256`, `${checksum}  ${artifact.fileName}\n`)
    return {
      version: releaseVersion,
      channel: releaseVersion.includes('-') ? 'beta' : 'stable',
      minecraft_version: target.minecraft,
      loader: target.loader,
      file_name: artifact.fileName,
      download_url: `${PUBLIC_ORIGIN}/mods/${encodeURIComponent(artifact.fileName)}`,
      sha256: checksum,
      size: readFileSync(output).length,
    }
  })

  const accountId = process.env.IMPULSE_R2_ACCOUNT_ID || IMPULSE_R2_ACCOUNT_ID
  const bucket = process.env.IMPULSE_R2_BUCKET || IMPULSE_R2_BUCKET
  const client = BUILD_ONLY ? null : new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  })

  const previousStable = client ? await existingIndex(client, bucket, 'mods/index.json') : []
  const previousBeta = client ? await existingIndex(client, bucket, 'mods/beta-index.json') : []
  const supportedTargets = new Set(targets.map((target) => `${target.loader}:${target.minecraft}`))
  const stableReleases = mergeReleases(
    [...releases, ...previousStable],
    supportedTargets,
    new Set(['stable']),
  )
  const betaReleases = mergeReleases(
    [...releases, ...previousBeta, ...previousStable],
    supportedTargets,
    new Set(['stable', 'beta']),
  )
  const generatedAt = new Date().toISOString()
  const stableIndex = {
    schema_version: 1,
    generated_at: generatedAt,
    releases: stableReleases,
  }
  const betaIndex = {
    schema_version: 1,
    generated_at: generatedAt,
    releases: betaReleases,
  }
  const stableIndexBody = `${JSON.stringify(stableIndex, null, 2)}\n`
  const betaIndexBody = `${JSON.stringify(betaIndex, null, 2)}\n`
  writeFileSync(join(DIST, 'index.json'), stableIndexBody)
  writeFileSync(join(DIST, 'beta-index.json'), betaIndexBody)
  const checksumBody = releases.map((item) => `${item.sha256}  ${item.file_name}`).join('\n') + '\n'
  writeFileSync(join(DIST, 'checksums.sha256'), checksumBody)

  if (!client) {
    console.log(`\n✅ Built and indexed Impulse mod ${releaseVersion} for ${releases.length} loader targets. No files were uploaded.`)
    return
  }

  for (const release of releases) {
    const path = join(DIST, release.file_name)
    await upload(client, bucket, `mods/${release.file_name}`, readFileSync(path), 'application/java-archive', 'public, max-age=31536000, immutable')
    await upload(client, bucket, `mods/${release.file_name}.sha256`, readFileSync(`${path}.sha256`), 'text/plain; charset=utf-8', 'public, max-age=31536000, immutable')
  }
  await upload(client, bucket, 'mods/checksums.sha256', checksumBody, 'text/plain; charset=utf-8', 'no-cache')
  await upload(client, bucket, 'mods/index.json', stableIndexBody, 'application/json; charset=utf-8', 'no-cache')
  await upload(client, bucket, 'mods/beta-index.json', betaIndexBody, 'application/json; charset=utf-8', 'no-cache')
  console.log(`\n✅ Published Impulse mod ${releaseVersion} for ${releases.length} loader targets.`)
}

main().catch((error) => {
  console.error(`\n❌ ${error.stack || error.message || error}`)
  process.exit(1)
})
