package com.impulse.common;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Properties;
import java.util.Set;

public final class ImpulseConfig {
    public final File serverRoot;
    public final int manifestPort;
    public final int manifestHttpThreads;
    public final int manifestHttpBacklog;
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
    public final boolean menuSingleplayerEnabled;
    public final boolean menuMultiplayerEnabled;
    public final boolean maintenanceEnabled;
    public final String maintenanceTitle;
    public final String maintenanceMessage;
    public final String maintenanceEstimatedEnd;
    public final int manifestVersion;
    public final String iconUrl;
    public final String bannerUrl;
    public final String videoBackgroundUrl;
    public final File mediaDirectory;
    public final String iconFile;
    public final String bannerFile;
    public final String videoBackgroundFile;
    public final File modsDirectory;
    public final File optionalModsDirectory;
    public final boolean crashReportsEnabled;
    public final File crashReportsDirectory;
    public final int crashReportsMaxUploadBytes;
    public final int crashReportsMaxFiles;
    public final int crashReportsRetentionDays;
    public final int crashReportsRateLimitPerHour;
    public final Set<String> excludedNames;

    private ImpulseConfig(Properties props, File configFile, File serverRoot) {
        this.serverRoot = serverRoot;
        Properties serverProperties = loadServerProperties(serverRoot);
        this.manifestPort = parseInt(props.getProperty("manifest.port"), 25850);
        this.manifestHttpThreads = clamp(parseInt(props.getProperty("manifest.httpThreads"), 64), 1, 256);
        this.manifestHttpBacklog = clamp(parseInt(props.getProperty("manifest.httpBacklog"), 256), 1, 4096);
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
        this.menuSingleplayerEnabled = parseBooleanAlias(props, "singleplayerenabled", "false",
            "singlePlayerEnabled",
            "menu.singleplayerEnabled",
            "menu.singleplayer_enabled");
        this.menuMultiplayerEnabled = parseBooleanAlias(props, "multiplayerenabled", "false",
            "multiPlayerEnabled",
            "menu.multiplayerEnabled",
            "menu.multiplayer_enabled");
        this.maintenanceEnabled = Boolean.parseBoolean(props.getProperty("maintenance.enabled", "false"));
        this.maintenanceTitle = valueOr(props.getProperty("maintenance.title", ""), "Maintenance");
        this.maintenanceMessage = props.getProperty("maintenance.message", "").trim();
        this.maintenanceEstimatedEnd = props.getProperty("maintenance.estimatedEnd", "").trim();
        this.manifestVersion = parseInt(props.getProperty("manifest.version"), 1);
        this.iconUrl = cleanOptional(props.getProperty("media.iconUrl", ""));
        this.bannerUrl = cleanOptional(props.getProperty("media.bannerUrl", ""));
        this.videoBackgroundUrl = cleanOptional(props.getProperty("media.videoBackgroundUrl", ""));
        this.mediaDirectory = resolve(serverRoot, props.getProperty("media.directory", "impulse/assets"), "impulse/assets");
        this.iconFile = cleanOptional(props.getProperty("media.iconFile", ""));
        this.bannerFile = cleanOptional(props.getProperty("media.bannerFile", ""));
        this.videoBackgroundFile = cleanOptional(props.getProperty("media.videoBackgroundFile", ""));
        this.modsDirectory = resolve(serverRoot, props.getProperty("mods.directory", "impulse/mods"), "impulse/mods");
        this.optionalModsDirectory = resolve(serverRoot, optionalModsDirectoryProperty(props), "impulse/optionnal_mods");
        this.crashReportsEnabled = Boolean.parseBoolean(props.getProperty("crashreports.enabled", "true"));
        this.crashReportsDirectory = resolve(serverRoot, props.getProperty("crashreports.directory", "impulse/crash_reports"), "impulse/crash_reports");
        this.crashReportsMaxUploadBytes = Math.max(65536, parseInt(props.getProperty("crashreports.maxUploadBytes"), 2097152));
        this.crashReportsMaxFiles = Math.max(1, parseInt(props.getProperty("crashreports.maxFiles"), 500));
        this.crashReportsRetentionDays = Math.max(1, parseInt(props.getProperty("crashreports.retentionDays"), 30));
        this.crashReportsRateLimitPerHour = Math.max(1, parseInt(props.getProperty("crashreports.rateLimitPerHour"), 10));
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
            boolean migrated = migrateLegacyFolderDefaults(props);
            boolean addedDefaults = addMissingDefaults(props, defaults(serverRoot, runtimeDefaults));
            if (migrated || addedDefaults) {
                writeProperties(configFile, props);
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
        ImpulseConfig config = new ImpulseConfig(props, configFile, serverRoot);
        ensureImpulseDirectories(serverRoot, config);
        return config;
    }

    private static boolean migrateLegacyFolderDefaults(Properties props) {
        boolean changed = false;
        changed = migrateLegacyValue(props, "mods.directory", "mods", "impulse/mods") || changed;
        changed = migrateLegacyValue(props, "mods.directory", "Impulse/mods", "impulse/mods") || changed;
        changed = migrateLegacyValue(props, "media.directory", "impulse-media", "impulse/assets") || changed;
        changed = migrateLegacyValue(props, "media.directory", "Impulse/assets", "impulse/assets") || changed;
        changed = migrateLegacyValue(props, "optionalmods.directory", "optionalmods", "impulse/optionnal_mods") || changed;
        changed = migrateLegacyValue(props, "optionalmods.directory", "Impulse/optionnal_mods", "impulse/optionnal_mods") || changed;
        return changed;
    }

    private static boolean migrateLegacyValue(Properties props, String key, String oldValue, String newValue) {
        String value = props.getProperty(key);
        if (value != null && oldValue.equals(value.trim())) {
            props.setProperty(key, newValue);
            return true;
        }
        return false;
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
        props.setProperty("manifest.httpThreads", "64");
        props.setProperty("manifest.httpBacklog", "256");
        props.setProperty("manifest.version", "1");
        props.setProperty("updater.enabled", "true");
        props.setProperty("updater.channel", "stable");
        props.setProperty("updater.indexUrl", ImpulseModUpdater.DEFAULT_INDEX_URL);
        props.setProperty("updater.betaIndexUrl", ImpulseModUpdater.DEFAULT_BETA_INDEX_URL);
        props.setProperty("public.host", serverIp);
        props.setProperty("server.name", valueOr(serverProperties.getProperty("motd", ""), "Impulse Server"));
        props.setProperty("server.description", "A modded server published through Impulse.");
        props.setProperty("server.autoConnect", "true");
        props.setProperty("skin", "default");
        props.setProperty("menu.enabled", "true");
        props.setProperty("menu.title", "IMPULSE");
        props.setProperty("menu.subtitle", "A focused way into your server");
        props.setProperty("menu.hideServerNameFromPlayButton", "false");
        props.setProperty("singleplayerenabled", "false");
        props.setProperty("multiplayerenabled", "false");
        props.setProperty("maintenance.enabled", "false");
        props.setProperty("maintenance.title", "Maintenance");
        props.setProperty("maintenance.message", "");
        props.setProperty("maintenance.estimatedEnd", "");
        String minecraftVersion = valueOr(runtimeDefaults.minecraftVersion, "1.12.2");
        String loader = cleanLoader(runtimeDefaults.loader);
        String loaderVersion = valueOr(runtimeDefaults.loaderVersion, recommendedLoaderVersion(loader, minecraftVersion));
        props.setProperty("minecraft.version", minecraftVersion);
        props.setProperty("minecraft.loader", loader);
        props.setProperty("minecraft.port", String.valueOf(serverPort.intValue()));
        props.setProperty("loader.version", loaderVersion);
        props.setProperty("forge.version", "forge".equals(loader) ? loaderVersion : valueOr(recommendedForgeVersion(minecraftVersion), ""));
        props.setProperty("mods.directory", "impulse/mods");
        props.setProperty("optionalmods.directory", "impulse/optionnal_mods");
        props.setProperty("mods.exclude", "");
        props.setProperty("crashreports.enabled", "true");
        props.setProperty("crashreports.directory", "impulse/crash_reports");
        props.setProperty("crashreports.maxUploadBytes", "2097152");
        props.setProperty("crashreports.maxFiles", "500");
        props.setProperty("crashreports.retentionDays", "30");
        props.setProperty("crashreports.rateLimitPerHour", "10");
        props.setProperty("media.iconUrl", "");
        props.setProperty("media.bannerUrl", "");
        props.setProperty("media.videoBackgroundUrl", "");
        props.setProperty("media.directory", "impulse/assets");
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

    private static boolean addMissingDefaults(Properties props, Properties defaults) {
        boolean changed = false;
        for (Object keyObject : defaults.keySet()) {
            String key = String.valueOf(keyObject);
            if (!props.containsKey(key)) {
                props.setProperty(key, defaults.getProperty(key));
                changed = true;
            }
        }
        return changed;
    }

    private static void writeProperties(File configFile, Properties props) throws IOException {
        FileOutputStream output = new FileOutputStream(configFile);
        try {
            props.store(output, "Impulse server manifest settings");
        } finally {
            output.close();
        }
    }

    public static synchronized void updateProperties(File serverRoot, Map<String, String> updates) throws IOException {
        File configDir = new File(serverRoot, "config");
        if (!configDir.exists()) configDir.mkdirs();
        File configFile = new File(configDir, "impulse-server.properties");
        Properties props = defaults(serverRoot, ImpulseRuntimeDefaults.empty());
        if (configFile.isFile()) {
            FileInputStream input = new FileInputStream(configFile);
            try { props.load(input); } finally { input.close(); }
        }
        for (Map.Entry<String, String> entry : updates.entrySet()) props.setProperty(entry.getKey(), entry.getValue() == null ? "" : entry.getValue());
        writeProperties(configFile, props);
    }

    private static String valueOr(String value, String fallback) {
        return value == null || value.trim().length() == 0 ? fallback : value.trim();
    }

    private static void ensureImpulseDirectories(File serverRoot, ImpulseConfig config) {
        mkdirs(new File(serverRoot, "impulse"));
        mkdirs(new File(serverRoot, "impulse/mods"));
        mkdirs(new File(serverRoot, "impulse/assets"));
        mkdirs(new File(serverRoot, "impulse/optionnal_mods"));
        mkdirs(new File(serverRoot, "impulse/crash_reports"));
        mkdirs(config.modsDirectory);
        mkdirs(config.mediaDirectory);
        mkdirs(config.optionalModsDirectory);
        mkdirs(config.crashReportsDirectory);
    }

    private static void mkdirs(File dir) {
        if (dir != null && !dir.exists()) dir.mkdirs();
    }

    private static String firstProperty(Properties props, String key, String fallback, String... aliases) {
        String value = props.getProperty(key);
        if (value == null) {
            for (String alias : aliases) {
                value = props.getProperty(alias);
                if (value != null) break;
            }
        }
        return valueOr(value, fallback);
    }

    private static String optionalModsDirectoryProperty(Properties props) {
        String value = props.getProperty("optionalmods.directory");
        String alias = props.getProperty("optionalMods.directory");
        if (alias == null) alias = props.getProperty("optional_mods.directory");
        if ((value == null || "optionalmods".equals(value.trim()) || "Impulse/optionnal_mods".equals(value.trim())) && alias != null && alias.trim().length() > 0) {
            return alias.trim();
        }
        return valueOr(value, "impulse/optionnal_mods");
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

    private static int clamp(int value, int minimum, int maximum) {
        return Math.max(minimum, Math.min(maximum, value));
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
