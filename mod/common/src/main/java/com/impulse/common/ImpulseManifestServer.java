package com.impulse.common;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.jar.JarFile;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;

public final class ImpulseManifestServer {
    private static HttpServer server;
    private static ExecutorService executor;
    private static final Map<String, Sha1CacheEntry> sha1Cache = new HashMap<String, Sha1CacheEntry>();
    private static final Object manifestCacheLock = new Object();
    private static final Object crashReportLock = new Object();
    private static final Map<String, List<Long>> crashReportRateLimits = new HashMap<String, List<Long>>();
    private static ManifestCacheEntry manifestCache;
    private static volatile ImpulseConfig activeConfig;
    private static File activeServerRoot;
    private static ImpulseRuntimeDefaults activeRuntimeDefaults;
    private static File activeSelfJar;

    private ImpulseManifestServer() {
    }

    public static synchronized void start(File serverRoot) {
        start(serverRoot, ImpulseRuntimeDefaults.empty());
    }

    public static synchronized void start(File serverRoot, ImpulseRuntimeDefaults runtimeDefaults) {
        start(serverRoot, runtimeDefaults, null);
    }

    public static synchronized void start(File serverRoot, ImpulseRuntimeDefaults runtimeDefaults, File selfJar) {
        if (server != null) return;
        try {
            ImpulseConfig config = ImpulseConfig.load(serverRoot, runtimeDefaults);
            copySelfToDefaultModsDirectory(serverRoot, selfJar);
            activeServerRoot = serverRoot;
            activeRuntimeDefaults = runtimeDefaults == null ? ImpulseRuntimeDefaults.empty() : runtimeDefaults;
            activeSelfJar = selfJar;
            activeConfig = config;
            BoundServer bound = bind(config);
            server = bound.server;
            executor = bound.executor;
            Runtime.getRuntime().addShutdownHook(new Thread(new Runnable() {
                public void run() {
                    stop();
                }
            }, "impulse-http-shutdown"));
            System.out.println("[Impulse] Manifest server listening on port " + config.manifestPort);
        } catch (Exception error) {
            System.err.println("[Impulse] Failed to start manifest server: " + error.getMessage());
            error.printStackTrace();
        }
    }

    private static BoundServer bind(ImpulseConfig config) throws IOException {
        HttpServer nextServer = HttpServer.create(new InetSocketAddress(config.manifestPort), config.manifestHttpBacklog);
        nextServer.createContext("/impulse/server.json", new HttpHandler() {
            public void handle(HttpExchange exchange) throws IOException {
                byte[] body = buildManifestCached(requireConfig()).getBytes(StandardCharsets.UTF_8);
                respond(exchange, 200, "application/json; charset=utf-8", body);
            }
        });
        nextServer.createContext("/impulse/mods", new HttpHandler() {
            public void handle(HttpExchange exchange) throws IOException {
                ImpulseConfig current = requireConfig();
                serveMod(current, exchange, current.modsDirectory, "/impulse/mods/");
            }
        });
        nextServer.createContext("/impulse/optional-mods", new HttpHandler() {
            public void handle(HttpExchange exchange) throws IOException {
                ImpulseConfig current = requireConfig();
                serveMod(current, exchange, current.optionalModsDirectory, "/impulse/optional-mods/");
            }
        });
        nextServer.createContext("/impulse/media", new HttpHandler() {
            public void handle(HttpExchange exchange) throws IOException { serveMedia(requireConfig(), exchange); }
        });
        nextServer.createContext("/impulse/crash-reports", new HttpHandler() {
            public void handle(HttpExchange exchange) throws IOException { receiveCrashReport(requireConfig(), exchange); }
        });
        ExecutorService nextExecutor = Executors.newFixedThreadPool(config.manifestHttpThreads, new ThreadFactory() {
            private final AtomicInteger sequence = new AtomicInteger();

            public Thread newThread(Runnable task) {
                Thread thread = new Thread(task, "impulse-http-" + sequence.incrementAndGet());
                thread.setDaemon(true);
                return thread;
            }
        });
        nextServer.setExecutor(nextExecutor);
        buildManifestCached(config);
        nextServer.start();
        return new BoundServer(nextServer, nextExecutor);
    }

    private static ImpulseConfig requireConfig() throws IOException {
        ImpulseConfig config = activeConfig;
        if (config == null) throw new IOException("Impulse manifest server is not configured.");
        return config;
    }

    public static synchronized ReloadResult reload() {
        if (activeServerRoot == null) return new ReloadResult(false, "Impulse is not running on a dedicated server.");
        try {
            ImpulseConfig next = ImpulseConfig.load(activeServerRoot, activeRuntimeDefaults);
            synchronized (manifestCacheLock) { manifestCache = null; }
            if (server != null && activeConfig != null && next.manifestPort == activeConfig.manifestPort) {
                activeConfig = next;
                buildManifestCached(next);
                return new ReloadResult(true, "Impulse configuration reloaded.");
            }
            ImpulseConfig previousConfig = activeConfig;
            activeConfig = next;
            BoundServer replacement;
            try {
                replacement = bind(next);
            } catch (Exception bindError) {
                activeConfig = previousConfig;
                return new ReloadResult(false, "Could not bind manifest port " + next.manifestPort + ": " + bindError.getMessage() + ". The previous endpoint is still active.");
            }
            HttpServer previousServer = server;
            ExecutorService previousExecutor = executor;
            server = replacement.server;
            executor = replacement.executor;
            if (previousServer != null) previousServer.stop(0);
            if (previousExecutor != null) previousExecutor.shutdownNow();
            buildManifestCached(next);
            return new ReloadResult(true, "Impulse configuration reloaded on port " + next.manifestPort + ".");
        } catch (Exception error) {
            return new ReloadResult(false, "Impulse reload failed: " + error.getMessage());
        }
    }

    public static synchronized ReloadResult setMaintenance(boolean enabled, String message) {
        if (activeServerRoot == null) return new ReloadResult(false, "Impulse is not running on a dedicated server.");
        try {
            Map<String, String> updates = new HashMap<String, String>();
            updates.put("maintenance.enabled", enabled ? "true" : "false");
            if (message != null) updates.put("maintenance.message", message.trim());
            ImpulseConfig.updateProperties(activeServerRoot, updates);
            return reload();
        } catch (Exception error) {
            return new ReloadResult(false, "Could not update maintenance mode: " + error.getMessage());
        }
    }

    private static void copySelfToDefaultModsDirectory(File serverRoot, File explicitSource) {
        try {
            File source = explicitSource != null ? explicitSource : resolveOwnJarFile();
            if (source == null) {
                System.out.println("[Impulse] Could not resolve a local server mod jar to copy into impulse/mods.");
                return;
            }
            if (!source.isFile() || !source.getName().toLowerCase().endsWith(".jar")) return;
            File targetDir = new File(serverRoot, "impulse/mods");
            if (!targetDir.exists()) targetDir.mkdirs();
            File target = new File(targetDir, "impulse.jar").getCanonicalFile();
            File canonicalSource = source.getCanonicalFile();
            if (canonicalSource.equals(target)) {
                deleteLegacyImpulseCopies(targetDir, target);
                return;
            }
            copyFile(canonicalSource, target);
            deleteLegacyImpulseCopies(targetDir, target);
            System.out.println("[Impulse] Copied server mod to " + target.getPath());
        } catch (Exception error) {
            System.err.println("[Impulse] Failed to copy server mod into impulse/mods: " + error.getMessage());
        }
    }

    private static void deleteLegacyImpulseCopies(File targetDir, File keep) {
        File[] files = targetDir.listFiles();
        if (files == null) return;
        for (int i = 0; i < files.length; i++) {
            File file = files[i];
            String name = file.getName().toLowerCase();
            if (!file.isFile() || !name.endsWith(".jar")) continue;
            if (!name.startsWith("impulse-") && !name.startsWith("impulse_")) continue;
            try {
                if (!file.getCanonicalFile().equals(keep.getCanonicalFile())) {
                    file.delete();
                }
            } catch (Exception ignored) {
            }
        }
    }

    private static File resolveOwnJarFile() {
        try {
            java.net.URL location = ImpulseManifestServer.class.getProtectionDomain().getCodeSource().getLocation();
            if (location != null && "file".equalsIgnoreCase(location.getProtocol())) {
                File file = new File(location.toURI());
                if (file.isFile()) return file;
            }
        } catch (Exception ignored) {
        }
        try {
            java.net.URL resource = ImpulseManifestServer.class.getResource("ImpulseManifestServer.class");
            if (resource != null && "jar".equalsIgnoreCase(resource.getProtocol())) {
                String external = resource.toExternalForm();
                int bang = external.indexOf('!');
                String jarUrl = bang >= 0 ? external.substring(4, bang) : "";
                java.net.URL url = new java.net.URL(jarUrl);
                if ("file".equalsIgnoreCase(url.getProtocol())) {
                    File file = new File(url.toURI());
                    if (file.isFile()) return file;
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static void copyFile(File source, File target) throws IOException {
        FileInputStream input = new FileInputStream(source);
        try {
            FileOutputStream output = new FileOutputStream(target);
            try {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            } finally {
                output.close();
            }
        } finally {
            input.close();
        }
    }

    public static synchronized void stop() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        synchronized (manifestCacheLock) {
            manifestCache = null;
        }
        activeConfig = null;
        activeServerRoot = null;
        activeRuntimeDefaults = null;
        activeSelfJar = null;
    }

    private static String buildManifestCached(ImpulseConfig config) throws IOException {
        synchronized (manifestCacheLock) {
            String signature = manifestSignature(config);
            if (manifestCache != null && manifestCache.signature.equals(signature)) {
                return manifestCache.json;
            }
            String json = buildManifest(config);
            manifestCache = new ManifestCacheEntry(signature, json);
            return json;
        }
    }

    private static String manifestSignature(ImpulseConfig config) throws IOException {
        StringBuilder out = new StringBuilder();
        appendDirectorySignature(out, config.modsDirectory, config, true);
        appendOptionalDirectorySignature(out, config.optionalModsDirectory, config);
        appendMediaSignature(out, config, config.iconFile);
        appendMediaSignature(out, config, config.bannerFile);
        appendMediaSignature(out, config, config.videoBackgroundFile);
        File publicIndex = new File(config.serverRoot, "impulse/.manager/public-index.json");
        if (publicIndex.isFile()) appendFileSignature(out, publicIndex);
        File content = new File(config.serverRoot, "impulse/content.json");
        if (content.isFile()) appendFileSignature(out, content);
        return out.toString();
    }

    private static void appendDirectorySignature(StringBuilder out, File directory, ImpulseConfig config, boolean applyExcludes) throws IOException {
        File[] files = directory.listFiles();
        if (files == null) {
            out.append(directory.getCanonicalPath()).append("|missing;");
            return;
        }
        Arrays.sort(files, new Comparator<File>() {
            public int compare(File left, File right) {
                return left.getName().compareToIgnoreCase(right.getName());
            }
        });
        for (File file : files) {
            String name = file.getName().toLowerCase();
            if (!file.isFile() || !name.endsWith(".jar")) continue;
            if (applyExcludes && isExcluded(config, name)) continue;
            appendFileSignature(out, file);
        }
    }

    private static void appendOptionalDirectorySignature(StringBuilder out, File directory, ImpulseConfig config) throws IOException {
        File[] files = directory.listFiles();
        if (files == null) {
            out.append(directory.getCanonicalPath()).append("|missing;");
            return;
        }
        Arrays.sort(files, fileNameComparator());
        for (File file : files) {
            if (file.isDirectory()) {
                appendOptionalCategorySignature(out, file, config);
            } else if (isJar(file) && !isExcluded(config, file.getName().toLowerCase())) {
                appendFileSignature(out, file);
            }
        }
    }

    private static void appendOptionalCategorySignature(StringBuilder out, File directory, ImpulseConfig config) throws IOException {
        File configFile = new File(directory, "config.json");
        if (configFile.isFile()) appendFileSignature(out, configFile);
        File[] files = directory.listFiles();
        if (files == null) return;
        Arrays.sort(files, fileNameComparator());
        for (File file : files) {
            if (file.isDirectory()) {
                appendOptionalCategorySignature(out, file, config);
            } else if (isJar(file) && !isExcluded(config, file.getName().toLowerCase())) {
                appendFileSignature(out, file);
            }
        }
    }

    private static Comparator<File> fileNameComparator() {
        return new Comparator<File>() {
            public int compare(File left, File right) {
                return left.getName().compareToIgnoreCase(right.getName());
            }
        };
    }

    private static boolean isJar(File file) {
        return file != null && file.isFile() && file.getName().toLowerCase().endsWith(".jar");
    }

    private static void appendMediaSignature(StringBuilder out, ImpulseConfig config, String fileName) throws IOException {
        if (fileName == null) return;
        File target = new File(config.mediaDirectory, fileName).getCanonicalFile();
        File root = config.mediaDirectory.getCanonicalFile();
        if (isInside(root, target) && target.isFile()) appendFileSignature(out, target);
    }

    private static void appendFileSignature(StringBuilder out, File file) throws IOException {
        out.append(file.getCanonicalPath())
            .append('|')
            .append(file.length())
            .append('|')
            .append(file.lastModified())
            .append(';');
    }

    private static String buildManifest(ImpulseConfig config) throws IOException {
        List<ModFile> mods = scanMods(config, config.modsDirectory);
        OptionalModCatalog optionalCatalog = scanOptionalMods(config);
        Map<String, ModRelationship> relationships = readPublicIndex(config);
        Json json = new Json();
        json.object();
        json.prop("manifest_version", config.manifestVersion).comma();
        json.prop("impulse_version", activeImpulseVersion()).comma();
        json.prop("name", config.serverName).comma();
        json.prop("description", config.description).comma();
        json.prop("icon_url", mediaUrl(config, config.iconUrl, config.iconFile)).comma();
        json.prop("banner_url", mediaUrl(config, config.bannerUrl, config.bannerFile)).comma();
        json.prop("video_background_url", mediaUrl(config, config.videoBackgroundUrl, config.videoBackgroundFile)).comma();
        json.key("server").object();
        json.prop("address", config.publicHost).comma();
        json.prop("port", config.minecraftPort).comma();
        json.prop("auto_connect", config.autoConnect);
        json.endObject().comma();
        json.key("minecraft").object();
        json.prop("version", config.minecraftVersion).comma();
        json.prop("loader", config.loader).comma();
        json.prop("loader_version", config.loaderVersion);
        json.endObject().comma();
        json.key("menu").object();
        json.prop("enabled", config.menuEnabled).comma();
        json.prop("skin", config.menuSkin).comma();
        json.prop("title", config.menuTitle).comma();
        json.prop("subtitle", config.menuSubtitle).comma();
        json.prop("hide_server_name_from_play_button", config.menuHideServerNameFromPlayButton).comma();
        json.prop("singleplayer_enabled", config.menuSingleplayerEnabled).comma();
        json.prop("multiplayer_enabled", config.menuMultiplayerEnabled);
        json.endObject().comma();
        json.key("maintenance").object();
        json.prop("enabled", config.maintenanceEnabled).comma();
        json.prop("title", config.maintenanceTitle).comma();
        json.prop("message", config.maintenanceMessage).comma();
        json.prop("estimated_end", config.maintenanceEstimatedEnd);
        json.endObject().comma();
        json.key("crash_reports").object();
        json.prop("enabled", config.crashReportsEnabled).comma();
        json.prop("max_upload_bytes", config.crashReportsMaxUploadBytes);
        json.endObject().comma();
        JsonObject content = readContent(config);
        json.key("announcements").raw(contentArray(content, "announcements")).comma();
        json.key("changelog").raw(contentArray(content, "changelog")).comma();
        json.key("events").raw(contentArray(content, "events")).comma();
        json.key("mods").array();
        writeModsArray(json, config, mods, "/impulse/mods/", true, relationships);
        json.endArray().comma();
        json.key("optional_mods").array();
        writeModsArray(json, config, optionalCatalog.mods, "/impulse/optional-mods/", false, relationships);
        json.endArray().comma();
        json.key("optional_mod_categories").array();
        writeOptionalCategories(json, optionalCatalog.categories);
        json.endArray();
        json.endObject();
        return json.toString();
    }

    private static JsonObject readContent(ImpulseConfig config) {
        File file = new File(config.serverRoot, "impulse/content.json");
        try {
            JsonElement parsed = new JsonParser().parse(readFileText(file));
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : new JsonObject();
        } catch (Exception error) {
            if (file.isFile()) System.err.println("[Impulse] Ignoring invalid content.json: " + error.getMessage());
            return new JsonObject();
        }
    }

    private static String contentArray(JsonObject content, String key) {
        return content.has(key) && content.get(key).isJsonArray() ? content.get(key).toString() : "[]";
    }

    private static String activeImpulseVersion() {
        String runtimeVersion = activeRuntimeDefaults == null ? null : activeRuntimeDefaults.impulseVersion;
        if (runtimeVersion != null && runtimeVersion.trim().length() > 0) return runtimeVersion.trim();
        if (activeSelfJar != null && activeSelfJar.isFile()) {
            try {
                JarFile jar = new JarFile(activeSelfJar);
                try {
                    String metadata = readJarText(jar, "META-INF/neoforge.mods.toml");
                    if (metadata == null) metadata = readJarText(jar, "META-INF/mods.toml");
                    String version = firstTomlValue(metadata == null ? "" : metadata, "version");
                    if (version.length() > 0 && !version.contains("${")) return version;
                } finally {
                    jar.close();
                }
            } catch (Exception ignored) {
            }
        }
        return "1.0.0";
    }

    private static void writeOptionalCategories(Json json, List<OptionalModCategory> categories) {
        for (int i = 0; i < categories.size(); i++) {
            OptionalModCategory category = categories.get(i);
            json.object();
            json.prop("id", category.id).comma();
            json.prop("name", category.name).comma();
            json.prop("description", category.description).comma();
            json.prop("default_enabled", category.defaultEnabled).comma();
            json.prop("order", category.order);
            json.endObject();
            if (i < categories.size() - 1) json.comma();
        }
    }

    private static void writeModsArray(Json json, ImpulseConfig config, List<ModFile> mods, String route, boolean required, Map<String, ModRelationship> relationships) {
        for (int i = 0; i < mods.size(); i++) {
            ModFile mod = mods.get(i);
            ModRelationship relationship = relationships.get(mod.sha1.toLowerCase());
            String stableId = relationship != null && relationship.id.length() > 0 ? relationship.id : (mod.modId.length() > 0 ? mod.modId : mod.sha1);
            json.object();
            json.prop("id", stableId).comma();
            json.prop("name", mod.name).comma();
            json.prop("description", mod.description).comma();
            json.prop("file_name", mod.file.getName()).comma();
            json.prop("download_url", publicUrl(config, route + urlPath(mod.relativePath))).comma();
            json.prop("sha1", mod.sha1).comma();
            json.prop("size", mod.file.length()).comma();
            json.prop("required", required).comma();
            json.key("dependencies").array();
            writeStringArray(json, relationship == null ? java.util.Collections.<String>emptyList() : relationship.dependencies);
            json.endArray().comma();
            json.key("conflicts").array();
            writeStringArray(json, relationship == null ? java.util.Collections.<String>emptyList() : relationship.conflicts);
            json.endArray();
            if (mod.categoryId != null) {
                json.comma();
                json.prop("category_id", mod.categoryId);
            }
            json.endObject();
            if (i < mods.size() - 1) json.comma();
        }
    }

    private static void writeStringArray(Json json, List<String> values) {
        for (int i = 0; i < values.size(); i++) {
            json.value(values.get(i));
            if (i < values.size() - 1) json.comma();
        }
    }

    private static Map<String, ModRelationship> readPublicIndex(ImpulseConfig config) {
        Map<String, ModRelationship> out = new HashMap<String, ModRelationship>();
        File file = new File(config.serverRoot, "impulse/.manager/public-index.json");
        try {
            JsonElement parsed = new JsonParser().parse(readFileText(file));
            if (!parsed.isJsonObject()) return out;
            JsonObject root = parsed.getAsJsonObject();
            JsonObject mods = root.has("mods") && root.get("mods").isJsonObject() ? root.getAsJsonObject("mods") : root;
            for (Map.Entry<String, JsonElement> entry : mods.entrySet()) {
                if (!entry.getValue().isJsonObject()) continue;
                JsonObject value = entry.getValue().getAsJsonObject();
                String hash = entry.getKey().toLowerCase();
                out.put(hash, new ModRelationship(jsonString(value, "id"), jsonStringList(value, "dependencies"), jsonStringList(value, "conflicts")));
            }
        } catch (Exception error) {
            if (file.isFile()) System.err.println("[Impulse] Ignoring invalid public-index.json: " + error.getMessage());
        }
        return out;
    }

    private static String jsonString(JsonObject object, String key) {
        try { return object.has(key) ? cleanMetadataValue(object.get(key).getAsString()) : ""; }
        catch (Exception ignored) { return ""; }
    }

    private static List<String> jsonStringList(JsonObject object, String key) {
        List<String> out = new ArrayList<String>();
        if (!object.has(key) || !object.get(key).isJsonArray()) return out;
        JsonArray array = object.getAsJsonArray(key);
        for (JsonElement item : array) {
            try {
                String value = cleanMetadataValue(item.getAsString());
                if (value.length() > 0 && !out.contains(value)) out.add(value);
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    private static List<ModFile> scanMods(ImpulseConfig config, File directory) throws IOException {
        List<ModFile> out = new ArrayList<ModFile>();
        File[] files = directory.listFiles();
        if (files == null) return out;
        Arrays.sort(files, fileNameComparator());
        for (File file : files) {
            String name = file.getName().toLowerCase();
            if (!file.isFile() || !name.endsWith(".jar")) continue;
            if (isExcluded(config, name)) continue;
            ModMetadata metadata = readModMetadata(file);
            out.add(new ModFile(file, cachedSha1(file), metadata.modId, metadata.name, metadata.description, file.getName(), null));
        }
        return out;
    }

    private static OptionalModCatalog scanOptionalMods(ImpulseConfig config) throws IOException {
        List<ModFile> mods = new ArrayList<ModFile>();
        List<OptionalModCategory> categories = new ArrayList<OptionalModCategory>();
        File root = config.optionalModsDirectory.getCanonicalFile();
        File[] files = root.listFiles();
        if (files == null) return new OptionalModCatalog(mods, categories);
        Arrays.sort(files, fileNameComparator());
        OptionalModCategory ungrouped = null;
        Set<String> clientNames = new HashSet<String>();
        Set<String> categoryIds = new HashSet<String>();
        for (File file : files) {
            if (isJar(file) && !isExcluded(config, file.getName().toLowerCase())) {
                if (ungrouped == null) {
                    ungrouped = new OptionalModCategory("ungrouped", "Ungrouped", "", false, Integer.MAX_VALUE);
                    categories.add(ungrouped);
                }
                addOptionalMod(config, root, file, ungrouped.id, mods, clientNames);
            } else if (file.isDirectory()) {
                OptionalModCategory category = readOptionalCategory(file);
                if (!categoryIds.add(category.id)) {
                    throw new IOException("Duplicate optional mod category id '" + category.id + "'. Set a unique id in each category config.json.");
                }
                categories.add(category);
                scanOptionalCategory(config, root, file, category.id, mods, clientNames);
            }
        }
        java.util.Collections.sort(categories, new Comparator<OptionalModCategory>() {
            public int compare(OptionalModCategory left, OptionalModCategory right) {
                int order = left.order - right.order;
                return order != 0 ? order : left.name.compareToIgnoreCase(right.name);
            }
        });
        return new OptionalModCatalog(mods, categories);
    }

    private static void scanOptionalCategory(ImpulseConfig config, File root, File directory, String categoryId, List<ModFile> mods, Set<String> clientNames) throws IOException {
        File[] files = directory.listFiles();
        if (files == null) return;
        Arrays.sort(files, fileNameComparator());
        for (File file : files) {
            if (file.isDirectory()) {
                scanOptionalCategory(config, root, file, categoryId, mods, clientNames);
            } else if (isJar(file) && !isExcluded(config, file.getName().toLowerCase())) {
                addOptionalMod(config, root, file, categoryId, mods, clientNames);
            }
        }
    }

    private static void addOptionalMod(ImpulseConfig config, File root, File file, String categoryId, List<ModFile> mods, Set<String> clientNames) throws IOException {
        String clientName = file.getName().toLowerCase();
        if (!clientNames.add(clientName)) {
            throw new IOException("Duplicate optional mod filename '" + file.getName() + "'. Optional client mod filenames must be unique.");
        }
        ModMetadata metadata = readModMetadata(file);
        String relative = relativePath(root, file);
        mods.add(new ModFile(file, cachedSha1(file), metadata.modId, metadata.name, metadata.description, relative, categoryId));
    }

    private static OptionalModCategory readOptionalCategory(File directory) {
        String fallbackId = slug(directory.getName());
        String fallbackName = directory.getName();
        File configFile = new File(directory, "config.json");
        String text = "";
        try {
            text = readFileText(configFile);
        } catch (Exception ignored) {
        }
        String id = cleanCategoryId(firstJsonString(text, "id"), fallbackId);
        String name = valueOr(firstJsonString(text, "name"), fallbackName);
        String description = firstJsonString(text, "description");
        boolean defaultEnabled = firstJsonBoolean(text, "default_enabled", false);
        int order = firstJsonInt(text, "order", 0);
        return new OptionalModCategory(id, name, description, defaultEnabled, order);
    }

    private static String readFileText(File file) throws IOException {
        if (file == null || !file.isFile()) return "";
        FileInputStream input = new FileInputStream(file);
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            input.close();
        }
    }

    private static String relativePath(File root, File file) throws IOException {
        String rootPath = root.getCanonicalPath();
        String filePath = file.getCanonicalPath();
        if (!filePath.startsWith(rootPath + File.separator)) throw new IOException("Optional mod is outside its configured directory.");
        return filePath.substring(rootPath.length() + 1).replace(File.separatorChar, '/');
    }

    private static boolean isExcluded(ImpulseConfig config, String lowerName) {
        for (String excluded : config.excludedNames) {
            if (lowerName.contains(excluded)) return true;
        }
        return false;
    }

    private static void serveMod(ImpulseConfig config, HttpExchange exchange, File directory, String prefix) throws IOException {
        String path = exchange.getRequestURI().getRawPath();
        if (!path.startsWith(prefix)) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        String name = decodeRelativePath(path.substring(prefix.length()));
        if (!isSafeRelativePath(name)) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        File target = new File(directory, name).getCanonicalFile();
        File root = directory.getCanonicalFile();
        if (!isInside(root, target) || !target.isFile() || isExcluded(config, target.getName().toLowerCase())) {
            respond(exchange, 404, "text/plain", bytes("Not found in configured mods directory: " + directory.getPath()));
            return;
        }
        serveFile(exchange, target, "application/java-archive", true);
    }

    private static void serveMedia(ImpulseConfig config, HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getRawPath();
        String prefix = "/impulse/media/";
        if (!path.startsWith(prefix)) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        String name = decodePathSegment(path.substring(prefix.length()));
        if (!isSafeFileName(name)) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        File target = new File(config.mediaDirectory, name).getCanonicalFile();
        File root = config.mediaDirectory.getCanonicalFile();
        if (!isInside(root, target) || !target.isFile()) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        serveFile(exchange, target, contentType(target.getName()), false);
    }

    private static void receiveCrashReport(ImpulseConfig config, HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.getResponseHeaders().set("Allow", "POST");
            respond(exchange, 405, "application/json; charset=utf-8", bytes("{\"error\":\"Method not allowed\"}"));
            return;
        }
        if (!config.crashReportsEnabled) {
            respond(exchange, 403, "application/json; charset=utf-8", bytes("{\"error\":\"Crash report sharing is disabled\"}"));
            return;
        }
        String contentType = valueOr(exchange.getRequestHeaders().getFirst("Content-Type"), "").toLowerCase();
        if (!contentType.startsWith("application/json")) {
            respond(exchange, 415, "application/json; charset=utf-8", bytes("{\"error\":\"Content-Type must be application/json\"}"));
            return;
        }
        String remote = exchange.getRemoteAddress() == null || exchange.getRemoteAddress().getAddress() == null
            ? "unknown"
            : exchange.getRemoteAddress().getAddress().getHostAddress();
        if (!allowCrashReport(remote, config.crashReportsRateLimitPerHour)) {
            respond(exchange, 429, "application/json; charset=utf-8", bytes("{\"error\":\"Crash report rate limit exceeded\"}"));
            return;
        }
        long declaredLength = parseLong(exchange.getRequestHeaders().getFirst("Content-Length"), -1L);
        if (declaredLength > config.crashReportsMaxUploadBytes) {
            respond(exchange, 413, "application/json; charset=utf-8", bytes("{\"error\":\"Crash report is too large\"}"));
            return;
        }
        byte[] body;
        try {
            body = readLimited(exchange.getRequestBody(), config.crashReportsMaxUploadBytes);
        } catch (PayloadTooLargeException error) {
            respond(exchange, 413, "application/json; charset=utf-8", bytes("{\"error\":\"Crash report is too large\"}"));
            return;
        }
        JsonObject report;
        try {
            JsonElement parsed = new JsonParser().parse(new String(body, StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) throw new IOException("Crash report must be a JSON object.");
            report = parsed.getAsJsonObject();
        } catch (Exception error) {
            respond(exchange, 400, "application/json; charset=utf-8", bytes("{\"error\":\"Invalid crash report JSON\"}"));
            return;
        }
        if (!report.has("report_id") || !report.has("created_at") || !report.has("crash")) {
            respond(exchange, 400, "application/json; charset=utf-8", bytes("{\"error\":\"Crash report is missing required fields\"}"));
            return;
        }
        String receivedAt = utcTimestamp();
        report.addProperty("received_at", receivedAt);
        String username = report.has("player") && report.get("player").isJsonObject()
            ? jsonString(report.getAsJsonObject("player"), "username")
            : "player";
        String fileName = receivedAt.replace(':', '-') + "-" + safeReportName(username) + "-" + UUID.randomUUID().toString().substring(0, 8) + ".json";
        File directory = config.crashReportsDirectory.getCanonicalFile();
        if (!directory.exists() && !directory.mkdirs()) {
            respond(exchange, 500, "application/json; charset=utf-8", bytes("{\"error\":\"Could not create crash report directory\"}"));
            return;
        }
        File target = new File(directory, fileName).getCanonicalFile();
        if (!isInside(directory, target)) {
            respond(exchange, 500, "application/json; charset=utf-8", bytes("{\"error\":\"Invalid crash report path\"}"));
            return;
        }
        synchronized (crashReportLock) {
            File temporary = new File(directory, "." + fileName + ".tmp");
            FileOutputStream output = new FileOutputStream(temporary);
            try {
                output.write(report.toString().getBytes(StandardCharsets.UTF_8));
            } finally {
                output.close();
            }
            try {
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE);
            } catch (Exception atomicMoveError) {
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
            cleanCrashReports(config);
        }
        respond(exchange, 201, "application/json; charset=utf-8", bytes("{\"success\":true,\"file\":\"" + jsonEscape(fileName) + "\"}"));
    }

    private static boolean allowCrashReport(String remote, int limit) {
        synchronized (crashReportRateLimits) {
            long now = System.currentTimeMillis();
            long cutoff = now - 60L * 60L * 1000L;
            if (crashReportRateLimits.size() > 1024) {
                List<String> stale = new ArrayList<String>();
                for (Map.Entry<String, List<Long>> entry : crashReportRateLimits.entrySet()) {
                    List<Long> timestamps = entry.getValue();
                    for (int i = timestamps.size() - 1; i >= 0; i--) if (timestamps.get(i).longValue() < cutoff) timestamps.remove(i);
                    if (timestamps.isEmpty()) stale.add(entry.getKey());
                }
                for (String key : stale) crashReportRateLimits.remove(key);
            }
            List<Long> attempts = crashReportRateLimits.get(remote);
            if (attempts == null) attempts = new ArrayList<Long>();
            for (int i = attempts.size() - 1; i >= 0; i--) if (attempts.get(i).longValue() < cutoff) attempts.remove(i);
            if (attempts.size() >= limit) {
                crashReportRateLimits.put(remote, attempts);
                return false;
            }
            attempts.add(Long.valueOf(now));
            crashReportRateLimits.put(remote, attempts);
            return true;
        }
    }

    private static void cleanCrashReports(ImpulseConfig config) {
        File[] files = config.crashReportsDirectory.listFiles();
        if (files == null) return;
        List<File> reports = new ArrayList<File>();
        long cutoff = System.currentTimeMillis() - config.crashReportsRetentionDays * 24L * 60L * 60L * 1000L;
        for (File file : files) {
            if (!file.isFile() || !isGeneratedCrashReport(file.getName())) continue;
            if (file.lastModified() < cutoff) file.delete();
            else reports.add(file);
        }
        reports.sort(new Comparator<File>() {
            public int compare(File left, File right) { return Long.compare(left.lastModified(), right.lastModified()); }
        });
        while (reports.size() > config.crashReportsMaxFiles) reports.remove(0).delete();
    }

    private static boolean isGeneratedCrashReport(String name) {
        return name != null && name.matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z-[A-Za-z0-9._-]+-[0-9a-f]{8}\\.json");
    }

    private static byte[] readLimited(InputStream input, int maximum) throws IOException, PayloadTooLargeException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(maximum, 65536));
        byte[] buffer = new byte[8192];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) >= 0) {
            total += read;
            if (total > maximum) throw new PayloadTooLargeException();
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static long parseLong(String value, long fallback) {
        try { return Long.parseLong(value); } catch (Exception ignored) { return fallback; }
    }

    private static String safeReportName(String value) {
        String clean = valueOr(value, "player").replaceAll("[^A-Za-z0-9._-]", "_");
        if (clean.length() > 32) clean = clean.substring(0, 32);
        return clean.length() == 0 ? "player" : clean;
    }

    private static String utcTimestamp() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date());
    }

    private static String jsonEscape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static void serveFile(HttpExchange exchange, File target, String contentType, boolean attachment) throws IOException {
        String method = exchange.getRequestMethod();
        boolean head = "HEAD".equalsIgnoreCase(method);
        if (!head && !"GET".equalsIgnoreCase(method)) {
            exchange.getResponseHeaders().set("Allow", "GET, HEAD");
            respond(exchange, 405, "text/plain; charset=utf-8", bytes("Method not allowed"));
            return;
        }
        long total = target.length();
        long start = 0;
        long end = total > 0 ? total - 1 : 0;
        int status = 200;

        String range = exchange.getRequestHeaders().getFirst("Range");
        if (range != null && range.startsWith("bytes=") && total > 0) {
            String spec = range.substring("bytes=".length());
            int comma = spec.indexOf(',');
            if (comma >= 0) spec = spec.substring(0, comma);
            int dash = spec.indexOf('-');
            try {
                if (dash == 0) {
                    long suffix = Long.parseLong(spec.substring(1));
                    start = Math.max(0, total - suffix);
                } else if (dash > 0) {
                    start = Long.parseLong(spec.substring(0, dash));
                    if (dash < spec.length() - 1) end = Long.parseLong(spec.substring(dash + 1));
                }
                end = Math.min(end, total - 1);
                if (start <= end) status = 206;
                else {
                    Headers headers = exchange.getResponseHeaders();
                    headers.set("Content-Range", "bytes */" + total);
                    headers.set("Access-Control-Allow-Origin", "*");
                    exchange.sendResponseHeaders(416, -1);
                    exchange.close();
                    return;
                }
            } catch (Exception ignored) {
                start = 0;
                end = total - 1;
                status = 200;
            }
        }

        long responseLength = total == 0 ? 0 : end - start + 1;
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", contentType);
        headers.set("Accept-Ranges", "bytes");
        if (status == 206) headers.set("Content-Range", "bytes " + start + "-" + end + "/" + total);
        if (attachment) headers.set("Content-Disposition", "attachment; filename=\"" + target.getName().replace("\"", "") + "\"");
        headers.set("Access-Control-Allow-Origin", "*");
        if (head) {
            headers.set("Content-Length", String.valueOf(responseLength));
            exchange.sendResponseHeaders(status, -1);
            exchange.close();
            return;
        }
        exchange.sendResponseHeaders(status, responseLength);
        FileInputStream input = new FileInputStream(target);
        try {
            skipFully(input, start);
            OutputStream output = exchange.getResponseBody();
            byte[] buffer = new byte[8192];
            int read;
            long remaining = responseLength;
            while (remaining > 0 && (read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining))) >= 0) {
                output.write(buffer, 0, read);
                remaining -= read;
            }
        } finally {
            input.close();
            exchange.close();
        }
    }

    private static void respond(HttpExchange exchange, int status, String contentType, byte[] body) throws IOException {
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", contentType);
        headers.set("Access-Control-Allow-Origin", "*");
        if ("HEAD".equalsIgnoreCase(exchange.getRequestMethod())) {
            headers.set("Content-Length", String.valueOf(body.length));
            exchange.sendResponseHeaders(status, -1);
            exchange.close();
            return;
        }
        exchange.sendResponseHeaders(status, body.length);
        OutputStream output = exchange.getResponseBody();
        try {
            output.write(body);
        } finally {
            exchange.close();
        }
    }

    private static byte[] bytes(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private static String sha1(File file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            FileInputStream input = new FileInputStream(file);
            try {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    digest.update(buffer, 0, read);
                }
            } finally {
                input.close();
            }
            StringBuilder out = new StringBuilder();
            for (byte b : digest.digest()) out.append(String.format("%02x", b));
            return out.toString();
        } catch (Exception error) {
            throw new IOException("Unable to hash " + file.getName(), error);
        }
    }

    private static synchronized String cachedSha1(File file) throws IOException {
        String key = file.getCanonicalPath();
        long modified = file.lastModified();
        long size = file.length();
        Sha1CacheEntry cached = sha1Cache.get(key);
        if (cached != null && cached.modified == modified && cached.size == size) {
            return cached.sha1;
        }
        String hash = sha1(file);
        sha1Cache.put(key, new Sha1CacheEntry(modified, size, hash));
        return hash;
    }

    private static ModMetadata readModMetadata(File file) {
        String fallbackName = stripJar(file.getName());
        try {
            JarFile jar = new JarFile(file);
            try {
                ModMetadata metadata = readTomlMetadata(jar, "META-INF/neoforge.mods.toml");
                if (!metadata.isEmpty()) return metadata.withFallback(fallbackName);
                metadata = readTomlMetadata(jar, "META-INF/mods.toml");
                if (!metadata.isEmpty()) return metadata.withFallback(fallbackName);
                metadata = readMcmodInfoMetadata(jar);
                if (!metadata.isEmpty()) return metadata.withFallback(fallbackName);
                metadata = readPackMetadata(jar);
                if (!metadata.isEmpty()) return metadata.withFallback(fallbackName);
            } finally {
                jar.close();
            }
        } catch (Exception ignored) {
        }
        return new ModMetadata("", fallbackName, "");
    }

    private static ModMetadata readTomlMetadata(JarFile jar, String path) throws IOException {
        String text = readJarText(jar, path);
        if (text == null) return ModMetadata.empty();
        String displayName = firstTomlValue(text, "displayName");
        String description = firstTomlValue(text, "description");
        String modId = firstTomlValue(text, "modId");
        return new ModMetadata(modId, displayName, description);
    }

    private static ModMetadata readMcmodInfoMetadata(JarFile jar) throws IOException {
        String text = readJarText(jar, "mcmod.info");
        if (text == null) return ModMetadata.empty();
        String name = firstJsonString(text, "name");
        String description = firstJsonString(text, "description");
        String modId = firstJsonString(text, "modid");
        return new ModMetadata(modId, name, description);
    }

    private static ModMetadata readPackMetadata(JarFile jar) throws IOException {
        String text = readJarText(jar, "pack.mcmeta");
        if (text == null) return ModMetadata.empty();
        String description = firstJsonString(text, "description");
        return new ModMetadata("", "", description);
    }

    private static String readJarText(JarFile jar, String path) throws IOException {
        ZipEntry entry = jar.getEntry(path);
        if (entry == null) return null;
        InputStream input = jar.getInputStream(entry);
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            input.close();
        }
    }

    private static String firstTomlValue(String text, String key) {
        Pattern pattern = Pattern.compile("(?m)^\\s*" + Pattern.quote(key) + "\\s*=\\s*(?:\"\"\"([\\s\\S]*?)\"\"\"|'([^']*)'|\"((?:\\\\.|[^\"])*)\")");
        Matcher matcher = pattern.matcher(text);
        if (!matcher.find()) return "";
        String value = matcher.group(1) != null ? matcher.group(1) : (matcher.group(2) != null ? matcher.group(2) : matcher.group(3));
        return cleanMetadataValue(unescapeSimple(value));
    }

    private static String firstJsonString(String text, String key) {
        Pattern pattern = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"");
        Matcher matcher = pattern.matcher(text);
        return matcher.find() ? cleanMetadataValue(unescapeSimple(matcher.group(1))) : "";
    }

    private static String unescapeSimple(String value) {
        if (value == null) return "";
        return value
            .replace("\\n", "\n")
            .replace("\\r", "\r")
            .replace("\\t", "\t")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\");
    }

    private static String cleanMetadataValue(String value) {
        if (value == null) return "";
        return value.replaceAll("\\s+", " ").trim();
    }

    private static String valueOr(String value, String fallback) {
        String clean = cleanMetadataValue(value);
        return clean.length() == 0 ? cleanMetadataValue(fallback) : clean;
    }

    private static String stripJar(String name) {
        return name.toLowerCase().endsWith(".jar") ? name.substring(0, name.length() - 4) : name;
    }

    private static String mediaUrl(ImpulseConfig config, String externalUrl, String fileName) throws IOException {
        if (fileName != null) {
            File target = new File(config.mediaDirectory, fileName).getCanonicalFile();
            File root = config.mediaDirectory.getCanonicalFile();
            if (isInside(root, target) && target.isFile()) {
                return publicUrl(config, "/impulse/media/" + urlName(target.getName()));
            }
        }
        return externalUrl;
    }

    private static String publicUrl(ImpulseConfig config, String path) {
        return "http://" + config.publicHost + ":" + config.manifestPort + path;
    }

    private static boolean isInside(File root, File target) throws IOException {
        String rootPath = root.getCanonicalPath();
        String targetPath = target.getCanonicalPath();
        return targetPath.equals(rootPath) || targetPath.startsWith(rootPath + File.separator);
    }

    private static void skipFully(FileInputStream input, long bytes) throws IOException {
        long skipped = 0;
        while (skipped < bytes) {
            long step = input.skip(bytes - skipped);
            if (step <= 0) {
                if (input.read() < 0) return;
                step = 1;
            }
            skipped += step;
        }
    }

    private static String contentType(String name) {
        String lower = name.toLowerCase();
        if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
        if (lower.endsWith(".webm")) return "video/webm";
        if (lower.endsWith(".ogv") || lower.endsWith(".ogg")) return "video/ogg";
        if (lower.endsWith(".mov")) return "video/quicktime";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private static String urlName(String name) {
        byte[] bytes = name.getBytes(StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder(bytes.length);
        for (byte raw : bytes) {
            int b = raw & 255;
            if (isUnreservedPathByte(b)) {
                out.append((char) b);
            } else {
                out.append('%');
                char high = Character.toUpperCase(Character.forDigit((b >> 4) & 15, 16));
                char low = Character.toUpperCase(Character.forDigit(b & 15, 16));
                out.append(high).append(low);
            }
        }
        return out.toString();
    }

    private static String urlPath(String value) {
        String[] parts = String.valueOf(value).replace('\\', '/').split("/");
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) out.append('/');
            out.append(urlName(parts[i]));
        }
        return out.toString();
    }

    private static boolean isUnreservedPathByte(int value) {
        return (value >= 'A' && value <= 'Z')
            || (value >= 'a' && value <= 'z')
            || (value >= '0' && value <= '9')
            || value == '-' || value == '.' || value == '_' || value == '~';
    }

    private static String decodePathSegment(String raw) throws IOException {
        byte[] bytes = new byte[raw.length() * 4];
        int length = 0;
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == '%' && i + 2 < raw.length()) {
                int high = Character.digit(raw.charAt(i + 1), 16);
                int low = Character.digit(raw.charAt(i + 2), 16);
                if (high >= 0 && low >= 0) {
                    bytes[length++] = (byte) ((high << 4) + low);
                    i += 2;
                    continue;
                }
            }
            byte[] encoded = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
            for (byte b : encoded) bytes[length++] = b;
        }
        return new String(bytes, 0, length, StandardCharsets.UTF_8);
    }

    private static String decodeRelativePath(String raw) throws IOException {
        String[] parts = String.valueOf(raw).split("/", -1);
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            String segment = decodePathSegment(parts[i]);
            if (!isSafeFileName(segment) || ".".equals(segment) || "..".equals(segment)) return "";
            if (i > 0) out.append(File.separatorChar);
            out.append(segment);
        }
        return out.toString();
    }

    private static boolean isSafeFileName(String name) {
        return name != null
            && name.length() > 0
            && name.indexOf('/') < 0
            && name.indexOf('\\') < 0
            && name.indexOf('\0') < 0;
    }

    private static boolean isSafeRelativePath(String value) {
        return value != null && value.length() > 0 && value.indexOf('\0') < 0 && !new File(value).isAbsolute();
    }

    private static String slug(String value) {
        String out = String.valueOf(value == null ? "" : value).toLowerCase().replaceAll("[^a-z0-9]+", "-");
        out = out.replaceAll("(^-+|-+$)", "");
        return out.length() == 0 ? "category" : out;
    }

    private static String cleanCategoryId(String value, String fallback) {
        String clean = slug(value);
        return clean.length() == 0 || "category".equals(clean) && (value == null || value.trim().length() == 0) ? fallback : clean;
    }

    private static boolean firstJsonBoolean(String text, String key, boolean fallback) {
        Pattern pattern = Pattern.compile("\\\"" + Pattern.quote(key) + "\\\"\\s*:\\s*(true|false)", Pattern.CASE_INSENSITIVE);
        Matcher matcher = pattern.matcher(text == null ? "" : text);
        return matcher.find() ? Boolean.parseBoolean(matcher.group(1)) : fallback;
    }

    private static int firstJsonInt(String text, String key, int fallback) {
        Pattern pattern = Pattern.compile("\\\"" + Pattern.quote(key) + "\\\"\\s*:\\s*(-?\\d+)");
        Matcher matcher = pattern.matcher(text == null ? "" : text);
        if (!matcher.find()) return fallback;
        try {
            return Integer.parseInt(matcher.group(1));
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private static final class ModFile {
        final File file;
        final String sha1;
        final String name;
        final String description;
        final String modId;
        final String relativePath;
        final String categoryId;

        ModFile(File file, String sha1, String modId, String name, String description, String relativePath, String categoryId) {
            this.file = file;
            this.sha1 = sha1;
            this.name = cleanMetadataValue(name).length() > 0 ? cleanMetadataValue(name) : stripJar(file.getName());
            this.description = cleanMetadataValue(description);
            this.modId = cleanCategoryId(modId, "");
            this.relativePath = relativePath;
            this.categoryId = categoryId;
        }
    }

    private static final class OptionalModCategory {
        final String id;
        final String name;
        final String description;
        final boolean defaultEnabled;
        final int order;

        OptionalModCategory(String id, String name, String description, boolean defaultEnabled, int order) {
            this.id = id;
            this.name = valueOr(name, id);
            this.description = cleanMetadataValue(description);
            this.defaultEnabled = defaultEnabled;
            this.order = order;
        }
    }

    private static final class OptionalModCatalog {
        final List<ModFile> mods;
        final List<OptionalModCategory> categories;

        OptionalModCatalog(List<ModFile> mods, List<OptionalModCategory> categories) {
            this.mods = mods;
            this.categories = categories;
        }
    }

    private static final class ModMetadata {
        final String modId;
        final String name;
        final String description;

        ModMetadata(String modId, String name, String description) {
            this.modId = cleanMetadataValue(modId);
            this.name = cleanMetadataValue(name);
            this.description = cleanMetadataValue(description);
        }

        static ModMetadata empty() {
            return new ModMetadata("", "", "");
        }

        boolean isEmpty() {
            return modId.length() == 0 && name.length() == 0 && description.length() == 0;
        }

        ModMetadata withFallback(String fallbackName) {
            return new ModMetadata(modId, name.length() == 0 ? fallbackName : name, description);
        }
    }

    private static final class ModRelationship {
        final String id;
        final List<String> dependencies;
        final List<String> conflicts;

        ModRelationship(String id, List<String> dependencies, List<String> conflicts) {
            this.id = cleanMetadataValue(id);
            this.dependencies = dependencies;
            this.conflicts = conflicts;
        }
    }

    private static final class Sha1CacheEntry {
        final long modified;
        final long size;
        final String sha1;

        Sha1CacheEntry(long modified, long size, String sha1) {
            this.modified = modified;
            this.size = size;
            this.sha1 = sha1;
        }
    }

    private static final class PayloadTooLargeException extends Exception {
        private static final long serialVersionUID = 1L;
    }

    private static final class ManifestCacheEntry {
        final String signature;
        final String json;

        ManifestCacheEntry(String signature, String json) {
            this.signature = signature;
            this.json = json;
        }
    }

    private static final class BoundServer {
        final HttpServer server;
        final ExecutorService executor;
        BoundServer(HttpServer server, ExecutorService executor) { this.server = server; this.executor = executor; }
    }

    public static final class ReloadResult {
        public final boolean success;
        public final String message;
        ReloadResult(boolean success, String message) { this.success = success; this.message = message; }
    }
}
