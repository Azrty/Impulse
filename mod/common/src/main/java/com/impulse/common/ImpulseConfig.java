package com.impulse.common;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Properties;
import java.util.Set;

public final class ImpulseConfig {
    public final int manifestPort;
    public final String publicHost;
    public final String serverName;
    public final String description;
    public final String minecraftVersion;
    public final String loader;
    public final String loaderVersion;
    public final String forgeVersion;
    public final int minecraftPort;
    public final boolean autoConnect;
    public final boolean menuEnabled;
    public final String menuSkin;
    public final String menuTitle;
    public final String menuSubtitle;
    public final boolean menuHideServerNameFromPlayButton;
    public final int manifestVersion;
    public final String iconUrl;
    public final String bannerUrl;
    public final String videoBackgroundUrl;
    public final File mediaDirectory;
    public final String iconFile;
    public final String bannerFile;
    public final String videoBackgroundFile;
    public final File modsDirectory;
    public final Set<String> excludedNames;

    private ImpulseConfig(Properties props, File configFile, File serverRoot) {
        Properties serverProperties = loadServerProperties(serverRoot);
        this.manifestPort = parseInt(props.getProperty("manifest.port"), 25850);
        this.publicHost = props.getProperty("public.host", "localhost").trim();
        this.serverName = configuredServerName(props.getProperty("server.name", ""), serverProperties);
        this.description = props.getProperty("server.description", "A Forge server published through Impulse.").trim();
        this.minecraftVersion = props.getProperty("minecraft.version", "1.12.2").trim();
        this.loader = cleanLoader(props.getProperty("minecraft.loader", "forge"));
        String configuredLoaderVersion = props.getProperty("loader.version", "").trim();
        String configuredForgeVersion = props.getProperty("forge.version", "").trim();
        this.loaderVersion = valueOr(configuredLoaderVersion, configuredForgeVersion.length() > 0 ? configuredForgeVersion : recommendedLoaderVersion(this.loader, this.minecraftVersion));
        this.forgeVersion = "forge".equals(this.loader) ? this.loaderVersion : configuredForgeVersion;
        this.minecraftPort = parseInt(props.getProperty("minecraft.port"), 25565);
        this.autoConnect = Boolean.parseBoolean(props.getProperty("server.autoConnect", "true"));
        this.menuEnabled = Boolean.parseBoolean(props.getProperty("menu.enabled", "true"));
        this.menuSkin = cleanSkin(props.getProperty("skin", props.getProperty("menu.skin", "default")));
        this.menuTitle = valueOr(props.getProperty("menu.title", ""), "IMPULSE");
        this.menuSubtitle = valueOr(props.getProperty("menu.subtitle", ""), "A focused way into your server");
        this.menuHideServerNameFromPlayButton = parseBooleanAlias(props, "menu.hideServerNameFromPlayButton", "false",
            "hideServerNameFromPlayButton",
            "hideservernamefromplaybutton",
            "menu.hideservernamefromplaybutton");
        this.manifestVersion = parseInt(props.getProperty("manifest.version"), 1);
        this.iconUrl = cleanOptional(props.getProperty("media.iconUrl", ""));
        this.bannerUrl = cleanOptional(props.getProperty("media.bannerUrl", ""));
        this.videoBackgroundUrl = cleanOptional(props.getProperty("media.videoBackgroundUrl", ""));
        this.mediaDirectory = resolve(serverRoot, props.getProperty("media.directory", "impulse-media"), "impulse-media");
        this.iconFile = cleanOptional(props.getProperty("media.iconFile", ""));
        this.bannerFile = cleanOptional(props.getProperty("media.bannerFile", ""));
        this.videoBackgroundFile = cleanOptional(props.getProperty("media.videoBackgroundFile", ""));
        this.modsDirectory = resolve(serverRoot, props.getProperty("mods.directory", "mods"), "mods");
        this.excludedNames = parseExcludes(props.getProperty("mods.exclude", ""));
    }

    public static ImpulseConfig load(File serverRoot) throws IOException {
        return load(serverRoot, ImpulseRuntimeDefaults.empty());
    }

    public static ImpulseConfig load(File serverRoot, ImpulseRuntimeDefaults runtimeDefaults) throws IOException {
        File configDir = new File(serverRoot, "config");
        if (!configDir.exists()) configDir.mkdirs();
        File configFile = new File(configDir, "impulse-server.properties");
        Properties props = defaults(serverRoot, runtimeDefaults);
        if (configFile.exists()) {
            FileInputStream input = new FileInputStream(configFile);
            try {
                props.load(input);
            } finally {
                input.close();
            }
            if (writeMissingDefaults(configFile, props, defaults(serverRoot, runtimeDefaults))) {
                FileInputStream reloaded = new FileInputStream(configFile);
                try {
                    props.clear();
                    props.load(reloaded);
                } finally {
                    reloaded.close();
                }
            }
        } else {
            FileOutputStream output = new FileOutputStream(configFile);
            try {
                props.store(output, "Impulse server manifest settings");
            } finally {
                output.close();
            }
        }
        return new ImpulseConfig(props, configFile, serverRoot);
    }

    private static Properties defaults(File serverRoot, ImpulseRuntimeDefaults runtimeDefaults) {
        if (runtimeDefaults == null) runtimeDefaults = ImpulseRuntimeDefaults.empty();
        Properties serverProperties = loadServerProperties(serverRoot);
        String serverIp = valueOr(runtimeDefaults.publicHost, serverProperties.getProperty("server-ip", "localhost"));
        if (serverIp.length() == 0) serverIp = "localhost";
        Integer serverPort = runtimeDefaults.minecraftPort;
        if (serverPort == null) serverPort = Integer.valueOf(parseInt(serverProperties.getProperty("server-port"), 25565));
        Properties props = new Properties();
        props.setProperty("manifest.port", "25850");
        props.setProperty("manifest.version", "1");
        props.setProperty("public.host", serverIp);
        props.setProperty("server.name", valueOr(serverProperties.getProperty("motd", ""), "Impulse Server"));
        props.setProperty("server.description", "A modded server published through Impulse.");
        props.setProperty("server.autoConnect", "true");
        props.setProperty("skin", "default");
        props.setProperty("menu.enabled", "true");
        props.setProperty("menu.title", "IMPULSE");
        props.setProperty("menu.subtitle", "A focused way into your server");
        props.setProperty("menu.hideServerNameFromPlayButton", "false");
        String minecraftVersion = valueOr(runtimeDefaults.minecraftVersion, "1.12.2");
        String loader = cleanLoader(runtimeDefaults.loader);
        String loaderVersion = valueOr(runtimeDefaults.loaderVersion, recommendedLoaderVersion(loader, minecraftVersion));
        props.setProperty("minecraft.version", minecraftVersion);
        props.setProperty("minecraft.loader", loader);
        props.setProperty("minecraft.port", String.valueOf(serverPort.intValue()));
        props.setProperty("loader.version", loaderVersion);
        props.setProperty("forge.version", "forge".equals(loader) ? loaderVersion : valueOr(recommendedForgeVersion(minecraftVersion), ""));
        props.setProperty("mods.directory", "mods");
        props.setProperty("mods.exclude", "");
        props.setProperty("media.iconUrl", "");
        props.setProperty("media.bannerUrl", "");
        props.setProperty("media.videoBackgroundUrl", "");
        props.setProperty("media.directory", "impulse-media");
        props.setProperty("media.iconFile", "");
        props.setProperty("media.bannerFile", "");
        props.setProperty("media.videoBackgroundFile", "");
        return props;
    }

    private static Properties loadServerProperties(File serverRoot) {
        Properties props = new Properties();
        if (serverRoot == null) return props;
        File file = new File(serverRoot, "server.properties");
        if (!file.isFile()) return props;
        FileInputStream input = null;
        try {
            input = new FileInputStream(file);
            props.load(input);
        } catch (Exception ignored) {
        } finally {
            if (input != null) {
                try {
                    input.close();
                } catch (Exception ignored) {
                }
            }
        }
        return props;
    }

    private static boolean writeMissingDefaults(File configFile, Properties props, Properties defaults) throws IOException {
        boolean changed = false;
        for (Object keyObject : defaults.keySet()) {
            String key = String.valueOf(keyObject);
            if (!props.containsKey(key)) {
                props.setProperty(key, defaults.getProperty(key));
                changed = true;
            }
        }
        if (!changed) return false;
        FileOutputStream output = new FileOutputStream(configFile);
        try {
            props.store(output, "Impulse server manifest settings");
        } finally {
            output.close();
        }
        return true;
    }

    private static String valueOr(String value, String fallback) {
        return value == null || value.trim().length() == 0 ? fallback : value.trim();
    }

    private static boolean parseBooleanAlias(Properties props, String key, String fallback, String... aliases) {
        String value = props.getProperty(key);
        if (value == null) {
            for (String alias : aliases) {
                value = props.getProperty(alias);
                if (value != null) break;
            }
        }
        return Boolean.parseBoolean(value == null ? fallback : value.trim());
    }

    private static String configuredServerName(String configured, Properties serverProperties) {
        String clean = configured == null ? "" : configured.trim();
        if (clean.length() > 0 && !"Impulse Server".equals(clean)) return clean;
        return valueOr(serverProperties.getProperty("motd", ""), "Impulse Server");
    }

    private static String recommendedForgeVersion(String minecraftVersion) {
        if ("1.7.10".equals(minecraftVersion)) return "10.13.4.1614";
        if ("1.12.2".equals(minecraftVersion)) return "14.23.5.2860";
        if ("1.20.1".equals(minecraftVersion)) return "47.2.0";
        if ("1.21.1".equals(minecraftVersion)) return "52.1.16";
        return "";
    }

    private static String recommendedLoaderVersion(String loader, String minecraftVersion) {
        if ("neoforge".equals(loader)) {
            if ("1.21.1".equals(minecraftVersion)) return "21.1.243";
            return "";
        }
        return valueOr(recommendedForgeVersion(minecraftVersion), "14.23.5.2860");
    }

    private static String cleanLoader(String value) {
        return "neoforge".equalsIgnoreCase(String.valueOf(value).trim()) ? "neoforge" : "forge";
    }

    private static String cleanSkin(String value) {
        return "classic".equalsIgnoreCase(String.valueOf(value).trim()) ? "classic" : "default";
    }

    private static int parseInt(String value, int fallback) {
        try {
            return Integer.parseInt(String.valueOf(value).trim());
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private static String cleanOptional(String value) {
        String out = value == null ? "" : value.trim();
        return out.length() == 0 ? null : out;
    }

    private static File resolve(File root, String value, String fallback) {
        String clean = value == null || value.trim().length() == 0 ? fallback : value.trim();
        File file = new File(clean);
        return file.isAbsolute() ? file : new File(root, clean);
    }

    private static Set<String> parseExcludes(String value) {
        Set<String> out = new LinkedHashSet<String>();
        String raw = String.valueOf(value).trim();
        if ("impulse,impulse-forge-mod".equalsIgnoreCase(raw)) return out;
        for (String item : Arrays.asList(raw.split(","))) {
            String clean = item.trim().toLowerCase();
            if (clean.length() > 0) out.add(clean);
        }
        return out;
    }
}
