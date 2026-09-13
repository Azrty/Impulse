package com.impulse.gamecompat;

public final class ImpulseGameCompatTest {
    public static void main(String[] args) throws Exception {
        require(ImpulseGameCompat.matchesVersion("2.4.1", ">=2.0.0 <3.0.0"), "compound range");
        require(!ImpulseGameCompat.matchesVersion("3.0.0", ">=2.0.0 <3.0.0"), "exclusive upper bound");
        require(ImpulseGameCompat.matchesVersion("1.5.0", "[1.0.0,2.0.0)"), "Maven range");
        require(ImpulseGameCompat.compareVersions("1.10.0", "1.9.9") > 0, "numeric ordering");
        require(ImpulseGameCompat.compareVersions("1.0.0", "1.0.0") == 0, "equal versions");
        require(ImpulseGameCompat.matchesVersion("2.0.0", ">=2.0.0"), "inclusive lower bound");
        require(ImpulseGameCompat.matchesVersion("2.0.0", "<=2.0.0"), "inclusive upper bound");
        require(ImpulseGameCompat.compareVersions("1.0.0-beta.2", "1.0.0-beta.10") < 0, "prerelease numeric order");
        require(ImpulseGameCompat.compareVersions("1.0.0-beta.10", "1.0.0") < 0, "release after prerelease");
        long day = 24L * 60L * 60L * 1000L;
        require(ImpulseGameCompat.cacheFresh(1000, 1000 + 7 * day), "seven-day cache boundary");
        require(!ImpulseGameCompat.cacheFresh(1000, 1001 + 7 * day), "expired cache");
        require(!ImpulseGameCompat.cacheFresh(2000, 1000), "future-dated cache");
        java.net.URL origin = new java.net.URL("https://api.impulsemc.com/v1/game-compat/files/first.patch.jar");
        require("https://api.impulsemc.com/v1/game-compat/files/next.patch.jar".equals(
            ImpulseGameCompat.resolvePatchRedirect(origin, "next.patch.jar").toString()), "same-origin redirect");
        try {
            ImpulseGameCompat.resolvePatchRedirect(origin, "https://example.com/patches/next.patch.jar");
            throw new AssertionError("Game Compat accepted a cross-origin redirect");
        } catch (java.io.IOException expected) { }
        java.util.List<Integer> closed = new java.util.ArrayList<Integer>();
        PatchContext context = new PatchContext(new java.io.File("."), "test");
        context.registerHook(() -> closed.add(1));
        context.registerHook(() -> closed.add(2));
        context.closeHooks();
        context.closeHooks();
        require(closed.equals(java.util.Arrays.asList(2, 1)), "hooks close once in reverse order");
        PatchContext activeContext = new PatchContext(new java.io.File("."), "fixture");
        activeContext.registerHook(() -> closed.add(3));
        ImpulseCompatPatch activeFixture = new ImpulseCompatPatch() {
            public void enable(PatchContext ignored) { }
            public void disable() { closed.add(4); }
        };
        Class<?> activeType = Class.forName("com.impulse.gamecompat.ImpulseGameCompat$ActivePatch");
        java.lang.reflect.Constructor<?> constructor = activeType.getDeclaredConstructors()[0];
        constructor.setAccessible(true);
        java.lang.reflect.Field activeField = ImpulseGameCompat.class.getDeclaredField("ACTIVE");
        activeField.setAccessible(true);
        @SuppressWarnings("unchecked") java.util.Map<String, Object> active = (java.util.Map<String, Object>) activeField.get(null);
        active.put("fixture:active", constructor.newInstance(activeFixture, new java.net.URLClassLoader(new java.net.URL[0]), activeContext));
        ImpulseGameCompat.shutdown();
        require(closed.equals(java.util.Arrays.asList(2, 1, 4, 3)) && active.isEmpty(), "shutdown releases patch and hook");
        java.io.File jar = java.io.File.createTempFile("impulse-metadata-", ".jar");
        try {
            java.util.jar.Manifest manifest = new java.util.jar.Manifest();
            manifest.getMainAttributes().putValue("Manifest-Version", "1.0");
            manifest.getMainAttributes().putValue("Implementation-Version", "4.2.0");
            try (java.util.jar.JarOutputStream output = new java.util.jar.JarOutputStream(new java.io.FileOutputStream(jar), manifest)) {
                output.putNextEntry(new java.util.jar.JarEntry("META-INF/neoforge.mods.toml"));
                output.write(("[[mods]]\nmodId=\"first\"\nversion=\"${file.jarVersion}\"\n"
                    + "[[dependencies.first]]\nmodId=\"not_provided\"\nversionRange=\"[1.0,)\"\n"
                    + "[[mods]]\nmodId=\"second\"\nversion=\"2.0.0\"\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                output.closeEntry();
            }
            java.util.Map<String, String> mods = new java.util.HashMap<String, String>();
            ImpulseGameCompat.readModMetadata(jar, mods);
            require("4.2.0".equals(mods.get("first")) && "2.0.0".equals(mods.get("second")) && !mods.containsKey("not_provided"), "structured metadata");
        } finally { jar.delete(); }
        System.out.println("ImpulseGameCompatTest passed");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError("Game Compat failed: " + message);
    }
}
