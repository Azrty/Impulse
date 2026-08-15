package com.impulse.common;

public final class ImpulseRuntimeDefaults {
    public final String minecraftVersion;
    public final String loader;
    public final String loaderVersion;
    public final String forgeVersion;
    public final String impulseVersion;
    public final String publicHost;
    public final Integer minecraftPort;

    public ImpulseRuntimeDefaults(String minecraftVersion, String forgeVersion, String publicHost, Integer minecraftPort) {
        this(minecraftVersion, "forge", forgeVersion, publicHost, minecraftPort, null);
    }

    public ImpulseRuntimeDefaults(String minecraftVersion, String loader, String loaderVersion, String publicHost, Integer minecraftPort) {
        this(minecraftVersion, loader, loaderVersion, publicHost, minecraftPort, null);
    }

    public ImpulseRuntimeDefaults(String minecraftVersion, String loader, String loaderVersion, String publicHost, Integer minecraftPort, String impulseVersion) {
        this.minecraftVersion = clean(minecraftVersion);
        this.loader = cleanLoader(loader);
        this.loaderVersion = clean(loaderVersion);
        this.forgeVersion = clean(loaderVersion);
        this.impulseVersion = clean(impulseVersion);
        this.publicHost = clean(publicHost);
        this.minecraftPort = minecraftPort;
    }

    public static ImpulseRuntimeDefaults empty() {
        return new ImpulseRuntimeDefaults(null, null, null, null);
    }

    private static String clean(String value) {
        if (value == null) return null;
        String out = value.trim();
        return out.length() == 0 ? null : out;
    }

    private static String cleanLoader(String value) {
        String out = clean(value);
        if ("neoforge".equalsIgnoreCase(out)) return "neoforge";
        return "forge";
    }
}
