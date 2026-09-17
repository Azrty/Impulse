# LivePatch Authoring Guide

Implementation reference for Impulse Standalone, reviewed September 12, 2026.

This guide describes the code currently in this repository, not the original
feature proposal. Examples are development fixtures, not production fixes.
Initial runtime support is **Standalone NeoForge 1.21.1, Java 21**. The catalog
schema accepting `forge` does not mean the Forge runtime integrates this system.

## Contents

1. [Capabilities and limits](#1-capabilities-and-limits)
2. [Architecture and lifecycle](#2-architecture-and-lifecycle)
3. [Create a patch project](#3-create-a-patch-project)
4. [Live patch example](#4-live-patch-example)
5. [Startup patch example](#5-startup-patch-example)
6. [Descriptors and services](#6-descriptors-and-services)
7. [Catalog and compatibility](#7-catalog-and-compatibility)
8. [Trust and integrity](#8-trust-and-integrity)
9. [Publishing](#9-publishing)
10. [Installation and controls](#10-installation-and-controls)
11. [Testing](#11-testing)
12. [Troubleshooting](#12-troubleshooting)
13. [Security and release checklist](#13-security-and-release-checklist)
14. [Operational limits](#14-operational-limits)
15. [Source map](#15-source-map)

## 1. Capabilities and limits

A patch is a JAR containing an Impulse service implementation and a small JSON
descriptor. It is downloaded separately from server-managed and personal mods.
Impulse does not rewrite their JAR files.

| Capability | Current behavior |
| --- | --- |
| Catalog source | Fixed HTTPS Presence API endpoint |
| Artifact integrity | SHA-512 and declared download size |
| Per-profile storage | Separate `patches/` directory and state file |
| Matching | Game version, loader, OS, architecture, installed mod IDs and versions |
| Live entry point | `enable(context)` and `disable()` |
| Startup entry point | `initialize(context)` before managed candidates are added |
| Startup class transformation | `ImpulseClassTransformer` via the early ModLauncher launch plugin |
| Managed reversible hook registrations | `PatchContext.registerHook(AutoCloseable)` |
| Arbitrary live class replacement | **Not provided** |
| Guaranteed class unloading | **Not provided** |
| Security sandbox | **Not provided** |

A classloader isolates class lookup; it does not restrict filesystem, network,
process, reflection, or other JVM permissions. Treat an approved patch as trusted
executable code running with the player's permissions.

**A `.patch.jar` suffix does not turn a regular mod into a patch.** A patch must
provide the correct Impulse service. A Mixin configuration alone is not loaded.
Use a live patch only for hooks you can unregister. Use a startup transformer for
bytecode changes; those changes remain until Minecraft exits.

## 2. Architecture and lifecycle

### Components

- **Presence API:** validates catalog metadata and signs the response.
- **Presence API:** signs the catalog and streams immutable patch JARs from its data directory.
- **Standalone helper:** displays offers, downloads patches, and saves choices.
- **Early ModLauncher plugin:** transforms explicitly authorized target classes.
- **NeoForge locator:** initializes enabled startup patches and registers transformers.
- **Impulse runtime:** initializes live patches and exposes in-game controls.

### Launch sequence

1. The helper reads the profile and checks catalog applicability against local
   JAR metadata.
2. During Play, profile preparation occurs before LivePatch's installed-patch
   update and offer checks.
3. Accepted patches download to the profile. The helper does **not** execute their
   live entry points when changing next-launch preferences.
4. Before discovery, ModLauncher loads the Impulse launch plugin. After profile
   selection, the locator re-authorizes enabled patches against the current catalog,
   initializes legacy startup providers, and registers declared transformer targets.
5. The Impulse mod constructor initializes enabled live providers.
6. Reaching the title screen clears the pending-attempt marker, but does not turn
   off an explicit recovery disable.

An offer installation currently returns to the selector; do not assume it
automatically resumes Play. A patch intended to change the helper's preceding
downloads or manifest discovery cannot do so through this startup entry point.

### Choose the mode

Use `live` only when all effects can be reliably reversed. Enabling may occur
during mod construction or through the in-game control, so do not assume a world,
player, network connection, or completed resource reload exists.

Use `startup` when initialization must happen before managed mod discovery.
There is no startup `disable()` callback. Changes require another Minecraft
process; the running loader cannot be unloaded and restarted.

### Class visibility

Each patch receives a `PatchClassLoader` with its JAR as the URL. It resolves
Impulse SPI classes through the API parent and falls back to NeoForge's game
classloader for live patches (the current context loader during early startup).
This improves visibility but does
not make every early-loading class available. Test against the packaged game;
missing target classes or late registration prevent activation.

Do not assume `compileOnly` on a target mod makes its classes accessible at
runtime. Verify linkage in a real packaged standalone launch. Keep static
initializers and constructors minimal to avoid premature resolution.

## 3. Create a patch project

Use a separate directory or repository. Example structure:

```text
example-live-patch/
  settings.gradle
  build.gradle
  libs/
    impulse-common.jar
  src/main/java/example/compat/ExampleLivePatch.java
  src/main/resources/META-INF/impulse-patch.json
  src/main/resources/META-INF/services/
    com.impulse.gamecompat.ImpulseCompatPatch
```

### Build the compile-time dependency

From `Impulse/mod`, with Java 21 available:

```sh
./gradlew -PimpulseTargets=neoforge-1.21.1 :common:jar
```

Use the resulting common JAR from `common/build/libs/` as the local
`libs/impulse-common.jar` dependency in your patch project. The exact output name
depends on the repository version. There is currently no documented public Maven
artifact for a standalone patch SDK.
For a startup transformer, also compile against the matching NeoForge 1.21.1
Impulse JAR and NeoForge/ASM APIs with `compileOnly`. The transformer SPI is in
the NeoForge bootstrap package, not the common JAR. Never shade those classes
into your patch.

`settings.gradle`:

```groovy
rootProject.name = 'example-live-patch'
```

`build.gradle`:

```groovy
plugins {
    id 'java-library'
}

group = 'example.compat'
version = '1.0.0'

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

dependencies {
    compileOnly files('libs/impulse-common.jar')
    testImplementation files('libs/impulse-common.jar')
}

tasks.withType(JavaCompile).configureEach {
    options.encoding = 'UTF-8'
}

tasks.named('jar') {
    archiveFileName = "example-live-${project.version}.patch.jar"
}

tasks.named('processResources') {
    inputs.property 'version', project.version
    filesMatching('META-INF/impulse-patch.json') {
        expand version: project.version
    }
}
```

Use the repository's Gradle version when generating a wrapper for this independent
project. Build with `./gradlew clean build` once that wrapper exists.

**Do not bundle the Impulse API classes in the patch.** Duplicate SPI classes can
cause service assignability and linkage failures. Do not bundle Minecraft,
NeoForge, or target-mod classes either.

The plain `jar` task does not package external runtime dependencies. Prefer a
dependency-free patch; otherwise deliberately package and relocate private
dependencies, include their licenses, and test parent-first resolution. There is
no patch dependency downloader or catalog dependency graph.

## 4. Live patch example

The exact interface is:

```java
package com.impulse.gamecompat;

public interface ImpulseCompatPatch {
    void enable(PatchContext context) throws Exception;
    void disable() throws Exception;
}
```

`PatchContext` exposes only:

```java
public File gameDirectory();
public String profileId();
public <T extends AutoCloseable> T registerHook(T registration);
```

The following fixture temporarily sets a namespaced JVM property. It demonstrates
state restoration and repeatable enable/disable, **not a Minecraft compatibility
fix**. Run it only in a disposable development instance.

```java
package example.compat;

import com.impulse.gamecompat.ImpulseCompatPatch;
import com.impulse.gamecompat.PatchContext;

public final class ExampleLivePatch implements ImpulseCompatPatch {
    private static final String KEY = "example.compat.liveFixture";
    private boolean enabled;

    public ExampleLivePatch() {}

    @Override
    public synchronized void enable(PatchContext context) {
        if (enabled) return;
        String previous = System.getProperty(KEY);
        System.setProperty(KEY, "enabled");
        context.registerHook(() -> {
            if ("enabled".equals(System.getProperty(KEY))) {
                if (previous == null) System.clearProperty(KEY);
                else System.setProperty(KEY, previous);
            }
        });
        enabled = true;
    }

    @Override
    public synchronized void disable() {
        if (!enabled) return;
        enabled = false;
    }
}
```

### Lifecycle requirements

- Provide one public implementation with a public no-argument constructor.
- Make repeated calls safe, even if current loader behavior usually avoids them.
- Record every acquired resource and reverse changes in reverse order.
- Make `disable()` safe after **partially failed** `enable()`.
- Keep callbacks short; do not block Minecraft on network calls or heavy disk I/O.
- Stop and join owned workers, unregister listeners, cancel tasks, and release
  textures on the correct thread if your integration owns such resources.
- Avoid retaining world/player/classloader references after disable.
- Never call `System.exit`, install shutdown policy, or change unrelated state.

Impulse calls `disable()`, closes registered hooks in reverse order, and closes
the patch loader. On partial activation, it attempts the same cleanup even for
service or linkage failures. A hook registration must be safe to close once.

Successful activation is keyed by `profileId:patchId`. A second enable is ignored
while that key is active. Disabling removes the entry, calls `disable()`, and
closes the patch classloader. A shutdown hook does the same on normal JVM exit.
Closing the classloader does not force JVM class unloading. Only registrations
owned through `registerHook` are automatically removed; clean up other resources
in `disable()`.

## 5. Startup patch example

The exact interface is:

```java
package com.impulse.gamecompat;

public interface ImpulseStartupPatch {
    void initialize(PatchContext context) throws Exception;
}
```

A safe no-op fixture for checking discovery:

```java
package example.compat;

import com.impulse.gamecompat.ImpulseStartupPatch;
import com.impulse.gamecompat.PatchContext;

public final class ExampleStartupPatch implements ImpulseStartupPatch {
    public ExampleStartupPatch() {}

    @Override
    public void initialize(PatchContext context) {
        System.out.println("[ExampleStartupPatch] Initialized");
    }
}
```

Use a separate JAR and descriptor with `mode: "startup"` for this fixture.
Do not reference Minecraft classes in its static initialization. Startup loaders
are retained for the process lifetime; there is no supported hot reload.

Startup initialization errors are logged and the loader continues without the
affected transformation. Do not rely on partially applied fixes; test the
packaged runtime and keep the target set small.

### Startup class transformation

For bytecode changes, compile against the NeoForge 1.21.1 development JAR and
implement `com.impulse.bootstrap.neoforge121.ImpulseClassTransformer`. Do not
bundle Impulse, ASM, Minecraft, NeoForge, or target-mod classes in the patch.

```java
package example.compat;

import com.impulse.bootstrap.neoforge121.ImpulseClassTransformer;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.FieldNode;
import java.util.Set;

public final class ExampleTransformer implements ImpulseClassTransformer {
    public Set<String> targetClasses() { return Set.of("example.target.TargetClass"); }

    public void transform(String className, ClassNode node) {
        // Disposable fixture only; use a real, version-pinned compatibility fix.
        node.fields.add(new FieldNode(Opcodes.ACC_PUBLIC, "impulseFixture", "Z", null, null));
    }
}
```

Add `META-INF/services/com.impulse.bootstrap.neoforge121.ImpulseClassTransformer`
containing `example.compat.ExampleTransformer`. The release metadata **and**
embedded descriptor must both contain:

```json
"target_classes": ["example.target.TargetClass"]
```

The declared targets must exactly equal `targetClasses()` at registration.
Impulse registers them after the profile selector but before managed mod
discovery. A class already seen by ModLauncher is rejected. The plugin runs
transformers on a copy of each `ClassNode` and discards a failed transformation
instead of leaving a partially modified class. It does not support live class
replacement or arbitrary Mixin registration. Startup patch changes require a
fresh Minecraft process to disable.

## 6. Descriptors and services

### Embedded descriptor

`src/main/resources/META-INF/impulse-patch.json`:

```json
{
  "id": "example-live",
  "version": "${version}",
  "mode": "live"
}
```

Gradle expands `${version}` in this example. The final JAR must contain a literal
version such as `1.0.0`, not the placeholder.

The installer compares **id, version, and mode** with the selected catalog entry.
For a transformer, it also compares the complete `target_classes` list.
These fields must match exactly. Extra descriptor fields do not create new
capabilities or targeting rules.

### Java service registration

For live patches, create a text file named exactly:

```text
META-INF/services/com.impulse.gamecompat.ImpulseCompatPatch
```

Its content is the fully qualified implementation name followed by a newline:

```text
example.compat.ExampleLivePatch
```

For startup patches, use:

```text
META-INF/services/com.impulse.gamecompat.ImpulseStartupPatch
```

with `example.compat.ExampleStartupPatch` as its content.
Transformer-only startup patches use the `ImpulseClassTransformer` service
above instead. A startup JAR may expose both services.

Use **one provider per patch JAR**. The loader chooses the first discovered
provider, not every entry. Do not rely on provider ordering or another patch's
initialization order. Service filenames and class names are case-sensitive.

### Inspect the artifact

```sh
jar tf build/libs/example-live-1.0.0.patch.jar
unzip -p build/libs/example-live-1.0.0.patch.jar META-INF/impulse-patch.json
unzip -p build/libs/example-live-1.0.0.patch.jar \
  META-INF/services/com.impulse.gamecompat.ImpulseCompatPatch
```

Check that compiled classes, descriptor, and service file are present and that
`com/impulse/gamecompat/` classes are absent.

## 7. Catalog and compatibility

### Publication metadata

Put the complete publication metadata in the embedded descriptor:

```json
{
  "id": "example-live",
  "name": "Example live fixture",
  "description": "Development-only lifecycle fixture. Not a gameplay fix.",
  "version": "1.0.0",
  "mode": "live",
  "minecraft_versions": ["1.21.1"],
  "loaders": ["neoforge"],
  "operating_systems": ["any"],
  "architectures": ["any"],
  "required_mods": [
    { "id": "example_target", "version_range": "1.0.0" }
  ]
}
```

`example_target` is deliberately fictional. Replace it with the actual target ID
and a tested version before trying the offer flow. There is no unconditional
all-clients patch: `required_mods` must be nonempty.

The Presence API derives `file_name`, `download_url`, `sha512`, and `size`
from the built JAR. Do not put them in the descriptor.

### Field reference

| Field | Requirements |
| --- | --- |
| `id` | Up to 80 characters; API regex `[a-z0-9][a-z0-9-]{0,79}`; use lowercase letters, digits, and hyphens |
| `name` | Nonempty text, API maximum 120 characters |
| `description` | Nonempty text, API maximum 500 characters |
| `version` | Numeric `major.minor.patch`, optional prerelease suffix; maximum 64 characters in API |
| `mode` | Exactly `live` or `startup` |
| `minecraft_versions` | Nonempty list of exact versions |
| `loaders` | `neoforge` or `forge`; runtime support is narrower than the schema |
| `operating_systems` | `windows`, `macos`, `linux`, or `any` |
| `architectures` | `x64`, `arm64`, or `any` |
| `required_mods` | Nonempty list of `{id, version_range}` objects; all must match |
| `target_classes` | Startup transformer only; 1-64 explicit binary class names |

The API limits each targeting list to 32 entries. String-list values have an
80-character bound. Required mod IDs allow lowercase letters, digits, `_`, `.`,
and `-`, with a 128-character limit; ranges have an 80-character limit.

The publisher also accepts dots and underscores in patch IDs, but the API does
not. Follow the stricter API rule above to avoid uploading an unusable entry.

### Matching rules

Minecraft and loader matches are exact. `any` applies only to OS/architecture,
not game versions or loaders. Every required mod must be present and satisfy
its range: the list is an **AND**, not an OR.

The client scans immediate `.jar` children in this order:

1. `<gameDir>/mods/`
2. `<gameDir>/impulse/standalone/<profile-id>/mods/`
3. `<gameDir>/impulse/standalone/<profile-id>/custom_mods/`

It reads `META-INF/neoforge.mods.toml`, falling back to `META-INF/mods.toml`.
No installed-mod inventory is sent to the catalog API.

The scanner parses each JAR's TOML `[[mods]]` entries with NightConfig and
resolves `${file.jarVersion}` from the JAR manifest. Dependency tables are not
mistaken for provided mod IDs. It is still a pre-discovery filesystem scan, not
NeoForge's final resolved mod list: nested JarJar contents are not inspected,
duplicate IDs use the first value encountered, and optional JARs left on disk
can be detected even when not loaded.

### Version ranges

The parser supports exact strings, `*`, whitespace-separated comparisons, and
Maven-like two-bound intervals. Examples of its intended syntax:

```text
1.0.0
*
>1.0.0 <2.0.0
[1.0.0,2.0.0)
(,2.0.0]
[1.0.0,)
```

Do not use caret/tilde ranges, `1.x`, unions, or npm SemVer expressions.
Prefer exact versions or tested numeric intervals for production.

Numeric identifiers are compared numerically, releases sort after prereleases,
and `>=`/`<=` include their boundaries. This is still not a general npm SemVer
range parser: only the syntax shown above is supported. Pin tested versions.

For a patch ID, the client selects the highest applicable version using this
comparator. There is no separate Stable/Beta patch channel, no patch-to-patch
dependency resolution, and no explicit patch conflict graph.

## 8. Trust and integrity

LivePatch uses the fixed HTTPS Presence API origin and accepts artifacts only
from its `/v1/game-compat/files/` endpoint. The API scans
`presence-api/data/game-compat-files/` for `.patch.jar` files, validates each
embedded descriptor and its required service entry, calculates the SHA-512 and
size, then generates the catalog at request time. Before any JAR is loaded,
Standalone recalculates the declared SHA-512 hash locally.

There is no separate key or signing-secret setup. HTTPS and the security of
`api.impulsemc.com` protect the catalog; the SHA-512 value protects the downloaded
artifact against corruption or an unexpected file response.

### Endpoint overrides and caching

`-Dimpulse.gameCompat.api=<url>` changes the catalog endpoint only. It does not
relax the production artifact-host restriction.

The client accepts catalog bodies up to 2 MiB, uses 5-second connect and
10-second read timeouts, and keeps successful catalogs in memory for 15 minutes.
Signed disk-cache files are under:

```text
impulse/standalone/cache/game-compat/catalog.json
```

The cache file is an atomic envelope containing the catalog body and fetch time.
The Java client currently expects HTTP 200
and does not send `If-None-Match`. Offline fallback is allowed only for seven
days after a valid fetch; expired data cannot activate patches.
Older cache files remain on disk but are not authorization sources. An online
revocation takes effect at the next catalog refresh (up to 15 minutes
in one process); a disconnected client may continue using the last cached
catalog for at most seven days.

## 9. Publishing

Only an authorized Impulse release operator should perform these steps. Patch
authors should submit source, metadata, test results, and a reproducible artifact
for review.

### Prepare

1. Choose a unique ID and a new, immutable versioned filename.
2. Put all publication metadata in the embedded descriptor.
3. Inspect the service file and compile without bundled SPI classes.
4. Test the patch against each advertised target, including disable/failure paths.
5. Review source and dependencies for permissions, licenses, and unwanted effects.

### Build and deploy

The Gradle `jar` task copies the versioned `.patch.jar` to
`presence-api/data/game-compat-files/`. Commit that artifact with the API and
deploy the API normally. No publishing command, R2 upload, sidecar metadata,
or hand-maintained catalog is involved. The API will reject a JAR that does not
contain a complete `META-INF/impulse-patch.json` and the appropriate live or
startup service entry.

Never overwrite a released filename. Immutable
HTTP caches can retain the old bytes and cause hash failures. Increment the version
and use a new filename for every changed artifact.

### Validate and deploy

From `Impulse/presence-api`:

```sh
npm test
npm run build
```

Review the generated endpoint response and deploy the patch JAR from the API
data directory using the existing deployment procedure. A running API rescans
patch artifacts on requests; invalid JARs are ignored and logged while the last
valid catalog remains available.

Confirm the public response:

```sh
curl --fail --show-error -D /tmp/game-compat-headers.txt \
  https://api.impulsemc.com/v1/game-compat/patches \
  -o /tmp/game-compat-catalog.json
```

Download the artifact from its `download_url` on `api.impulsemc.com`; check its
exact size and SHA-512 against the catalog. Test with an unmodified trusted
client before publishing.

### Rollout and rollback

Start with a narrow, tested target and a disposable instance. Keep previously
released artifacts available. There is no staged rollout percentage or automatic
remote disable command in the current patch schema.

Removing an entry prevents activation on the next successful catalog refresh.
Offline clients may continue using a previously cached catalog for seven days.
For urgent incidents, also publish client-facing operational guidance and retain
evidence; deleting the API artifact is not a substitute for catalog revocation.

## 10. Installation and controls

Files live under:

```text
<gameDir>/impulse/standalone/<profile-id>/
  patches/
    example-live-1.0.0.patch.jar
  game-compat.json
```

Downloads use `.part` files, three attempts, and a 500/1000/1500 ms sleep schedule
after failed attempts. Download processing is sequential, not the four-worker
server-mod downloader. All selected artifacts are downloaded and verified in
staging before active state changes. The installer restores previous files on
commit failure, publishes state atomically, then removes obsolete old versions.
Automatic updates preserve disabled patches as disabled.

Installed state records ID, name, version, mode, filename, SHA-512, and enabled
status. Other fields track dismissed offers and startup recovery. Do not hand-edit
this file during normal use. Dropping a JAR into `patches/` alone does not register
it; the loader uses installed state, not unrestricted folder discovery.

### Standalone menu

The WebView's **LivePatch** menu is profile-specific. It lists catalog matches
and installed entries, permits installation/updates, and saves enabled state for
the next launch. Those toggles must not execute patch code in the helper process.

### In-game menu

Live switches call the patch lifecycle in the Minecraft process. Startup changes
require a restart. `Active` means activation was confirmed in this process;
`Pending` and `Restart required` distinguish saved preferences from loaded code.

### Recovery

Before authorized startup patches run, Impulse writes a pending-attempt marker.
The title screen clears it. A subsequent launch may offer recovery when it finds
that marker. This detects an interrupted startup involving a patch, **not proof**
that the patch caused the problem. Recovery disables patches until the player
uses **Restore patches next launch** in LivePatch. Reaching the title screen
does not clear recovery mode. Disable or remove a suspect patch before restoring.

## 11. Testing

### Local fixture tests

Test the live example directly with a temporary `PatchContext` and assertions:

- Enable sets its fixture property.
- A second enable makes no additional change.
- Disable restores an absent or existing previous value.
- A second disable is harmless.
- External changes after enable are preserved.

For a real patch, add tests for partial initialization, repeated cycles, failures
in cleanup, target API changes, and callbacks racing with disable. Use a temporary
directory, not a real player's profile.

### Service packaging smoke test

With Java 21 and both the common JAR and patch JAR on the test classpath, use
`ServiceLoader.load(ImpulseCompatPatch.class)` (or `ImpulseStartupPatch.class`)
and assert exactly one expected provider is found. Do not use production profiles
or real accounts for this test.

A classpath smoke test does not validate NeoForge's module/classloader behavior.
Always follow it with a packaged standalone run.

### Integration matrix

| Area | Required cases |
| --- | --- |
| Catalog | Valid revision, changed/reused revision, malformed data, offline API |
| Targeting | Matching/nonmatching Minecraft, loader, OS, architecture, missing mod |
| Versions | Lower/upper boundary, exact version, prerelease, unresolved metadata |
| JAR | Missing descriptor, mismatched descriptor, absent/wrong service, broken class |
| Download | Interrupted stream, wrong size, corrupt hash, unavailable API artifact |
| Lifecycle | Enable, disable, repeated toggles, partial failure, resource cleanup |
| Startup | Success, initialization exception, interrupted launch, recovery |
| Update | Changed filename, disabled patch, failed update, old artifact retained |
| Profiles | Two profiles with independent states and the same patch ID |
| Regression | No patches installed; launcher-managed launch still bypasses standalone |

Build repository checks from `Impulse/mod`:

```sh
./gradlew -PimpulseTargets=neoforge-1.21.1 \
  :common:check :standalone-ui:check :neoforge-1.21.1:build
```

Existing LivePatch unit tests cover a small set of version-range/comparison
cases. They are not a comprehensive integrity, targeting, lifecycle, rollback,
or resource-leak test suite. Do not label a patch production-ready solely because
this command succeeds.

## 12. Troubleshooting

| Symptom | Inspect |
| --- | --- |
| No offered patch | Exact game/loader, every required mod, TOML metadata, OS/arch lists |
| Catalog unavailable / HTTP 503 | API reachability, catalog JSON, API server logs |
| Download URL not trusted | HTTPS `api.impulsemc.com/v1/game-compat/files/` path; local override does not relax artifact origin |
| SHA-512 validation failure | Reused immutable filename, partial file, artifact/index mismatch |
| Missing descriptor | Resource path or Gradle packaging omission |
| Metadata does not match | Embedded id/version/mode differs from selected entry |
| No service provider | Exact service filename, class name, public constructor, mode |
| ClassNotFoundException | Game loader visibility, target loaded too early, omitted private dependency |
| ServiceConfigurationError | Duplicate API classes, wrong interface, constructor or class linkage failure |
| Patch says Pending | Enabled for a later runtime phase, but not activated yet |
| Removed catalog entry still runs | In-memory refresh up to 15 minutes, cached offline catalog up to seven days |
| Recovery repeats | Restore only after disabling the suspect patch; inspect prior launch logs |

Inspect per-launch `impulse.log` under `impulse/standalone/logs/`, helper
`impulse/standalone/ui/latest.log`, and Minecraft logs. Relevant messages use
the `game-compat` phase, including activation and update failures. Redact paths,
tokens, identities, and private server details before sharing diagnostics.

## 13. Security and release checklist

- Review the full source and dependency tree; a catalog entry is not a safety review.
- Require reproducible artifacts and preserve the reviewed source revision.
- Use a unique versioned filename and never mutate published bytes.
- Target only tested versions; broad `*` ranges increase blast radius.
- Do not send the installed-mod list or player identifiers from patch code.
- Do not add telemetry, network endpoints, or permissions without explicit review.
- Verify cleanup and provide an operational disable procedure.
- Test with the real packaged client, not just an IDE/classpath harness.
- Verify the public catalog and artifact after deployment.
- Do not promise instant offline revocation, sandboxing, or hot class replacement.

## 14. Operational limits

- Live patches can only reverse hooks and resources they explicitly register or
  clean up; they cannot unload or rewrite an already loaded class.
- Startup transforms must be registered before ModLauncher sees their target.
  Targets loaded earlier than profile selection are not patchable by this API.
- Cached catalogs can authorize an installed patch offline for seven days.
  Revocation is not instantaneous while a client is disconnected.
- Metadata scanning happens before NeoForge finishes resolution. JarJar contents
  and runtime decisions made by other mods are outside this scanner's view.
- The Java classloader is not a permission sandbox. A reviewed patch is trusted
  code; HTTPS and SHA-512 establish delivery integrity, not safety.

## 15. Source map

Paths are relative to the repository root:

| Source | Responsibility |
| --- | --- |
| `mod/common/src/main/java/com/impulse/gamecompat/ImpulseCompatPatch.java` | Live SPI |
| `mod/common/src/main/java/com/impulse/gamecompat/ImpulseStartupPatch.java` | Startup SPI |
| `mod/common/src/main/java/com/impulse/gamecompat/PatchContext.java` | Available context |
| `mod/common/src/main/java/com/impulse/gamecompat/PatchClassLoader.java` | SPI/game class visibility |
| `mod/common/src/main/java/com/impulse/gamecompat/ImpulseGameCompat.java` | Catalog, state, matching, downloads, lifecycle |
| `mod/neoforge-1.21.1/src/main/java/com/impulse/bootstrap/neoforge121/ImpulseClassTransformer.java` | Startup transformation SPI |
| `mod/neoforge-1.21.1/src/main/java/com/impulse/bootstrap/neoforge121/ImpulseLaunchPlugin.java` | Early ModLauncher transformation dispatch |
| `mod/neoforge-1.21.1/src/main/java/com/impulse/bootstrap/neoforge121/ImpulseStandaloneLocator.java` | Startup integration |
| `mod/neoforge-1.21.1/src/main/java/com/impulse/neoforge121/ImpulseNeoForge121.java` | Live initialization |
| `mod/modern-1.21-client/src/main/java/com/impulse/modern121/ImpulseStandaloneClient121.java` | In-game controls and readiness |
| `mod/standalone-ui/src/main/java/com/impulse/standalone/ui/ImpulseStandaloneUi.java` | Helper bridge and Play flow |
| `mod/standalone-ui/web/src/App.tsx` | Offers and standalone manager |
| `presence-api/src/server.ts` | Catalog validation and HTTP endpoint |
| `presence-api/data/game-compat-files/*.patch.jar` | Versioned patch artifacts and embedded publication metadata |

When updating the SPI, catalog format, integrity policy, or lifecycle, revise this
guide and its examples together with the implementation.
