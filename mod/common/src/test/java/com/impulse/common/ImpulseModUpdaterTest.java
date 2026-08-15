package com.impulse.common;

import java.io.File;
import java.nio.file.Files;
import java.util.Properties;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;

public final class ImpulseModUpdaterTest {
    private ImpulseModUpdaterTest() {
    }

    public static void main(String[] args) throws Exception {
        assertOrder("1.0.1", "1.0.0", 1);
        assertOrder("1.10.0", "1.9.9", 1);
        assertOrder("1.0.0", "1.0.0-beta.2", 1);
        assertOrder("1.0.0-beta.2", "1.0.0", -1);
        assertOrder("1.0.0-beta.10", "1.0.0-beta.2", 1);
        assertOrder("1.0.0", "1.0.0", 0);
        assertUpdateChannels();
        assertStandaloneChannelSettings();
        assertSeparateChannelIndexes();
        assertArbitraryJarNameIsDetected();
        assertStaleBackupsAreRemovedSafely();
        System.out.println("ImpulseModUpdaterTest passed");
    }

    private static void assertArbitraryJarNameIsDetected() throws Exception {
        File root = Files.createTempDirectory("impulse-updater-test").toFile();
        try {
            File mods = new File(root, "mods");
            if (!mods.mkdirs()) throw new AssertionError("Could not create test mods directory");
            File installed = new File(mods, "some-custom-impulse-name.jar");
            writeImpulseJar(installed);
            File detected = ImpulseModUpdater.locateInstalledJar(root);
            if (detected == null || !detected.getCanonicalFile().equals(installed.getCanonicalFile())) {
                throw new AssertionError("Impulse updater did not detect a renamed installed jar");
            }
        } finally {
            delete(root);
        }
    }

    private static void assertStaleBackupsAreRemovedSafely() throws Exception {
        File root = Files.createTempDirectory("impulse-updater-cleanup-test").toFile();
        try {
            File mods = new File(root, "mods");
            if (!mods.mkdirs()) throw new AssertionError("Could not create test mods directory");
            File active = new File(mods, "impulse.jar");
            File stale = new File(mods, "old-custom-name.jar.old");
            File unrelated = new File(mods, "another-mod.jar.old");
            writeImpulseJar(active);
            writeImpulseJar(stale);
            JarOutputStream otherJar = new JarOutputStream(Files.newOutputStream(unrelated.toPath()));
            otherJar.close();

            int removed = ImpulseModUpdater.cleanupStaleBackups(root, active);
            if (removed != 1 || stale.exists() || !active.exists() || !unrelated.exists()) {
                throw new AssertionError("Stale backup cleanup removed the wrong files");
            }
        } finally {
            delete(root);
        }
    }

    private static void writeImpulseJar(File target) throws Exception {
        JarOutputStream jar = new JarOutputStream(Files.newOutputStream(target.toPath()));
        try {
            jar.putNextEntry(new JarEntry("com/impulse/common/ImpulseModUpdater.class"));
            jar.closeEntry();
            jar.putNextEntry(new JarEntry("META-INF/neoforge.mods.toml"));
            jar.write("modId=\"impulse\"\n".getBytes("UTF-8"));
            jar.closeEntry();
        } finally {
            jar.close();
        }
    }

    private static void assertUpdateChannels() {
        ImpulseModUpdater.UpdateIndex index = new ImpulseModUpdater.UpdateIndex();
        index.releases.add(release("1.0.5", "stable"));
        index.releases.add(release("1.0.6-beta.2", "beta"));
        index.releases.add(release("1.0.6-beta.10", null));

        ImpulseModUpdater.Release stable = ImpulseModUpdater.latestMatching(index, "1.21.1", "neoforge", "1.0.4", "stable");
        if (stable == null || !"1.0.5".equals(stable.version)) {
            throw new AssertionError("Stable channel selected a prerelease or no release");
        }
        ImpulseModUpdater.Release beta = ImpulseModUpdater.latestMatching(index, "1.21.1", "neoforge", "1.0.4", "beta");
        if (beta == null || !"1.0.6-beta.10".equals(beta.version)) {
            throw new AssertionError("Beta channel did not select the newest stable-or-beta release");
        }

        ImpulseModUpdater.UpdateIndex nextMinor = new ImpulseModUpdater.UpdateIndex();
        nextMinor.releases.add(release("1.1.0-beta.1", "beta"));
        ImpulseModUpdater.Release nextMinorBeta = ImpulseModUpdater.latestMatching(nextMinor, "1.21.1", "neoforge", "1.0.5", "beta");
        if (nextMinorBeta == null || !"1.1.0-beta.1".equals(nextMinorBeta.version)) {
            throw new AssertionError("Beta channel did not select a newer minor prerelease");
        }
    }

    private static void assertStandaloneChannelSettings() throws Exception {
        File root = Files.createTempDirectory("impulse-updater-settings-test").toFile();
        try {
            File settings = new File(new File(new File(root, "impulse"), "standalone"), "settings.json");
            if (!settings.getParentFile().mkdirs()) throw new AssertionError("Could not create standalone settings directory");
            Files.write(settings.toPath(), "{\"update_channel\":\"beta\"}".getBytes("UTF-8"));
            Properties loaded = ImpulseModUpdater.readSettings(root);
            if (!"beta".equals(loaded.getProperty("updater.channel"))) {
                throw new AssertionError("Standalone beta channel was not loaded without a runtime property");
            }
        } finally {
            delete(root);
        }
    }

    private static ImpulseModUpdater.Release release(String version, String channel) {
        ImpulseModUpdater.Release release = new ImpulseModUpdater.Release();
        release.version = version;
        release.channel = channel;
        release.minecraft_version = "1.21.1";
        release.loader = "neoforge";
        release.download_url = "https://impulse.epivalent.com/mods/impulse.jar";
        release.sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
        release.size = 1;
        return release;
    }

    private static void assertSeparateChannelIndexes() {
        Properties settings = new Properties();
        String stable = ImpulseModUpdater.updateIndexUrl(settings, "stable");
        String beta = ImpulseModUpdater.updateIndexUrl(settings, "beta");
        if (!ImpulseModUpdater.DEFAULT_INDEX_URL.equals(stable)) {
            throw new AssertionError("Stable updates must keep using the legacy index URL");
        }
        if (!ImpulseModUpdater.DEFAULT_BETA_INDEX_URL.equals(beta)) {
            throw new AssertionError("Beta updates must use the isolated beta index URL");
        }
    }

    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        file.delete();
    }

    private static void assertOrder(String left, String right, int expectedSign) {
        int actual = Integer.signum(ImpulseModUpdater.compareVersions(left, right));
        if (actual != expectedSign) throw new AssertionError(left + " compared with " + right + " returned " + actual);
    }
}
