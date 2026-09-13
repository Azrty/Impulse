# Mounted Mekanism client patch

This startup-only Impulse Game Compat patch targets NeoForge 1.21.1 with both
Mekanism `10.7.19` through `10.7.x` and `create_mekanism_compat` `0.1.21`.
Both requirements must match. The server can keep the original 2b2m mod JAR.

The patch replaces the old client's teleporter tracking and sublevel lookup
with the client implementations from [Azrty's fork at commit 452ac83](https://github.com/Azrty/CreateAeronauticsMekanismCompat/tree/452ac83d28f38f692cec0fdcfd1a21202f864453).
It retries teleports when a Sable sublevel reaches the client later, avoids
pinning the player to an obsolete plot position, and corrects the mounted
position shown by the Dimensional Stabilizer GUI. The three `.class` files in
`src/main/resources/templates/` were extracted from that commit's locally
built `create_mekanism_compat-0.1.21.jar`; they are bytecode templates applied
to the existing client classes, **not** an extra copy of the mod loaded as a
NeoForge candidate. The corresponding source is in the linked fork. Its MIT
notice is included in the patch JAR.
The templates were compiled with Mekanism `10.7.19.85` and Sable `2.0.5`.

The patch does not target Digital Miner. It cannot backport the fork's
server-side teleporter frequency cache, chunk tickets, or portable teleporter
handling. Those still behave as the original 2b2m server mod does.

## Build and test

Build Impulse NeoForge 1.21.1 first. From this directory:

```sh
../../gradlew -p . check jar
```

To test against actual installed JARs as well as synthetic fixtures, add:

```sh
-PoriginalCompatJar=/path/to/create_mekanism_compat-0.1.21.jar \
-PmekanismJar=/path/to/Mekanism-1.21.1-10.7.19.85.jar
```

The artifact is `build/libs/aero-mekanism-client-1.0.1.patch.jar`.
Do not put it in Minecraft's `mods/` folder. It is installed by Game Compat.

## Publish

1. Test in a disposable Standalone profile with the original 2b2m JAR and the
   target Mekanism/Sable versions. Confirm teleporting into a mounted sublevel,
   delayed tracking, leaving it, reconnecting, and the stabilizer GUI. Confirm
   the server still runs its original JAR and Digital Miner behavior is unchanged.
2. Build the patch from this directory. The build automatically copies the
   resulting JAR into the Presence API patch directory:

   ```sh
   ../../gradlew -p . check jar
   ```

3. Commit and deploy `presence-api/data/game-compat-files/aero-mekanism-client-1.0.1.patch.jar`.
   The API reads its complete publication metadata from
   `META-INF/impulse-patch.json`, calculates SHA-512 itself, and exposes the
   patch automatically. There is no separate metadata file or publish command.
4. In Standalone, select the server, accept the Game Compat offer, install the
   patch, then restart Minecraft to activate a startup patch. The in-game Game
   Compat screen can disable it for the next launch.

The full authoring and recovery rules are in
[`docs/GAME_COMPAT_PATCH_AUTHORING.md`](../../../docs/GAME_COMPAT_PATCH_AUTHORING.md).
