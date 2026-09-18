package com.impulse.common;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public final class ImpulseMigrationTest {
    public static void main(String[] args) throws Exception {
        selectsNewestStableErozionGoReleaseWithoutComparingImpulseVersion();
        recognizesLegacyModeFromStandaloneSettings();
    }

    private static void selectsNewestStableErozionGoReleaseWithoutComparingImpulseVersion() {
        ImpulseMigrationInstaller.Index index = new ImpulseMigrationInstaller.Index();
        index.releases.add(release("0.1.0", null, "1.21.1", "neoforge"));
        index.releases.add(release("0.2.0-beta.1", "beta", "1.21.1", "neoforge"));
        index.releases.add(release("0.1.1", "stable", "1.21.1", "neoforge"));
        index.releases.add(release("9.0.0", "stable", "1.20.1", "neoforge"));
        ImpulseMigrationInstaller.Release selected = ImpulseMigrationInstaller.latest(index, "1.21.1", "neoforge");
        require(selected != null && "0.1.1".equals(selected.version), "Migration must select the newest compatible stable Go release.");
    }

    private static void recognizesLegacyModeFromStandaloneSettings() throws Exception {
        File root = Files.createTempDirectory("impulse-legacy-mode-").toFile();
        try {
            File settings = new File(root, "impulse/standalone/settings.json");
            require(settings.getParentFile().mkdirs(), "Could not create settings fixture.");
            Files.write(settings.toPath(), "{\"migration_choice\":\"stay\"}".getBytes(StandardCharsets.UTF_8));
            require(ImpulseStandaloneMode.isLegacy(root), "The stay choice must enable legacy mode.");
            Files.write(settings.toPath(), "{\"migration_choice\":\"\"}".getBytes(StandardCharsets.UTF_8));
            require(!ImpulseStandaloneMode.isLegacy(root), "An empty choice must keep connected services enabled.");
        } finally {
            delete(root);
        }
    }

    private static ImpulseMigrationInstaller.Release release(String version, String channel, String minecraft, String loader) {
        ImpulseMigrationInstaller.Release release = new ImpulseMigrationInstaller.Release();
        release.version = version;
        release.channel = channel;
        release.minecraft_version = minecraft;
        release.loader = loader;
        release.download_url = "https://updates.erozion.com/go/mc/erozion-go-" + version + ".jar";
        release.sha512 = "a".repeat(128);
        release.size = 1024L;
        return release;
    }

    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        file.delete();
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
