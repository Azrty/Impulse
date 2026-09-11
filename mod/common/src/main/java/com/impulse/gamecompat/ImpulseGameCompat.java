package com.impulse.gamecompat;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.impulse.bootstrap.StandaloneLaunchLog;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.KeyFactory;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.net.URLClassLoader;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Signed catalog, installation state and reversible patch lifecycle for standalone profiles. */
public final class ImpulseGameCompat {
    public static final String CATALOG_URL = "https://api.impulsemc.com/v1/game-compat/patches";
    public static final String PATCH_ORIGIN = "https://impulse.epivalent.com";
    public static final String PINNED_PUBLIC_KEY = "MCowBQYDK2VwAyEAvAE2_S2pNOY7-NkyaN5Kydm1Jlq2g8XkVW2THKbkXRs";
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Pattern MOD_ID = Pattern.compile("(?m)^\\s*modId\\s*=\\s*[\"']([^\"']+)[\"']");
    private static final Pattern VERSION = Pattern.compile("(?m)^\\s*version\\s*=\\s*[\"']([^\"']+)[\"']");
    private static final Map<String, ActivePatch> ACTIVE = new ConcurrentHashMap<String, ActivePatch>();
    private static final List<URLClassLoader> STARTUP_LOADERS = new ArrayList<URLClassLoader>();
    private static volatile Catalog memoryCatalog;
    private static volatile long memoryCatalogAt;

    private ImpulseGameCompat() { }

    public static Snapshot inspect(File gameDirectory, String profileId, String minecraftVersion, String loader) {
        return inspect(gameDirectory, profileId, minecraftVersion, loader, true);
    }

    public static Snapshot inspectCached(File gameDirectory, String profileId, String minecraftVersion, String loader) {
        return inspect(gameDirectory, profileId, minecraftVersion, loader, false);
    }

    private static Snapshot inspect(File gameDirectory, String profileId, String minecraftVersion, String loader, boolean refresh) {
        State state = loadState(gameDirectory, profileId);
        Catalog catalog;
        String error = null;
        try { catalog = refresh ? loadCatalog(gameDirectory) : cachedCatalog(gameDirectory); }
        catch (Exception failure) {
            catalog = cachedCatalog(gameDirectory);
            error = readable(failure);
        }
        Map<String, String> mods = scanInstalledMods(gameDirectory, profileId);
        List<PatchView> views = new ArrayList<PatchView>();
        Set<String> applicableIds = new HashSet<String>();
        for (Patch patch : newestApplicable(catalog, minecraftVersion, loader, mods)) {
            applicableIds.add(patch.id);
            Installed installed = state.patches.get(patch.id);
            PatchView view = new PatchView();
            view.id = patch.id;
            view.name = patch.name;
            view.description = patch.description;
            view.version = patch.version;
            view.mode = patch.mode;
            view.enabled = installed != null && installed.enabled;
            view.installed = installed != null && validInstalled(gameDirectory, profileId, installed);
            view.update_available = view.installed && !patch.version.equals(installed.version);
            view.status = view.installed ? (view.enabled ? ("startup".equals(patch.mode) ? "Restart required" : "Active") : "Disabled") : "Available";
            views.add(view);
        }
        for (Installed installed : state.patches.values()) {
            if (applicableIds.contains(installed.id)) continue;
            PatchView view = new PatchView();
            view.id = installed.id; view.name = installed.name; view.version = installed.version; view.mode = installed.mode;
            view.installed = validInstalled(gameDirectory, profileId, installed); view.enabled = installed.enabled;
            view.status = view.installed ? "Incompatible" : "Error";
            views.add(view);
        }
        Collections.sort(views, Comparator.comparing(value -> value.name.toLowerCase(Locale.ROOT)));
        Snapshot snapshot = new Snapshot();
        snapshot.patches = views;
        snapshot.catalog_available = catalog != null;
        snapshot.error = error;
        snapshot.recovery_available = state.recovery_available;
        snapshot.recovery_disabled = state.recovery_disabled;
        snapshot.offer_signature = offerSignature(views);
        snapshot.offer_required = !snapshot.offer_signature.isEmpty() && !snapshot.offer_signature.equals(state.dismissed_offer_signature)
            && views.stream().anyMatch(value -> !value.installed);
        return snapshot;
    }

    public static Snapshot install(File gameDirectory, String profileId, String minecraftVersion, String loader,
                                   List<String> selectedIds, Progress progress) throws IOException {
        Catalog catalog = loadCatalog(gameDirectory);
        Map<String, String> mods = scanInstalledMods(gameDirectory, profileId);
        Map<String, Patch> available = new HashMap<String, Patch>();
        for (Patch patch : newestApplicable(catalog, minecraftVersion, loader, mods)) available.put(patch.id, patch);
        State state = loadState(gameDirectory, profileId);
        File directory = patchDirectory(gameDirectory, profileId);
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Could not create the Game Compat patch directory.");
        int current = 0;
        for (String id : selectedIds == null ? Collections.<String>emptyList() : selectedIds) {
            Patch patch = available.get(id);
            if (patch == null) continue;
            progress.update("Downloading " + patch.name, current, selectedIds.size());
            File target = new File(directory, patch.file_name);
            if (!target.isFile() || target.length() != patch.size || !patch.sha512.equals(sha512(target))) download(patch, target);
            validateDescriptor(target, patch);
            Installed previous = state.patches.get(id);
            if (previous != null && previous.file_name != null && !previous.file_name.equals(patch.file_name)) Files.deleteIfExists(new File(directory, previous.file_name).toPath());
            Installed installed = new Installed();
            installed.id = patch.id;
            installed.name = patch.name;
            installed.version = patch.version;
            installed.mode = patch.mode;
            installed.file_name = patch.file_name;
            installed.sha512 = patch.sha512;
            installed.enabled = true;
            state.patches.put(id, installed);
            current++;
            progress.update("Installed " + patch.name, current, selectedIds.size());
        }
        Snapshot snapshot = inspect(gameDirectory, profileId, minecraftVersion, loader);
        state.dismissed_offer_signature = snapshot.offer_signature;
        saveState(gameDirectory, profileId, state);
        return inspect(gameDirectory, profileId, minecraftVersion, loader);
    }

    public static void dismissOffer(File gameDirectory, String profileId, String signature) throws IOException {
        State state = loadState(gameDirectory, profileId);
        state.dismissed_offer_signature = signature == null ? "" : signature;
        saveState(gameDirectory, profileId, state);
    }

    public static void disableForRecovery(File gameDirectory, String profileId) throws IOException {
        State state = loadState(gameDirectory, profileId);
        state.recovery_disabled = true;
        state.startup_attempt_pending = false;
        state.recovery_available = false;
        saveState(gameDirectory, profileId, state);
    }

    public static void updateInstalled(File gameDirectory, String profileId, String minecraftVersion, String loader, Progress progress) {
        State before = loadState(gameDirectory, profileId);
        Snapshot snapshot = inspect(gameDirectory, profileId, minecraftVersion, loader);
        List<String> updates = new ArrayList<String>();
        for (PatchView patch : snapshot.patches) if (patch.installed && patch.update_available) updates.add(patch.id);
        if (updates.isEmpty()) return;
        try {
            install(gameDirectory, profileId, minecraftVersion, loader, updates, progress);
            State after = loadState(gameDirectory, profileId);
            after.dismissed_offer_signature = before.dismissed_offer_signature;
            saveState(gameDirectory, profileId, after);
        } catch (Exception error) {
            StandaloneLaunchLog.error("game-compat", "Patch update failed; keeping the last valid version", error);
        }
    }

    public static PatchView setEnabled(File gameDirectory, String profileId, String id, boolean enabled) throws Exception {
        return setEnabled(gameDirectory, profileId, id, enabled, true);
    }

    public static PatchView setEnabledForNextLaunch(File gameDirectory, String profileId, String id, boolean enabled) throws Exception {
        return setEnabled(gameDirectory, profileId, id, enabled, false);
    }

    private static PatchView setEnabled(File gameDirectory, String profileId, String id, boolean enabled, boolean inGame) throws Exception {
        State state = loadState(gameDirectory, profileId);
        Installed installed = state.patches.get(id);
        if (installed == null) throw new IOException("Game Compat patch is not installed.");
        installed.enabled = enabled;
        if ("live".equals(installed.mode) && inGame) {
            if (enabled) activate(gameDirectory, profileId, installed);
            else deactivate(profileId, id);
        } else if ("startup".equals(installed.mode)) {
            state.startup_change_pending = true;
        }
        saveState(gameDirectory, profileId, state);
        PatchView view = new PatchView();
        view.id = id; view.name = installed.name; view.version = installed.version; view.mode = installed.mode;
        view.installed = true; view.enabled = enabled; view.status = "startup".equals(installed.mode) ? "Restart required" : (enabled ? "Active" : "Disabled");
        return view;
    }

    public static void activateLivePatches(File gameDirectory, String profileId) {
        State state = loadState(gameDirectory, profileId);
        for (Installed patch : state.patches.values()) if (patch.enabled && "live".equals(patch.mode)) {
            try { activate(gameDirectory, profileId, patch); }
            catch (Exception error) { StandaloneLaunchLog.error("game-compat", "Could not activate " + patch.name, error); }
        }
    }

    public static List<File> enabledStartupPatches(File gameDirectory, String profileId) {
        State state = loadState(gameDirectory, profileId);
        if (state.recovery_disabled) return Collections.emptyList();
        List<File> files = new ArrayList<File>();
        for (Installed patch : state.patches.values()) if (patch.enabled && "startup".equals(patch.mode)) {
            File file = new File(patchDirectory(gameDirectory, profileId), patch.file_name == null ? "" : patch.file_name);
            if (validInstalled(gameDirectory, profileId, patch)) files.add(file);
        }
        return files;
    }

    public static synchronized void activateStartupPatches(File gameDirectory, String profileId) throws IOException {
        for (File jar : enabledStartupPatches(gameDirectory, profileId)) {
            URLClassLoader loader = null;
            try {
                loader = new URLClassLoader(new URL[] { jar.toURI().toURL() }, ImpulseStartupPatch.class.getClassLoader());
                ServiceLoader<ImpulseStartupPatch> providers = ServiceLoader.load(ImpulseStartupPatch.class, loader);
                ImpulseStartupPatch patch = providers.iterator().hasNext() ? providers.iterator().next() : null;
                if (patch == null) throw new IOException("Startup patch does not provide an ImpulseStartupPatch service: " + jar.getName());
                patch.initialize(new PatchContext(gameDirectory, profileId));
                STARTUP_LOADERS.add(loader);
                loader = null;
                StandaloneLaunchLog.info("game-compat", "Activated startup patch", StandaloneLaunchLog.fields("file", jar.getName()));
            } catch (Exception error) {
                if (loader != null) try { loader.close(); } catch (IOException ignored) { }
                throw error instanceof IOException ? (IOException) error : new IOException("Could not activate startup patch " + jar.getName() + ".", error);
            }
        }
    }

    public static void markStartupAttempt(File gameDirectory, String profileId) {
        State state = loadState(gameDirectory, profileId);
        if (!enabledStartupPatches(gameDirectory, profileId).isEmpty()) {
            state.startup_attempt_pending = true;
            try { saveState(gameDirectory, profileId, state); } catch (IOException ignored) { }
        }
    }

    public static void markGameReady(File gameDirectory, String profileId) {
        State state = loadState(gameDirectory, profileId);
        state.startup_attempt_pending = false;
        state.startup_change_pending = false;
        state.recovery_disabled = false;
        try { saveState(gameDirectory, profileId, state); } catch (IOException ignored) { }
    }

    private static synchronized void activate(File gameDirectory, String profileId, Installed installed) throws Exception {
        String key = profileId + ":" + installed.id;
        if (ACTIVE.containsKey(key)) return;
        File jar = new File(patchDirectory(gameDirectory, profileId), installed.file_name);
        if (!validInstalled(gameDirectory, profileId, installed)) throw new IOException("Patch file failed SHA-512 validation.");
        URLClassLoader loader = new URLClassLoader(new URL[] { jar.toURI().toURL() }, ImpulseCompatPatch.class.getClassLoader());
        ServiceLoader<ImpulseCompatPatch> providers = ServiceLoader.load(ImpulseCompatPatch.class, loader);
        ImpulseCompatPatch implementation = providers.iterator().hasNext() ? providers.iterator().next() : null;
        if (implementation == null) { loader.close(); throw new IOException("Patch does not provide an ImpulseCompatPatch service."); }
        try { implementation.enable(new PatchContext(gameDirectory, profileId)); }
        catch (Exception failure) { try { implementation.disable(); } catch (Exception ignored) { } loader.close(); throw failure; }
        ACTIVE.put(key, new ActivePatch(implementation, loader));
    }

    private static synchronized void deactivate(String profileId, String id) throws Exception {
        ActivePatch active = ACTIVE.remove(profileId + ":" + id);
        if (active == null) return;
        try { active.patch.disable(); } finally { active.loader.close(); }
    }

    private static synchronized Catalog loadCatalog(File gameDirectory) throws IOException {
        if (memoryCatalog != null && System.currentTimeMillis() - memoryCatalogAt < 15L * 60L * 1000L) return memoryCatalog;
        String endpoint = System.getProperty("impulse.gameCompat.api", CATALOG_URL);
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        connection.setConnectTimeout(5000); connection.setReadTimeout(10000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "ImpulseGameCompat/1.0 (+https://impulsemc.com)");
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Game Compat service returned HTTP " + connection.getResponseCode() + ".");
            byte[] bytes = readLimited(connection.getInputStream(), 2 * 1024 * 1024);
            verifyCatalog(bytes, connection.getHeaderField("X-Impulse-Signature-Algorithm"), connection.getHeaderField("X-Impulse-Public-Key"), connection.getHeaderField("X-Impulse-Signature"));
            Catalog catalog = parseCatalog(bytes);
            File cache = catalogCache(gameDirectory);
            if (!cache.getParentFile().isDirectory()) cache.getParentFile().mkdirs();
            Files.write(cache.toPath(), bytes);
            JsonObject signature = new JsonObject();
            signature.addProperty("algorithm", connection.getHeaderField("X-Impulse-Signature-Algorithm"));
            signature.addProperty("public_key", connection.getHeaderField("X-Impulse-Public-Key"));
            signature.addProperty("signature", connection.getHeaderField("X-Impulse-Signature"));
            Files.write(catalogSignatureCache(gameDirectory).toPath(), signature.toString().getBytes(StandardCharsets.UTF_8));
            memoryCatalog = catalog;
            memoryCatalogAt = System.currentTimeMillis();
            return catalog;
        } finally { connection.disconnect(); }
    }

    private static void verifyCatalog(byte[] bytes, String algorithm, String publicKeyText, String signatureText) throws IOException {
        if (!"Ed25519".equals(algorithm) || publicKeyText == null || signatureText == null) throw new IOException("Game Compat catalog is not signed.");
        try {
            if (!PINNED_PUBLIC_KEY.equals(publicKeyText)) throw new IOException("Game Compat signing key is not trusted.");
            PublicKey key = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(Base64.getUrlDecoder().decode(publicKeyText)));
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(key); verifier.update(bytes);
            if (!verifier.verify(Base64.getUrlDecoder().decode(signatureText))) throw new IOException("Game Compat catalog signature is invalid.");
        } catch (IOException error) { throw error; }
        catch (Exception error) { throw new IOException("Could not verify the Game Compat catalog.", error); }
    }

    private static Catalog cachedCatalog(File gameDirectory) {
        try {
            byte[] bytes = Files.readAllBytes(catalogCache(gameDirectory).toPath());
            JsonObject signature = new JsonParser().parse(new String(Files.readAllBytes(catalogSignatureCache(gameDirectory).toPath()), StandardCharsets.UTF_8)).getAsJsonObject();
            verifyCatalog(bytes, string(signature, "algorithm"), string(signature, "public_key"), string(signature, "signature"));
            return parseCatalog(bytes);
        }
        catch (Exception ignored) { return null; }
    }

    private static Catalog parseCatalog(byte[] bytes) throws IOException {
        try {
            Catalog catalog = GSON.fromJson(new String(bytes, StandardCharsets.UTF_8), Catalog.class);
            if (catalog == null || catalog.schema_version != 1 || catalog.patches == null) throw new IOException("Invalid Game Compat catalog.");
            return catalog;
        } catch (RuntimeException error) { throw new IOException("Invalid Game Compat catalog.", error); }
    }

    private static List<Patch> newestApplicable(Catalog catalog, String minecraftVersion, String loader, Map<String, String> mods) {
        if (catalog == null) return Collections.emptyList();
        String os = os(); String arch = arch();
        Map<String, Patch> newest = new LinkedHashMap<String, Patch>();
        for (Patch patch : catalog.patches) {
            if (patch == null || !safe(patch.minecraft_versions).contains(minecraftVersion.toLowerCase(Locale.ROOT)) || !safe(patch.loaders).contains(loader.toLowerCase(Locale.ROOT))) continue;
            if (!matchesPlatform(patch.operating_systems, os) || !matchesPlatform(patch.architectures, arch) || !matchesMods(patch.required_mods, mods)) continue;
            Patch previous = newest.get(patch.id);
            if (previous == null || compareVersions(patch.version, previous.version) > 0) newest.put(patch.id, patch);
        }
        return new ArrayList<Patch>(newest.values());
    }

    private static boolean matchesMods(List<RequiredMod> required, Map<String, String> mods) {
        if (required == null || required.isEmpty()) return false;
        for (RequiredMod item : required) {
            String actual = mods.get(item.id == null ? "" : item.id.toLowerCase(Locale.ROOT));
            if (actual == null || !matchesVersion(actual, item.version_range)) return false;
        }
        return true;
    }

    static boolean matchesVersion(String actual, String range) {
        if (range == null || range.trim().isEmpty() || "*".equals(range.trim())) return true;
        String value = range.trim();
        if ((value.startsWith("[") || value.startsWith("(")) && (value.endsWith("]") || value.endsWith(")")) && value.contains(",")) {
            String[] bounds = value.substring(1, value.length() - 1).split(",", -1);
            if (!bounds[0].isEmpty() && (compareVersions(actual, bounds[0]) < 0 || (value.startsWith("(") && compareVersions(actual, bounds[0]) == 0))) return false;
            return bounds[1].isEmpty() || (compareVersions(actual, bounds[1]) < 0 || (value.endsWith("]") && compareVersions(actual, bounds[1]) == 0));
        }
        for (String condition : value.split("\\s+")) {
            if (condition.startsWith(">=") && compareVersions(actual, condition.substring(2)) < 0) return false;
            else if (condition.startsWith("<=") && compareVersions(actual, condition.substring(2)) > 0) return false;
            else if (condition.startsWith(">") && compareVersions(actual, condition.substring(1)) <= 0) return false;
            else if (condition.startsWith("<") && compareVersions(actual, condition.substring(1)) >= 0) return false;
            else if (!condition.startsWith(">") && !condition.startsWith("<") && !actual.equalsIgnoreCase(condition)) return false;
        }
        return true;
    }

    static int compareVersions(String left, String right) {
        String[] a = cleanVersion(left).split("[.-]"); String[] b = cleanVersion(right).split("[.-]");
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            String av = i < a.length ? a[i] : "0", bv = i < b.length ? b[i] : "0";
            int comparison;
            try { comparison = Integer.compare(Integer.parseInt(av), Integer.parseInt(bv)); }
            catch (NumberFormatException ignored) { comparison = av.compareToIgnoreCase(bv); }
            if (comparison != 0) return comparison;
        }
        return 0;
    }

    private static String cleanVersion(String value) { return value == null ? "0" : value.replaceAll("^[^0-9]*", ""); }
    private static boolean matchesPlatform(List<String> values, String actual) { return safe(values).contains("any") || safe(values).contains(actual); }
    private static List<String> safe(List<String> values) { return values == null ? Collections.<String>emptyList() : values; }

    private static Map<String, String> scanInstalledMods(File gameDirectory, String profileId) {
        Map<String, String> result = new HashMap<String, String>();
        for (File directory : Arrays.asList(new File(gameDirectory, "mods"), new File(profileRoot(gameDirectory, profileId), "mods"), new File(profileRoot(gameDirectory, profileId), "custom_mods"))) {
            File[] jars = directory.listFiles((parent, name) -> name.toLowerCase(Locale.ROOT).endsWith(".jar"));
            if (jars == null) continue;
            for (File jar : jars) readModMetadata(jar, result);
        }
        return result;
    }

    private static void readModMetadata(File file, Map<String, String> result) {
        try (JarFile jar = new JarFile(file)) {
            String text = readEntry(jar, "META-INF/neoforge.mods.toml");
            if (text == null) text = readEntry(jar, "META-INF/mods.toml");
            if (text == null) return;
            Matcher ids = MOD_ID.matcher(text), versions = VERSION.matcher(text);
            String version = versions.find() ? versions.group(1).trim() : "unknown";
            while (ids.find()) result.putIfAbsent(ids.group(1).trim().toLowerCase(Locale.ROOT), version);
        } catch (Exception ignored) { }
    }

    private static String readEntry(JarFile jar, String path) throws IOException {
        JarEntry entry = jar.getJarEntry(path); if (entry == null) return null;
        return new String(readLimited(jar.getInputStream(entry), 1024 * 1024), StandardCharsets.UTF_8);
    }

    private static void download(Patch patch, File target) throws IOException {
        URL url = new URL(patch.download_url);
        if (!"https".equalsIgnoreCase(url.getProtocol()) || !"impulse.epivalent.com".equalsIgnoreCase(url.getHost()) || !url.getPath().startsWith("/patches/")) throw new IOException("Patch download URL is not trusted.");
        File part = new File(target.getParentFile(), target.getName() + ".part");
        IOException failure = null;
        for (int attempt = 1; attempt <= 3; attempt++) {
            try {
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(10000); connection.setReadTimeout(30000);
                connection.setRequestProperty("User-Agent", "ImpulseGameCompat/1.0 (+https://impulsemc.com)");
                if (connection.getResponseCode() != 200) throw new IOException("Patch download returned HTTP " + connection.getResponseCode() + ".");
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(part)) {
                    byte[] buffer = new byte[65536]; long total = 0; int count;
                    while ((count = input.read(buffer)) != -1) { total += count; if (total > patch.size) throw new IOException("Patch exceeds its declared size."); output.write(buffer, 0, count); }
                } finally { connection.disconnect(); }
                if (part.length() != patch.size || !patch.sha512.equals(sha512(part))) throw new IOException("Patch failed SHA-512 validation.");
                try { Files.move(part.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
                catch (Exception ignored) { Files.move(part.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING); }
                return;
            } catch (IOException error) { failure = error; Files.deleteIfExists(part.toPath()); try { Thread.sleep(attempt * 500L); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException("Patch download cancelled."); } }
        }
        throw failure == null ? new IOException("Patch download failed.") : failure;
    }

    private static void validateDescriptor(File file, Patch expected) throws IOException {
        try (JarFile jar = new JarFile(file)) {
            String text = readEntry(jar, "META-INF/impulse-patch.json");
            if (text == null) throw new IOException("Patch is missing META-INF/impulse-patch.json.");
            JsonObject descriptor = new JsonParser().parse(text).getAsJsonObject();
            if (!expected.id.equals(string(descriptor, "id")) || !expected.version.equals(string(descriptor, "version")) || !expected.mode.equals(string(descriptor, "mode"))) throw new IOException("Patch metadata does not match the signed catalog.");
        } catch (RuntimeException error) { throw new IOException("Patch metadata is invalid.", error); }
    }

    private static boolean validInstalled(File gameDirectory, String profileId, Installed patch) {
        try { File file = new File(patchDirectory(gameDirectory, profileId), patch.file_name); return file.isFile() && patch.sha512.equals(sha512(file)); }
        catch (Exception ignored) { return false; }
    }

    private static State loadState(File gameDirectory, String profileId) {
        File file = stateFile(gameDirectory, profileId);
        if (!file.isFile()) return new State();
        try {
            State state = GSON.fromJson(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8), State.class);
            if (state == null) state = new State(); if (state.patches == null) state.patches = new LinkedHashMap<String, Installed>();
            if (state.startup_attempt_pending) state.recovery_available = true;
            return state;
        } catch (Exception ignored) { return new State(); }
    }

    private static void saveState(File gameDirectory, String profileId, State state) throws IOException {
        File file = stateFile(gameDirectory, profileId); if (!file.getParentFile().isDirectory()) file.getParentFile().mkdirs();
        File temporary = new File(file.getParentFile(), file.getName() + ".tmp");
        Files.write(temporary.toPath(), GSON.toJson(state).getBytes(StandardCharsets.UTF_8));
        try { Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
        catch (Exception ignored) { Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING); }
    }

    private static String offerSignature(List<PatchView> patches) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (PatchView patch : patches) if (!patch.installed) digest.update((patch.id + ":" + patch.version + ":" + patch.mode + "\n").getBytes(StandardCharsets.UTF_8));
            return hex(digest.digest());
        } catch (Exception ignored) { return ""; }
    }

    private static String sha512(File file) throws IOException {
        final MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-512");
        } catch (GeneralSecurityException error) {
            throw new IOException("SHA-512 is unavailable.", error);
        }
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        return hex(digest.digest());
    }
    private static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(bytes.length * 2); for (byte value : bytes) out.append(String.format("%02x", value & 255)); return out.toString(); }
    private static byte[] readLimited(InputStream input, int limit) throws IOException { try { ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count; while ((count = input.read(buffer)) != -1) { if (out.size() + count > limit) throw new IOException("Response exceeds size limit."); out.write(buffer, 0, count); } return out.toByteArray(); } finally { input.close(); } }
    private static String readEntryText(JarFile jar, String name) throws IOException { return readEntry(jar, name); }
    private static String string(JsonObject object, String key) { return object.has(key) ? object.get(key).getAsString() : ""; }
    private static String readable(Throwable error) { return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage(); }
    private static String os() { String value = System.getProperty("os.name", "").toLowerCase(Locale.ROOT); return value.contains("mac") ? "macos" : value.contains("win") ? "windows" : "linux"; }
    private static String arch() { String value = System.getProperty("os.arch", "").toLowerCase(Locale.ROOT); return value.contains("aarch64") || value.contains("arm64") ? "arm64" : "x64"; }
    private static File profileRoot(File gameDirectory, String profileId) { return new File(new File(new File(gameDirectory, "impulse"), "standalone"), profileId); }
    private static File patchDirectory(File gameDirectory, String profileId) { return new File(profileRoot(gameDirectory, profileId), "patches"); }
    private static File stateFile(File gameDirectory, String profileId) { return new File(profileRoot(gameDirectory, profileId), "game-compat.json"); }
    private static File catalogCache(File gameDirectory) { return new File(new File(new File(gameDirectory, "impulse/standalone/cache"), "game-compat"), "catalog.json"); }
    private static File catalogSignatureCache(File gameDirectory) { return new File(catalogCache(gameDirectory).getParentFile(), "catalog-signature.json"); }

    public interface Progress { void update(String message, int completed, int total); }
    public static final class Snapshot { public boolean catalog_available; public boolean offer_required, recovery_available, recovery_disabled; public String offer_signature = ""; public String error; public List<PatchView> patches = new ArrayList<PatchView>(); }
    public static final class PatchView { public String id, name, description, version, mode, status; public boolean installed, enabled, update_available; }
    public static final class Catalog { public int schema_version; public List<Patch> patches = new ArrayList<Patch>(); }
    public static final class Patch { public String id, name, description, version, mode, download_url, file_name, sha512; public long size; public List<String> minecraft_versions, loaders, operating_systems, architectures; public List<RequiredMod> required_mods; }
    public static final class RequiredMod { public String id, version_range; }
    public static final class State { public int schema_version = 1; public Map<String, Installed> patches = new LinkedHashMap<String, Installed>(); public String dismissed_offer_signature = ""; public boolean startup_change_pending, startup_attempt_pending, recovery_available, recovery_disabled; }
    public static final class Installed { public String id, name, version, mode, file_name, sha512; public boolean enabled; }
    private static final class ActivePatch { final ImpulseCompatPatch patch; final URLClassLoader loader; ActivePatch(ImpulseCompatPatch patch, URLClassLoader loader) { this.patch = patch; this.loader = loader; } }
}
