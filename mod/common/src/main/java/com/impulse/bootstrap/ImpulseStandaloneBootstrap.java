package com.impulse.bootstrap;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Hashtable;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.naming.directory.Attribute;
import javax.naming.directory.Attributes;
import javax.naming.directory.DirContext;
import javax.naming.directory.InitialDirContext;

/**
 * Loader-neutral standalone bootstrap used before Forge or NeoForge finishes mod discovery.
 */
public final class ImpulseStandaloneBootstrap {
    public static final String LEGAL_DOCUMENT_VERSION = "2026-08-20.2";
    public static final String OUTDATED_HASH_MESSAGE = "This server uses an outdated mod manifest that does not provide SHA-512 hashes. Ask the server owner to update Impulse.";
    public static final String SERVER_ACCESS_RESTRICTED_HEADING = "Access to this server has been restricted by Impulse";
    public static final String PRIVACY_POLICY_URL = "https://impulsemc.com/privacy/";
    public static final String TERMS_OF_SERVICE_URL = "https://impulsemc.com/terms/";
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final int DEFAULT_MINECRAFT_PORT = 25565;
    private static final int DEFAULT_MANIFEST_PORT = 25850;
    private static final int MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
    private static final String CURSEFORGE_VERIFICATION_URL = "https://api.impulsemc.com/v1/mod-verification/curseforge";
    private static final String BLOCKED_SERVERS_URL = "https://api.impulsemc.com/v1/security/blocked-servers";
    private static final Pattern MOTD_PORT = Pattern.compile("\\[impulse:(\\d{1,5})]", Pattern.CASE_INSENSITIVE);
    private static final Pattern TEXT_PORT = Pattern.compile("(?:impulse[-_\\s]*(?:manifest[-_\\s]*)?|manifest[-_\\s]*)port\\s*[:=]\\s*(\\d{1,5})", Pattern.CASE_INSENSITIVE);
    private static final Pattern TOML_MOD_ID = Pattern.compile("(?m)^\\s*modId\\s*=\\s*[\"']([^\"']+)[\"']");
    private static final String UI_BUNDLE_VERSION = "webview-2";
    private static final long UI_READY_TIMEOUT_MS = 65000L;
    private static volatile ProgressReporter progressReporter = ProgressReporter.NONE;
    private static volatile boolean skippedGlobalRestoreHookRegistered;
    private static volatile JsonObject blockedServersCache;
    private static volatile long blockedServersCacheExpiresAt;

    private ImpulseStandaloneBootstrap() {
    }

    public static boolean isLauncherLaunch() {
        return Boolean.parseBoolean(System.getProperty("impulse.client", "false"));
    }

    public static void setProgressReporter(ProgressReporter reporter) {
        progressReporter = reporter == null ? ProgressReporter.NONE : reporter;
    }

    public static UiOutcome configureWithNativeUi(final File gameDirectory, final String minecraftVersion, final String loader, final String loaderVersion) {
        progressReporter.begin("Impulse: waiting for profile selection", 1);
        Process process = null;
        File sessionDirectory = null;
        try {
            restoreSkippedGlobalMods(gameDirectory);
            UiBundle bundle = extractUiBundle(gameDirectory);
            File sessions = new File(new File(standaloneRoot(gameDirectory), "ui"), "sessions");
            if (!sessions.exists() && !sessions.mkdirs()) throw new IOException("Could not create Impulse UI session directory.");
            sessionDirectory = new File(sessions, Long.toHexString(System.currentTimeMillis()) + "-" + Integer.toHexString((int) (Math.random() * Integer.MAX_VALUE)));
            if (!sessionDirectory.mkdirs()) throw new IOException("Could not create Impulse UI session.");

            UiRequest request = new UiRequest();
            request.game_directory = gameDirectory.getAbsolutePath();
            request.minecraft_version = clean(minecraftVersion, "");
            request.loader = clean(loader, "");
            request.loader_version = clean(loaderVersion, "");
            request.session_directory = sessionDirectory.getAbsolutePath();
            request.assets_directory = bundle.assetsDirectory.getAbsolutePath();
            request.parent_pid = currentProcessId();
            request.impulse_version = currentImpulseVersion();
            File requestFile = new File(sessionDirectory, "request.json");
            writeTextAtomic(requestFile, GSON.toJson(request));

            File logFile = new File(new File(standaloneRoot(gameDirectory), "ui"), "latest.log");
            FileOutputStream truncate = new FileOutputStream(logFile, false);
            truncate.close();
            File java = new File(new File(System.getProperty("java.home"), "bin"), isWindows() ? "java.exe" : "java");
            List<String> command = new ArrayList<String>();
            command.add(java.getAbsolutePath());
            if (isMac()) command.add("-XstartOnFirstThread");
            command.add("-Xmx384m");
            command.add("-Dfile.encoding=UTF-8");
            command.add("-cp");
            command.add(bundle.classpath);
            command.add("com.impulse.standalone.ui.ImpulseStandaloneUi");
            command.add(requestFile.getAbsolutePath());

            System.out.println("[Impulse] Opening standalone profile selector. Log: " + logFile);
            ProcessBuilder processBuilder = new ProcessBuilder(command)
                .directory(bundle.rootDirectory)
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(logFile));
            process = processBuilder.start();

            File ready = new File(sessionDirectory, "ready");
            File resultFile = new File(sessionDirectory, "result.json");
            long started = System.currentTimeMillis();
            long readyAt = 0L;
            while (true) {
                UiResult result = readUiResult(resultFile);
                if (result != null) {
                    boolean selected = "selected".equals(result.status) && activeProfile(loadStore(gameDirectory)) != null;
                    if (selected) {
                        registerSkippedGlobalRestore(gameDirectory);
                        System.out.println("[Impulse] Standalone profile selected: " + clean(result.profile_id, "unknown"));
                        return UiOutcome.SELECTED;
                    }
                    if ("quit".equals(result.status)) {
                        System.out.println("[Impulse] Standalone legal terms were not accepted. Minecraft will close.");
                        return UiOutcome.QUIT;
                    }
                    System.out.println("[Impulse] Standalone selector requested the in-game fallback.");
                    markSetupRequired();
                    return UiOutcome.FALLBACK;
                }
                if (!process.isAlive()) {
                    System.err.println("[Impulse] Standalone selector exited before selecting a profile.");
                    return nativeUiFailureOutcome(gameDirectory);
                }
                long now = System.currentTimeMillis();
                if (readyAt == 0L && ready.isFile()) readyAt = now;
                if (readyAt == 0L && now - started > UI_READY_TIMEOUT_MS) {
                    System.err.println("[Impulse] Standalone selector did not create a window within 60 seconds.");
                    return nativeUiFailureOutcome(gameDirectory);
                }
                Thread.sleep(200L);
            }
        } catch (Throwable error) {
            System.err.println("[Impulse] Standalone selector failed: " + error.getMessage());
            return nativeUiFailureOutcome(gameDirectory);
        } finally {
            stopUiProcess(process);
            if (sessionDirectory != null) deleteTree(sessionDirectory);
            progressReporter.end();
        }
    }

    private static void stopUiProcess(Process process) {
        if (process == null || !process.isAlive()) return;
        try {
            // A successful UI action schedules native WebView termination. Give it time to
            // unwind WKWebView/WebView2/WebKitGTK and release its bridge callbacks first.
            if (process.waitFor(5L, TimeUnit.SECONDS)) return;
            process.destroy();
            if (process.waitFor(2L, TimeUnit.SECONDS)) return;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
        if (process.isAlive()) process.destroyForcibly();
    }

    private static long currentProcessId() {
        try {
            String runtimeName = java.lang.management.ManagementFactory.getRuntimeMXBean().getName();
            int separator = runtimeName.indexOf('@');
            return Long.parseLong(separator < 0 ? runtimeName : runtimeName.substring(0, separator));
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private static String currentImpulseVersion() {
        InputStream input = null;
        try {
            input = ImpulseStandaloneBootstrap.class.getResourceAsStream("/impulse-version.properties");
            if (input == null) return clean(System.getProperty("impulse.version"), "unknown");
            Properties properties = new Properties();
            properties.load(input);
            return clean(properties.getProperty("version"), "unknown");
        } catch (Exception ignored) {
            return clean(System.getProperty("impulse.version"), "unknown");
        } finally {
            if (input != null) try { input.close(); } catch (IOException ignored) { }
        }
    }

    public static void markSetupRequired() {
        System.setProperty("impulse.standalone.setup_required", "true");
        System.clearProperty("impulse.standalone");
        System.clearProperty("impulse.standalone.profile_id");
    }

    private static UiOutcome nativeUiFailureOutcome(File gameDirectory) {
        if (!hasAcceptedStandaloneLegal(gameDirectory)) {
            System.err.println("[Impulse] The standalone legal documents have not been accepted; Minecraft will close.");
            return UiOutcome.QUIT;
        }
        markSetupRequired();
        return UiOutcome.FALLBACK;
    }

    private static boolean hasAcceptedStandaloneLegal(File gameDirectory) {
        File file = new File(new File(new File(gameDirectory, "impulse"), "standalone"), "legal.json");
        if (!file.isFile()) return false;
        FileInputStream input = null;
        try {
            input = new FileInputStream(file);
            JsonElement parsed = new JsonParser().parse(readAll(input, 64 * 1024));
            return parsed.isJsonObject() && parsed.getAsJsonObject().has("version")
                && LEGAL_DOCUMENT_VERSION.equals(parsed.getAsJsonObject().get("version").getAsString());
        } catch (Exception ignored) {
            return false;
        } finally {
            closeQuietly(input);
        }
    }

    private static UiResult readUiResult(File file) {
        if (file == null || !file.isFile()) return null;
        FileInputStream input = null;
        try {
            input = new FileInputStream(file);
            return GSON.fromJson(readAll(input, 64 * 1024), UiResult.class);
        } catch (Exception ignored) {
            return null;
        } finally {
            closeQuietly(input);
        }
    }

    private static UiBundle extractUiBundle(File gameDirectory) throws IOException {
        File sourceJar = locateBootstrapJar(gameDirectory);
        File uiRoot = new File(new File(standaloneRoot(gameDirectory), "ui"), UI_BUNDLE_VERSION);
        File marker = new File(uiRoot, ".bundle");
        String expectedMarker = sourceJar.length() + ":" + sourceJar.lastModified();
        boolean ready = marker.isFile();
        if (ready) {
            FileInputStream input = new FileInputStream(marker);
            try { ready = expectedMarker.equals(readAll(input, 1024)); } finally { input.close(); }
        }
        if (!ready) {
            deleteTree(uiRoot);
            if (!uiRoot.mkdirs()) throw new IOException("Could not create Impulse UI bundle directory.");
            JarFile jar = new JarFile(sourceJar);
            try {
                Enumeration<JarEntry> entries = jar.entries();
                while (entries.hasMoreElements()) {
                    JarEntry entry = entries.nextElement();
                    String name = entry.getName();
                    if (entry.isDirectory() || !name.startsWith("impulse-standalone-ui/")) continue;
                    String relative = name.substring("impulse-standalone-ui/".length());
                    if (relative.length() == 0) continue;
                    File target = new File(uiRoot, relative);
                    String rootPath = uiRoot.getCanonicalPath() + File.separator;
                    if (!target.getCanonicalPath().startsWith(rootPath)) throw new IOException("Invalid Impulse UI bundle path.");
                    File parent = target.getParentFile();
                    if (!parent.exists() && !parent.mkdirs()) throw new IOException("Could not create " + parent);
                    File temporary = new File(parent, target.getName() + ".part");
                    InputStream input = jar.getInputStream(entry);
                    FileOutputStream output = new FileOutputStream(temporary);
                    try {
                        byte[] buffer = new byte[64 * 1024];
                        int read;
                        while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
                    } finally {
                        try { input.close(); } finally { output.close(); }
                    }
                    moveAtomic(temporary, target);
                }
            } finally {
                jar.close();
            }
            writeTextAtomic(marker, expectedMarker);
        }

        List<File> jars = new ArrayList<File>();
        collectJars(uiRoot, jars);
        Collections.sort(jars, new Comparator<File>() {
            public int compare(File left, File right) { return left.getName().compareToIgnoreCase(right.getName()); }
        });
        StringBuilder classpath = new StringBuilder();
        boolean hasHelper = false;
        for (File jar : jars) {
            if (jar.getName().startsWith("impulse-standalone-ui-")) hasHelper = true;
            if (classpath.length() > 0) classpath.append(File.pathSeparator);
            classpath.append(jar.getAbsolutePath());
        }
        if (!hasHelper) throw new IOException("The embedded Impulse selector is missing.");
        cleanupOldUiBundles(uiRoot);
        return new UiBundle(classpath.toString(), new File(uiRoot, "assets"), uiRoot);
    }

    private static void cleanupOldUiBundles(File activeRoot) {
        File parent = activeRoot.getParentFile();
        File[] entries = parent == null ? null : parent.listFiles();
        if (entries == null) return;
        for (File entry : entries) {
            if (!entry.isDirectory() || entry.equals(activeRoot) || "sessions".equals(entry.getName()) || "cache".equals(entry.getName())) continue;
            try { deleteTree(entry); }
            catch (Throwable error) { System.err.println("[Impulse] Could not remove old standalone UI bundle " + entry.getName() + ": " + error.getMessage()); }
        }
    }

    private static void collectJars(File directory, List<File> output) {
        File[] files = directory.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (file.isDirectory()) collectJars(file, output);
            else if (file.getName().toLowerCase(Locale.US).endsWith(".jar")) output.add(file);
        }
    }

    private static File locateBootstrapJar(File gameDirectory) throws IOException {
        try {
            URI uri = ImpulseStandaloneBootstrap.class.getProtectionDomain().getCodeSource().getLocation().toURI();
            if ("file".equalsIgnoreCase(uri.getScheme())) {
                File file = new File(uri);
                if (file.isFile()) return file;
            }
        } catch (Exception ignored) {
        }
        File modsDirectory = new File(gameDirectory, "mods");
        File[] jars = modsDirectory.listFiles((directory, name) -> name.toLowerCase(Locale.US).endsWith(".jar"));
        if (jars != null) {
            for (File file : jars) {
                JarFile jar = null;
                try {
                    jar = new JarFile(file);
                    if (jar.getJarEntry("impulse-runtime.embedded") != null
                        && jar.getJarEntry("com/impulse/bootstrap/ImpulseStandaloneBootstrap.class") != null) return file;
                } catch (IOException ignored) {
                } finally {
                    if (jar != null) try { jar.close(); } catch (IOException ignored) { }
                }
            }
        }
        throw new IOException("Could not locate the installed Impulse bootstrap jar.");
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.US).contains("win");
    }

    private static boolean isMac() {
        return System.getProperty("os.name", "").toLowerCase(Locale.US).contains("mac");
    }

    /**
     * Candidate locator jars are loaded in FML's service layer and excluded from the normal
     * mods-folder scan. Materialize the same jar outside mods so the locator can add it back as
     * the actual Impulse mod without requiring users to install a second file.
     */
    public static File prepareRuntimeMod(File gameDirectory, Class<?> locatorClass) throws IOException {
        File runtimeDirectory = new File(standaloneRoot(gameDirectory), "runtime");
        if (!runtimeDirectory.exists() && !runtimeDirectory.mkdirs()) {
            throw new IOException("Could not create Impulse runtime directory: " + runtimeDirectory);
        }

        File target = new File(runtimeDirectory, "impulse-runtime.jar");
        File temporary = new File(runtimeDirectory, "impulse-runtime.jar.part");
        InputStream embedded = locatorClass.getResourceAsStream("/impulse-runtime.embedded");
        if (embedded == null) throw new IOException("The embedded Impulse runtime is missing from the installed jar.");
        FileOutputStream output = new FileOutputStream(temporary);
        try {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = embedded.read(buffer)) >= 0) output.write(buffer, 0, read);
        } finally {
            try { embedded.close(); } finally { output.close(); }
        }
        if (target.isFile() && target.length() == temporary.length() && sha1(target).equals(sha1(temporary))) {
            Files.deleteIfExists(temporary.toPath());
            return target;
        }
        moveAtomic(temporary, target);
        return target;
    }

    public static BootstrapResult bootstrap(File gameDirectory, String minecraftVersion, String loader, String loaderVersion) throws Exception {
        if (isLauncherLaunch()) return BootstrapResult.inactive();
        File root = standaloneRoot(gameDirectory);
        Store store = loadStore(gameDirectory);
        Profile profile = activeProfile(store);
        if (profile == null) {
            System.setProperty("impulse.standalone.setup_required", "true");
            return BootstrapResult.setupRequired();
        }

        Discovery discovery;
        progressReporter.begin("Impulse: contacting " + profile.address, 2);
        try {
            progressReporter.progress("Impulse: contacting " + profile.address, 0, 2);
            discovery = discover(profile.address, profile.manifest_public_key);
            progressReporter.progress("Impulse: checking manifest", 1, 2);
            validateRuntime(discovery.manifest, minecraftVersion, loader, loaderVersion);
            progressReporter.progress("Impulse: manifest verified", 2, 2);
        } finally {
            progressReporter.end();
        }
        profile = prepareProfileForLaunch(gameDirectory, discovery, profile.selected_optional_ids);
        File profileRoot = new File(root, profile.id);
        File managedMods = new File(profileRoot, "mods");
        List<ManifestMod> problems = problematicMods(discovery.manifest, profile.selected_optional_ids);
        String problemSignature = problematicSignature(problems);
        if (!problems.isEmpty() && !problemSignature.equals(profile.accepted_unverified_mod_signature)) {
            System.setProperty("impulse.standalone.setup_required", "true");
            return BootstrapResult.setupRequired();
        }
        publishRuntime(gameDirectory, profile, discovery.manifest);
        List<File> customModFiles = validatedCustomModFiles(gameDirectory, profile, managedMods);
        return new BootstrapResult(true, false, managedMods, customModsDirectory(gameDirectory, profile.id), customModFiles, profile, discovery.manifest);
    }

    public static Discovery discover(String input) throws IOException {
        return discover(input, null, true);
    }

    public static Discovery discoverForSetup(String input) throws IOException {
        return discover(input, null, false);
    }

    public static RestrictedServerException serverRestriction(String input) throws IOException {
        Address address = parseAddress(input);
        try {
            assertServerAllowed(address.host);
            return null;
        } catch (RestrictedServerException restricted) {
            return restricted;
        }
    }

    private static Discovery discover(String input, String expectedPublicKey) throws IOException {
        return discover(input, expectedPublicKey, true);
    }

    private static Discovery discover(String input, String expectedPublicKey, boolean verifyMods) throws IOException {
        Address address = parseAddress(input);
        assertServerAllowed(address.host);
        if (!address.connectHost.equalsIgnoreCase(address.host)) assertServerAllowed(address.connectHost);
        JsonObject status = null;
        IOException pingError = null;
        try {
            status = ping(address.connectHost, address.host, address.port);
        } catch (IOException error) {
            pingError = error;
        }
        int discoveredPort = status == null ? -1 : extractManifestPort(status);
        List<Integer> candidatePorts = new ArrayList<Integer>();
        if (validPort(discoveredPort)) candidatePorts.add(discoveredPort);
        if (!candidatePorts.contains(DEFAULT_MANIFEST_PORT)) candidatePorts.add(DEFAULT_MANIFEST_PORT);

        URL manifestUrl = null;
        HttpPayload payload = null;
        IOException manifestError = null;
        int manifestPort = DEFAULT_MANIFEST_PORT;
        for (Integer candidatePort : candidatePorts) {
            URL candidateUrl = new URL("http", address.connectHost, candidatePort, "/impulse/server.json");
            try {
                payload = readPayload(candidateUrl, MAX_MANIFEST_BYTES, 4000, 10000);
                manifestUrl = candidateUrl;
                manifestPort = candidatePort;
                break;
            } catch (IOException error) {
                manifestError = error;
            }
        }
        if (payload == null || manifestUrl == null) {
            StringBuilder message = new StringBuilder("Could not reach the Impulse server information on port ")
                .append(DEFAULT_MANIFEST_PORT).append('.');
            if (pingError != null) message.append(" Minecraft status also failed: ").append(clean(pingError.getMessage(), "unreachable server")).append('.');
            else if (manifestError != null) message.append(' ').append(clean(manifestError.getMessage(), "The manifest endpoint is unavailable."));
            throw new IOException(message.toString(), manifestError == null ? pingError : manifestError);
        }
        String manifestPublicKey = verifyManifestPayload(payload, expectedPublicKey);
        String raw = new String(payload.body, StandardCharsets.UTF_8);
        Manifest manifest;
        try {
            manifest = GSON.fromJson(raw, Manifest.class);
        } catch (Exception error) {
            throw new IOException("The server returned an invalid Impulse manifest: " + error.getMessage(), error);
        }
        normalizeManifest(manifest);
        if (verifyMods) verifyManifestModOrigins(manifest);
        if (manifest.minecraft == null || clean(manifest.minecraft.version, "").length() == 0) {
            throw new IOException("The Impulse manifest does not contain a Minecraft version.");
        }
        int minecraftPort = manifest.server != null && validPort(manifest.server.port) ? manifest.server.port : address.port;
        return new Discovery(address.host, minecraftPort, manifestPort, manifestUrl.toString(), raw, manifest, manifestPublicKey);
    }

    private static String normalizeSecurityHost(String value) {
        String host = clean(value, "").toLowerCase(Locale.ROOT);
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        while (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        return host;
    }

    private static synchronized JsonObject blockedServerRegistry() {
        if (blockedServersCache != null && blockedServersCacheExpiresAt > System.currentTimeMillis()) return blockedServersCache;
        try {
            HttpPayload payload = readPayload(new URL(BLOCKED_SERVERS_URL), 1024 * 1024, 5000, 10000);
            JsonObject parsed = new JsonParser().parse(new String(payload.body, StandardCharsets.UTF_8)).getAsJsonObject();
            if (!parsed.has("servers") || !parsed.get("servers").isJsonArray()) throw new IOException("Invalid blocked server registry.");
            blockedServersCache = parsed;
            blockedServersCacheExpiresAt = System.currentTimeMillis() + 5 * 60 * 1000L;
            return parsed;
        } catch (Exception error) {
            System.err.println("[Impulse security] Server blacklist unavailable: " + error.getMessage());
            return blockedServersCache == null ? new JsonObject() : blockedServersCache;
        }
    }

    private static void assertServerAllowed(String host) throws IOException {
        String normalizedHost = normalizeSecurityHost(host);
        JsonObject registry = blockedServerRegistry();
        if (!registry.has("servers") || !registry.get("servers").isJsonArray()) return;
        Set<String> resolved = new HashSet<String>();
        resolved.add(normalizedHost);
        try {
            for (InetAddress address : InetAddress.getAllByName(normalizedHost)) {
                String candidate = normalizeSecurityHost(address.getHostAddress());
                if (candidate.indexOf(':') < 0) resolved.add(candidate);
            }
        } catch (Exception error) {
            System.err.println("[Impulse security] Could not resolve " + normalizedHost + " for blacklist check: " + error.getMessage());
        }
        for (JsonElement element : registry.getAsJsonArray("servers")) {
            if (!element.isJsonObject()) continue;
            JsonObject entry = element.getAsJsonObject();
            String blockedHost = entry.has("host") ? normalizeSecurityHost(entry.get("host").getAsString()) : "";
            boolean blocked = normalizedHost.equals(blockedHost);
            if (!blocked && entry.has("ipv4") && entry.get("ipv4").isJsonArray()) {
                for (JsonElement address : entry.getAsJsonArray("ipv4")) {
                    if (address.isJsonPrimitive() && resolved.contains(normalizeSecurityHost(address.getAsString()))) {
                        blocked = true;
                        break;
                    }
                }
            }
            if (blocked) {
                String code = entry.has("reason_code") ? clean(entry.get("reason_code").getAsString(), "") : "";
                String[] reason = serverRestrictionReason(code);
                throw new RestrictedServerException(normalizedHost, code, reason[0], reason[1]);
            }
        }
    }

    private static String[] serverRestrictionReason(String value) {
        String code = clean(value, "").toLowerCase(Locale.ROOT);
        if ("malware".equals(code)) return new String[] { "Malicious software detected", "This server has distributed files identified as malicious or harmful." };
        if ("credential_theft".equals(code)) return new String[] { "Credential theft risk", "This server has attempted to collect passwords, session tokens, account credentials, or other sensitive information." };
        if ("phishing_impersonation".equals(code)) return new String[] { "Phishing or impersonation", "This server has impersonated another service, project, or community in a way that could mislead players." };
        if ("compromised_server".equals(code)) return new String[] { "Server infrastructure compromised", "This server appears to be compromised and may distribute unauthorized files or content." };
        if ("unsafe_mod_distribution".equals(code)) return new String[] { "Unsafe mod distribution", "This server has distributed deceptive, tampered, or unauthorized mod files." };
        if ("fraud".equals(code)) return new String[] { "Fraudulent activity", "This server has been associated with scams, fraudulent transactions, or intentionally misleading offers." };
        if ("illegal_distribution".equals(code)) return new String[] { "Unauthorized content distribution", "This server has repeatedly distributed software or content without the required authorization." };
        if ("abusive_content".equals(code)) return new String[] { "Severe abusive activity", "This server has been restricted because of severe abuse that presents a risk to Impulse users." };
        if ("repeated_security_incidents".equals(code)) return new String[] { "Repeated security incidents", "This server has continued unsafe behavior after previous security incidents." };
        if ("policy_violation".equals(code)) return new String[] { "Impulse security policy violation", "This server has violated Impulse security requirements in a way that may put players at risk." };
        return new String[] { "Security restriction", "Impulse has restricted access to this server because it may present a risk to players." };
    }

    public static synchronized Store loadStore(File gameDirectory) {
        File file = storeFile(gameDirectory);
        if (!file.isFile()) return new Store();
        FileInputStream input = null;
        try {
            input = new FileInputStream(file);
            Store store = GSON.fromJson(readAll(input, 2 * 1024 * 1024), Store.class);
            if (store == null) store = new Store();
            if (store.profiles == null) store.profiles = new ArrayList<Profile>();
            return store;
        } catch (Exception error) {
            System.err.println("[Impulse] Ignoring invalid standalone profile store: " + error.getMessage());
            return new Store();
        } finally {
            closeQuietly(input);
        }
    }

    public static synchronized Profile saveProfile(File gameDirectory, Discovery discovery, List<String> selectedOptionalIds) throws IOException {
        Store store = loadStore(gameDirectory);
        String profileId = profileId(discovery.host, discovery.minecraftPort, discovery.manifestPort);
        Profile profile = findProfile(store, profileId);
        if (profile == null) {
            profile = new Profile();
            profile.id = profileId;
            profile.created_at = System.currentTimeMillis();
            store.profiles.add(profile);
        }
        profile.address = formatAddress(discovery.host, discovery.minecraftPort);
        profile.host = discovery.host;
        profile.minecraft_port = discovery.minecraftPort;
        profile.manifest_port = discovery.manifestPort;
        profile.name = clean(discovery.manifest.name, profile.address);
        profile.selected_optional_ids = normalizeIds(selectedOptionalIds);
        profile.manifest_signature = manifestSignature(discovery.manifest);
        if (discovery.manifestPublicKey != null) profile.manifest_public_key = discovery.manifestPublicKey;
        profile.updated_at = System.currentTimeMillis();
        store.active_profile_id = profile.id;
        File profileRoot = new File(standaloneRoot(gameDirectory), profile.id);
        if (!profileRoot.exists()) profileRoot.mkdirs();
        writeTextAtomic(new File(profileRoot, "manifest.json"), discovery.rawManifest);
        saveStore(gameDirectory, store);
        System.setProperty("impulse.standalone.restart_required", "true");
        return profile;
    }

    public static Profile prepareProfileForLaunch(File gameDirectory, Discovery discovery, List<String> selectedOptionalIds) throws Exception {
        checkCancelled();
        Profile profile = saveProfile(gameDirectory, discovery, selectedOptionalIds);
        File profileRoot = new File(standaloneRoot(gameDirectory), profile.id);
        File managedMods = new File(profileRoot, "mods");
        if (!managedMods.exists() && !managedMods.mkdirs()) throw new IOException("Could not create standalone mods directory: " + managedMods);
        List<ManifestMod> effective = resolveEffectiveMods(discovery.manifest, profile.selected_optional_ids);
        requireSha512(effective);
        syncMods(gameDirectory, managedMods, discovery, effective);
        checkCancelled();
        // Re-run catalog matching after the exact downloaded files have passed SHA-512 validation.
        verifyManifestModOrigins(discovery.manifest);
        checkCancelled();
        finalizeManifestModOrigins(gameDirectory, discovery.manifest, effective, managedMods);
        writeTextAtomic(new File(profileRoot, "manifest.json"), GSON.toJson(discovery.manifest));
        return profile;
    }

    public static synchronized void setActiveProfile(File gameDirectory, String profileId) throws IOException {
        Store store = loadStore(gameDirectory);
        if (findProfile(store, profileId) == null) throw new IOException("Standalone profile not found: " + profileId);
        store.active_profile_id = profileId;
        saveStore(gameDirectory, store);
        System.setProperty("impulse.standalone.restart_required", "true");
    }

    public static synchronized void deleteProfile(File gameDirectory, String profileId) throws IOException {
        Store store = loadStore(gameDirectory);
        for (int i = store.profiles.size() - 1; i >= 0; i--) {
            if (profileId.equals(store.profiles.get(i).id)) store.profiles.remove(i);
        }
        if (profileId.equals(store.active_profile_id)) {
            store.active_profile_id = store.profiles.isEmpty() ? null : store.profiles.get(0).id;
        }
        saveStore(gameDirectory, store);
        deleteTree(new File(standaloneRoot(gameDirectory), profileId));
        System.setProperty("impulse.standalone.restart_required", "true");
    }

    public static synchronized void updateOptionalSelection(File gameDirectory, String profileId, List<String> selectedIds) throws IOException {
        Store store = loadStore(gameDirectory);
        Profile profile = findProfile(store, profileId);
        if (profile == null) throw new IOException("Standalone profile not found: " + profileId);
        profile.selected_optional_ids = normalizeIds(selectedIds);
        profile.updated_at = System.currentTimeMillis();
        saveStore(gameDirectory, store);
        System.setProperty("impulse.standalone.restart_required", "true");
    }

    public static Manifest loadCachedManifest(File gameDirectory, Profile profile) {
        if (profile == null) return null;
        File file = new File(new File(standaloneRoot(gameDirectory), profile.id), "manifest.json");
        if (!file.isFile()) return null;
        try {
            FileInputStream input = new FileInputStream(file);
            try {
                Manifest manifest = GSON.fromJson(readAll(input, MAX_MANIFEST_BYTES), Manifest.class);
                normalizeManifest(manifest);
                return manifest;
            } finally {
                input.close();
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    public static File profileDirectory(File gameDirectory, String profileId) {
        return new File(standaloneRoot(gameDirectory), clean(profileId, "unknown"));
    }

    public static File customModsDirectory(File gameDirectory, String profileId) {
        return new File(profileDirectory(gameDirectory, profileId), "custom_mods");
    }

    public static File customModsStateFile(File gameDirectory, String profileId) {
        return new File(profileDirectory(gameDirectory, profileId), "custom-mods.json");
    }

    public static File globalModsDirectory(File gameDirectory) {
        return new File(gameDirectory, "mods");
    }

    private static File skippedGlobalStateFile(File gameDirectory) {
        return new File(new File(standaloneRoot(gameDirectory), "runtime"), "skipped-global.json");
    }

    public static synchronized void stageSkippedGlobalMods(File gameDirectory, List<String> fileNames) throws IOException {
        restoreSkippedGlobalMods(gameDirectory);
        if (fileNames == null || fileNames.isEmpty()) return;
        File modsDirectory = globalModsDirectory(gameDirectory);
        File skippedDirectory = new File(new File(standaloneRoot(gameDirectory), "runtime"), "skipped-global");
        if (!skippedDirectory.exists() && !skippedDirectory.mkdirs()) {
            throw new IOException("Could not create the temporary skipped-mod directory.");
        }
        SkippedGlobalState state = new SkippedGlobalState();
        for (String value : fileNames) {
            String name = safeFileName(value);
            File source = new File(modsDirectory, name);
            if (!source.isFile() || !source.getCanonicalFile().getParentFile().equals(modsDirectory.getCanonicalFile())) continue;
            File target = new File(skippedDirectory, name);
            if (target.exists()) throw new IOException("A temporary copy already exists for " + name + ".");
            SkippedGlobalFile item = new SkippedGlobalFile();
            item.file_name = name;
            state.files.add(item);
        }
        if (state.files.isEmpty()) return;
        writeTextAtomic(skippedGlobalStateFile(gameDirectory), GSON.toJson(state));
        try {
            for (SkippedGlobalFile item : state.files) {
                moveAtomic(new File(modsDirectory, item.file_name), new File(skippedDirectory, item.file_name));
            }
        } catch (IOException error) {
            restoreSkippedGlobalMods(gameDirectory);
            throw error;
        }
    }

    public static synchronized void restoreSkippedGlobalMods(File gameDirectory) {
        File stateFile = skippedGlobalStateFile(gameDirectory);
        if (!stateFile.isFile()) return;
        try {
            FileInputStream input = new FileInputStream(stateFile);
            SkippedGlobalState state;
            try { state = GSON.fromJson(readAll(input, 1024 * 1024), SkippedGlobalState.class); }
            finally { input.close(); }
            File modsDirectory = globalModsDirectory(gameDirectory);
            File skippedDirectory = new File(stateFile.getParentFile(), "skipped-global");
            if (!modsDirectory.exists()) modsDirectory.mkdirs();
            if (state != null && state.files != null) for (SkippedGlobalFile item : state.files) {
                if (item == null) continue;
                String name = safeFileName(item.file_name);
                File source = new File(skippedDirectory, name);
                File target = new File(modsDirectory, name);
                if (!source.isFile()) continue;
                if (target.exists()) {
                    System.err.println("[Impulse] Could not restore skipped mod " + name + " because a file now exists at its original path.");
                    continue;
                }
                moveAtomic(source, target);
            }
            File[] remaining = skippedDirectory.listFiles();
            if (remaining == null || remaining.length == 0) {
                Files.deleteIfExists(skippedDirectory.toPath());
                Files.deleteIfExists(stateFile.toPath());
            }
        } catch (Exception error) {
            System.err.println("[Impulse] Could not restore temporarily skipped mods: " + error.getMessage());
        }
    }

    private static synchronized void registerSkippedGlobalRestore(final File gameDirectory) {
        if (skippedGlobalRestoreHookRegistered || !skippedGlobalStateFile(gameDirectory).isFile()) return;
        skippedGlobalRestoreHookRegistered = true;
        Runtime.getRuntime().addShutdownHook(new Thread(new Runnable() {
            public void run() { restoreSkippedGlobalMods(gameDirectory); }
        }, "impulse-restore-global-mods"));
    }

    public static boolean isImpulseJar(File file) {
        if (file == null || !file.isFile()) return false;
        JarFile jar = null;
        try {
            jar = new JarFile(file);
            return jar.getJarEntry("impulse-runtime.embedded") != null
                && jar.getJarEntry("com/impulse/bootstrap/ImpulseStandaloneBootstrap.class") != null;
        } catch (IOException ignored) {
            return false;
        } finally {
            if (jar != null) try { jar.close(); } catch (IOException ignored) { }
        }
    }

    public static synchronized CustomModState loadCustomModState(File gameDirectory, String profileId) {
        File file = customModsStateFile(gameDirectory, profileId);
        if (!file.isFile()) return new CustomModState();
        FileInputStream input = null;
        try {
            input = new FileInputStream(file);
            CustomModState state = GSON.fromJson(readAll(input, 4 * 1024 * 1024), CustomModState.class);
            if (state == null) state = new CustomModState();
            if (state.mods == null) state.mods = new ArrayList<CustomModEntry>();
            return state;
        } catch (Exception error) {
            System.err.println("[Impulse] Ignoring invalid custom mod state: " + error.getMessage());
            return new CustomModState();
        } finally {
            closeQuietly(input);
        }
    }

    public static synchronized void saveCustomModState(File gameDirectory, String profileId, CustomModState state) throws IOException {
        if (state == null) state = new CustomModState();
        if (state.mods == null) state.mods = new ArrayList<CustomModEntry>();
        writeTextAtomic(customModsStateFile(gameDirectory, profileId), GSON.toJson(state));
    }

    private static List<File> validatedCustomModFiles(File gameDirectory, Profile profile, File managedModsDirectory) throws IOException {
        File customDirectory = customModsDirectory(gameDirectory, profile.id);
        if (!customDirectory.exists() && !customDirectory.mkdirs()) {
            throw new IOException("Could not create custom mods directory: " + customDirectory);
        }

        CustomModState state = loadCustomModState(gameDirectory, profile.id);
        Map<String, File> providedIds = new HashMap<String, File>();
        collectModIds(new File(gameDirectory, "mods"), providedIds);
        collectModIds(managedModsDirectory, providedIds);

        Map<String, CustomModEntry> managedByFile = new HashMap<String, CustomModEntry>();
        for (CustomModEntry entry : state.mods) {
            if (entry != null && !"global".equalsIgnoreCase(clean(entry.location, "profile"))
                && clean(entry.file_name, "").length() > 0) {
                managedByFile.put(safeFileName(entry.file_name).toLowerCase(Locale.US), entry);
            }
        }

        List<File> loadable = new ArrayList<File>();
        Map<String, File> acceptedIds = new HashMap<String, File>();
        File[] files = customDirectory.listFiles();
        if (files == null) return loadable;
        Arrays.sort(files, new Comparator<File>() {
            public int compare(File left, File right) { return left.getName().compareToIgnoreCase(right.getName()); }
        });
        for (File file : files) {
            if (!file.isFile() || !file.getName().toLowerCase(Locale.US).endsWith(".jar")) continue;
            CustomModEntry managed = managedByFile.get(file.getName().toLowerCase(Locale.US));
            if (managed != null && clean(managed.sha1, "").length() > 0 && !managed.sha1.equalsIgnoreCase(sha1(file))) {
                managed.status = "corrupt";
                managed.status_message = "SHA-1 verification failed.";
                continue;
            }

            Set<String> ids = readModIds(file);
            File conflict = null;
            for (String id : ids) {
                conflict = providedIds.get(normalizeId(id));
                if (conflict == null) conflict = acceptedIds.get(normalizeId(id));
                if (conflict != null) break;
            }
            if (conflict != null) {
                if (managed != null) {
                    managed.status = "provided";
                    managed.status_message = "Already provided by " + conflict.getName() + ".";
                }
                System.out.println("[Impulse] Skipping custom mod " + file.getName() + " because " + conflict.getName() + " provides the same mod ID.");
                continue;
            }

            if (managed != null) {
                managed.status = "ready";
                managed.status_message = null;
                managed.mod_ids = new ArrayList<String>(ids);
            }
            for (String id : ids) acceptedIds.put(normalizeId(id), file);
            loadable.add(file);
        }
        state.updated_at = System.currentTimeMillis();
        saveCustomModState(gameDirectory, profile.id, state);
        return loadable;
    }

    private static void collectModIds(File directory, Map<String, File> output) {
        File[] files = directory == null ? null : directory.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (!file.isFile() || !file.getName().toLowerCase(Locale.US).endsWith(".jar") || isImpulseFile(file.getName())) continue;
            for (String id : readModIds(file)) output.put(normalizeId(id), file);
        }
    }

    public static List<String> defaultOptionalIds(Manifest manifest) {
        Set<String> enabledCategories = new HashSet<String>();
        for (OptionalCategory category : safeCategories(manifest)) {
            if (category.default_enabled) enabledCategories.add(normalizeId(category.id));
        }
        List<String> result = new ArrayList<String>();
        for (ManifestMod mod : safeOptionalMods(manifest)) {
            if (enabledCategories.contains(normalizeId(mod.category_id))) result.add(normalizeId(mod.id));
        }
        return normalizeIds(result);
    }

    public static List<String> effectiveOptionalIds(Manifest manifest, List<String> explicitlySelected) throws IOException {
        List<ManifestMod> effective = resolveEffectiveMods(manifest, explicitlySelected);
        Set<String> required = new HashSet<String>();
        for (ManifestMod mod : safeMods(manifest)) required.add(normalizeId(mod.id));
        List<String> result = new ArrayList<String>();
        for (ManifestMod mod : effective) {
            String id = normalizeId(mod.id);
            if (!required.contains(id) && !"impulse".equals(id)) result.add(id);
        }
        return result;
    }

    public static void validateRuntime(Manifest manifest, String minecraftVersion, String loader, String loaderVersion) throws IOException {
        String expectedLoader = clean(loader, "").toLowerCase(Locale.US);
        String actualLoader = clean(manifest.minecraft.loader, "forge").toLowerCase(Locale.US);
        if (!clean(manifest.minecraft.version, "").equals(clean(minecraftVersion, ""))) {
            throw new IOException("Impulse server requires Minecraft " + manifest.minecraft.version + ", but this instance is " + minecraftVersion + ".");
        }
        if (!actualLoader.equals(expectedLoader)) {
            throw new IOException("Impulse server requires " + actualLoader + ", but this instance uses " + expectedLoader + ".");
        }
        String requiredVersion = clean(manifest.minecraft.loader_version, "");
        if (requiredVersion.length() > 0 && !requiredVersion.equals(clean(loaderVersion, ""))) {
            throw new IOException("Impulse server requires " + actualLoader + " " + requiredVersion + ", but this instance uses " + loaderVersion + ".");
        }
    }

    private static List<ManifestMod> resolveEffectiveMods(Manifest manifest, List<String> selectedIds) throws IOException {
        LinkedHashMap<String, ManifestMod> all = new LinkedHashMap<String, ManifestMod>();
        LinkedHashSet<String> required = new LinkedHashSet<String>();
        for (ManifestMod mod : safeMods(manifest)) {
            normalizeMod(mod, true);
            String id = normalizeId(mod.id);
            if (id.length() == 0) throw new IOException("A required mod has no stable ID: " + mod.file_name);
            all.put(id, mod);
            required.add(id);
        }
        for (ManifestMod mod : safeOptionalMods(manifest)) {
            normalizeMod(mod, false);
            String id = normalizeId(mod.id);
            if (id.length() == 0) throw new IOException("An optional mod has no stable ID: " + mod.file_name);
            if (all.containsKey(id)) throw new IOException("Duplicate mod ID in manifest: " + id);
            all.put(id, mod);
        }

        LinkedHashSet<String> enabled = new LinkedHashSet<String>(required);
        for (String selected : normalizeIds(selectedIds)) {
            if (!all.containsKey(selected)) continue;
            enableWithDependencies(selected, all, enabled, new HashSet<String>());
        }
        for (String id : new ArrayList<String>(enabled)) enableWithDependencies(id, all, enabled, new HashSet<String>());

        for (String id : enabled) {
            ManifestMod mod = all.get(id);
            for (String conflict : mod.conflicts) {
                String conflictId = normalizeId(conflict);
                if (enabled.contains(conflictId)) {
                    throw new IOException("Mod conflict: " + displayName(mod) + " conflicts with " + displayName(all.get(conflictId)) + ".");
                }
            }
        }

        List<ManifestMod> result = new ArrayList<ManifestMod>();
        for (Map.Entry<String, ManifestMod> entry : all.entrySet()) {
            if (enabled.contains(entry.getKey()) && !"impulse".equals(entry.getKey()) && !isImpulseFile(entry.getValue().file_name)) {
                result.add(entry.getValue());
            }
        }
        return result;
    }

    public static List<ManifestMod> launchMods(Manifest manifest, List<String> selectedIds) throws IOException {
        return resolveEffectiveMods(manifest, selectedIds);
    }

    public static List<ManifestMod> problematicMods(Manifest manifest, List<String> selectedIds) throws IOException {
        List<ManifestMod> out = new ArrayList<ManifestMod>();
        for (ManifestMod mod : resolveEffectiveMods(manifest, selectedIds)) {
            String status = mod.verification == null ? "Verification unavailable" : clean(mod.verification.status, "Verification unavailable");
            if (!"Matched on Modrinth".equals(status) && !"Matched on CurseForge".equals(status)
                && !"Recognized by Impulse".equals(status) && !"User provided".equals(status)
                && !"Pending CurseForge verification".equals(status)) out.add(mod);
        }
        return out;
    }

    public static String problematicSignature(List<ManifestMod> mods) {
        List<String> lines = new ArrayList<String>();
        for (ManifestMod mod : mods) lines.add(clean(mod.sha512, "") + ":" + (mod.verification == null ? "Verification unavailable" : clean(mod.verification.status, "Verification unavailable")));
        Collections.sort(lines);
        return String.join("|", lines);
    }

    public static synchronized void acceptUnverifiedMods(File gameDirectory, String profileId, String signature) throws IOException {
        Store store = loadStore(gameDirectory);
        Profile profile = findProfile(store, profileId);
        if (profile == null) throw new IOException("Standalone profile not found: " + profileId);
        profile.accepted_unverified_mod_signature = clean(signature, "");
        saveStore(gameDirectory, store);
    }

    private static void enableWithDependencies(String id, Map<String, ManifestMod> all, Set<String> enabled, Set<String> visiting) throws IOException {
        if (!visiting.add(id)) throw new IOException("Dependency cycle detected at " + id + ".");
        ManifestMod mod = all.get(id);
        if (mod == null) throw new IOException("Manifest dependency not found: " + id);
        enabled.add(id);
        for (String dependency : mod.dependencies) {
            String dependencyId = normalizeId(dependency);
            if (!all.containsKey(dependencyId)) {
                throw new IOException(displayName(mod) + " requires missing mod " + dependency + ".");
            }
            if (!enabled.contains(dependencyId)) enableWithDependencies(dependencyId, all, enabled, visiting);
        }
        visiting.remove(id);
    }

    private static void syncMods(File gameDirectory, File managedDirectory, Discovery discovery, List<ManifestMod> mods) throws Exception {
        checkCancelled();
        Map<String, File> globalHashes = new HashMap<String, File>();
        Map<String, File> globalIds = new HashMap<String, File>();
        scanGlobalMods(new File(gameDirectory, "mods"), globalHashes, globalIds);

        LinkedHashMap<String, ManifestMod> desired = new LinkedHashMap<String, ManifestMod>();
        Set<String> satisfiedByGlobal = new HashSet<String>();
        for (ManifestMod mod : mods) {
            String fileName = safeFileName(mod.file_name);
            if (desired.containsKey(fileName.toLowerCase(Locale.US))) {
                throw new IOException("Duplicate client mod filename in manifest: " + fileName);
            }
            if (globalHashes.containsKey(mod.sha512)) {
                satisfiedByGlobal.add(fileName.toLowerCase(Locale.US));
                continue;
            }
            File playerMod = globalIds.get(normalizeId(mod.id));
            if (playerMod != null) {
                satisfiedByGlobal.add(fileName.toLowerCase(Locale.US));
                System.out.println("[Impulse] Keeping player-installed mod " + playerMod.getName() + " for " + displayName(mod) + ".");
                continue;
            }
            desired.put(fileName.toLowerCase(Locale.US), mod);
        }

        final int downloadCount = countDownloads(managedDirectory, desired);
        final AtomicInteger completedDownloads = new AtomicInteger(0);
        progressReporter.begin("Impulse: preparing downloads", Math.max(1, downloadCount));
        ExecutorService downloads = Executors.newFixedThreadPool(4);
        List<Future<File>> futures = new ArrayList<Future<File>>();
        try {
            for (final ManifestMod mod : desired.values()) {
                checkCancelled();
                final File target = new File(managedDirectory, safeFileName(mod.file_name));
                if (target.isFile() && mod.sha512.equals(sha512(target))) continue;
                futures.add(downloads.submit(new Callable<File>() {
                    public File call() throws Exception {
                        progressReporter.progress("Downloading " + displayName(mod), completedDownloads.get(), Math.max(1, downloadCount));
                        downloadWithRetries(downloadUrl(discovery, mod), target, mod);
                        int completed = completedDownloads.incrementAndGet();
                        progressReporter.progress("Downloaded " + displayName(mod) + " (" + completed + "/" + downloadCount + ")", completed, Math.max(1, downloadCount));
                        return target;
                    }
                }));
            }
            for (Future<File> future : futures) {
                checkCancelled();
                try {
                    future.get();
                } catch (ExecutionException error) {
                    Throwable cause = error.getCause();
                    if (cause instanceof Exception) throw (Exception) cause;
                    throw new IOException("Standalone mod download failed", cause);
                }
            }
        } finally {
            downloads.shutdownNow();
            progressReporter.end();
        }

        progressReporter.begin("Impulse: verifying files", Math.max(1, desired.size()));
        int verified = 0;
        try {
            for (ManifestMod mod : desired.values()) {
                checkCancelled();
                File target = new File(managedDirectory, safeFileName(mod.file_name));
                progressReporter.progress("Verifying " + displayName(mod), verified, Math.max(1, desired.size()));
                String hash = sha512(target);
                if (!mod.sha512.equals(hash)) throw new IOException("SHA-512 mismatch for " + mod.file_name + ".");
                verified++;
                progressReporter.progress("Verified " + displayName(mod), verified, Math.max(1, desired.size()));
            }
        } finally {
            progressReporter.end();
        }

        File[] existing = managedDirectory.listFiles();
        if (existing != null) {
            for (File file : existing) {
                if (!file.isFile() || !file.getName().toLowerCase(Locale.US).endsWith(".jar")) continue;
                String lower = file.getName().toLowerCase(Locale.US);
                if (!desired.containsKey(lower) || satisfiedByGlobal.contains(lower)) Files.deleteIfExists(file.toPath());
            }
        }
    }

    private static int countDownloads(File managedDirectory, Map<String, ManifestMod> desired) throws IOException {
        int count = 0;
        for (ManifestMod mod : desired.values()) {
            File target = new File(managedDirectory, safeFileName(mod.file_name));
            if (!target.isFile() || !mod.sha512.equals(sha512(target))) count++;
        }
        return count;
    }

    private static void downloadWithRetries(URL url, File target, ManifestMod mod) throws Exception {
        Exception last = null;
        long[] delays = new long[] { 500L, 1500L, 3000L };
        for (int attempt = 1; attempt <= 3; attempt++) {
            checkCancelled();
            try {
                download(url, target, mod.size);
                String actual = sha512(target);
                if (!mod.sha512.equals(actual)) throw new IOException("SHA-512 mismatch for " + mod.file_name + ": expected " + mod.sha512 + ", got " + actual);
                return;
            } catch (Exception error) {
                if (error instanceof InterruptedException || error instanceof InterruptedIOException || Thread.currentThread().isInterrupted()) throw error;
                last = error;
                if (attempt < 3) Thread.sleep(delays[attempt - 1]);
            }
        }
        throw new IOException("Failed to download " + displayName(mod) + " after 3 attempts from " + url + ": " + (last == null ? "unknown error" : last.getMessage()), last);
    }

    private static void download(URL url, File target, long expectedSize) throws IOException {
        File parent = target.getParentFile();
        if (!parent.exists()) parent.mkdirs();
        File part = new File(parent, target.getName() + ".part");
        long existing = part.isFile() ? part.length() : 0L;
        if (expectedSize > 0 && existing > expectedSize) {
            Files.deleteIfExists(part.toPath());
            existing = 0L;
        }
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(1000);
        connection.setRequestProperty("User-Agent", "Impulse-Standalone/0.1");
        if (existing > 0) connection.setRequestProperty("Range", "bytes=" + existing + "-");
        int status = connection.getResponseCode();
        boolean append = existing > 0 && status == 206;
        if (status != 200 && status != 206) {
            connection.disconnect();
            throw new IOException("HTTP " + status + " for " + url);
        }
        if (!append) existing = 0L;
        InputStream input = connection.getInputStream();
        FileOutputStream output = new FileOutputStream(part, append);
        try {
            byte[] buffer = new byte[64 * 1024];
            long lastProgress = System.currentTimeMillis();
            while (true) {
                checkCancelled();
                try {
                    int read = input.read(buffer);
                    if (read < 0) break;
                    output.write(buffer, 0, read);
                    lastProgress = System.currentTimeMillis();
                } catch (SocketTimeoutException timeout) {
                    checkCancelled();
                    if (System.currentTimeMillis() - lastProgress >= 30000L) {
                        throw new IOException("Download timed out for " + target.getName() + ".", timeout);
                    }
                }
            }
        } finally {
            output.close();
            input.close();
            connection.disconnect();
        }
        if (expectedSize > 0 && part.length() != expectedSize) {
            throw new IOException("Incomplete download for " + target.getName() + ": expected " + expectedSize + " bytes, got " + part.length());
        }
        moveAtomic(part, target);
    }

    private static void checkCancelled() throws InterruptedIOException {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Launch cancelled.");
    }

    private static URL downloadUrl(Discovery discovery, ManifestMod mod) throws IOException {
        String raw = clean(mod.download_url, "");
        if (raw.length() == 0) throw new IOException("Missing download URL for " + mod.file_name);
        try {
            URI source = URI.create(raw);
            String path = source.isAbsolute() ? source.getRawPath() : raw;
            String query = source.isAbsolute() ? source.getRawQuery() : null;
            if (!path.startsWith("/")) path = "/" + path;
            if (!path.startsWith("/impulse/")) throw new IOException("Refusing download path outside /impulse: " + path);
            if (query != null && query.length() > 0) path += "?" + query;
            return new URL("http", discovery.host, discovery.manifestPort, path);
        } catch (IllegalArgumentException error) {
            throw new IOException("Invalid download URL for " + mod.file_name + ": " + raw, error);
        }
    }

    private static void scanGlobalMods(File directory, Map<String, File> hashes, Map<String, File> ids) {
        File[] files = directory.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (!file.isFile() || !file.getName().toLowerCase(Locale.US).endsWith(".jar") || isImpulseFile(file.getName())) continue;
            try {
                hashes.put(sha512(file), file);
                for (String id : readModIds(file)) ids.put(normalizeId(id), file);
            } catch (Exception error) {
                System.err.println("[Impulse] Could not inspect global mod " + file.getName() + ": " + error.getMessage());
            }
        }
    }

    public static Set<String> readModIds(File file) {
        LinkedHashSet<String> ids = new LinkedHashSet<String>();
        JarFile jar = null;
        try {
            jar = new JarFile(file);
            String metadata = readJarText(jar, "META-INF/neoforge.mods.toml");
            if (metadata == null) metadata = readJarText(jar, "META-INF/mods.toml");
            if (metadata != null) {
                boolean modSection = false;
                for (String line : metadata.split("\\r?\\n")) {
                    String trimmed = line.trim();
                    if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
                        modSection = "[[mods]]".equalsIgnoreCase(trimmed);
                        continue;
                    }
                    if (!modSection) continue;
                    Matcher matcher = TOML_MOD_ID.matcher(line);
                    if (matcher.find()) ids.add(normalizeId(matcher.group(1)));
                }
            }
            String legacy = readJarText(jar, "mcmod.info");
            if (legacy != null) {
                JsonElement parsed = new JsonParser().parse(legacy);
                JsonArray entries = parsed.isJsonArray() ? parsed.getAsJsonArray() : null;
                if (entries != null) {
                    for (JsonElement entry : entries) {
                        if (entry.isJsonObject() && entry.getAsJsonObject().has("modid")) ids.add(normalizeId(entry.getAsJsonObject().get("modid").getAsString()));
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (jar != null) try { jar.close(); } catch (Exception ignored) { }
        }
        return ids;
    }

    private static String readJarText(JarFile jar, String path) throws IOException {
        JarEntry entry = jar.getJarEntry(path);
        if (entry == null) return null;
        InputStream input = jar.getInputStream(entry);
        try { return readAll(input, 2 * 1024 * 1024); } finally { input.close(); }
    }

    private static void publishRuntime(File gameDirectory, Profile profile, Manifest manifest) {
        System.setProperty("impulse.standalone", "true");
        System.setProperty("impulse.standalone.profile_id", profile.id);
        System.setProperty("impulse.updater.channel", standaloneUpdateChannel(gameDirectory));
        System.setProperty("impulse.server.address", profile.host);
        System.setProperty("impulse.server.port", String.valueOf(profile.minecraft_port));
        System.setProperty("impulse.server.name", clean(manifest.name, profile.name));
        System.setProperty("impulse.auto_connect", String.valueOf(manifest.server != null && manifest.server.auto_connect));
        System.clearProperty("impulse.standalone.setup_required");
    }

    private static String standaloneUpdateChannel(File gameDirectory) {
        File settings = new File(new File(new File(gameDirectory, "impulse"), "standalone"), "settings.json");
        if (!settings.isFile()) return "stable";
        InputStream input = null;
        try {
            input = new FileInputStream(settings);
            JsonElement parsed = new JsonParser().parse(readAll(input, 64 * 1024));
            if (!parsed.isJsonObject() || !parsed.getAsJsonObject().has("update_channel")) return "stable";
            String channel = parsed.getAsJsonObject().get("update_channel").getAsString();
            return "beta".equalsIgnoreCase(channel) ? "beta" : "stable";
        } catch (Exception ignored) {
            return "stable";
        } finally {
            if (input != null) try { input.close(); } catch (Exception ignored) { }
        }
    }

    private static JsonObject ping(String connectHost, String handshakeHost, int port) throws IOException {
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(connectHost, port), 5000);
            socket.setSoTimeout(5000);
            OutputStream output = socket.getOutputStream();
            ByteArrayOutputStream handshakeBody = new ByteArrayOutputStream();
            writeVarInt(handshakeBody, 0);
            writeVarInt(handshakeBody, 47);
            writeString(handshakeBody, handshakeHost);
            handshakeBody.write((port >>> 8) & 0xFF);
            handshakeBody.write(port & 0xFF);
            writeVarInt(handshakeBody, 1);
            writePacket(output, handshakeBody.toByteArray());
            writePacket(output, new byte[] { 0 });

            DataInputStream input = new DataInputStream(socket.getInputStream());
            readVarInt(input);
            int packetId = readVarInt(input);
            if (packetId != 0) throw new IOException("Unexpected Minecraft status packet: " + packetId);
            int length = readVarInt(input);
            if (length <= 0 || length > MAX_MANIFEST_BYTES) throw new IOException("Invalid Minecraft status response length.");
            byte[] data = new byte[length];
            input.readFully(data);
            JsonElement parsed = new JsonParser().parse(new String(data, StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) throw new IOException("Minecraft status response is not JSON.");
            return parsed.getAsJsonObject();
        } catch (IOException error) {
            throw new IOException("Could not reach Minecraft server " + formatAddress(handshakeHost, port) + ": " + error.getMessage(), error);
        } finally {
            try { socket.close(); } catch (Exception ignored) { }
        }
    }

    private static int extractManifestPort(JsonObject status) {
        try {
            if (status.has("impulseManifestPort")) {
                int port = status.get("impulseManifestPort").getAsInt();
                if (validPort(port)) return port;
            }
            if (status.has("impulse") && status.get("impulse").isJsonObject()) {
                JsonObject impulse = status.getAsJsonObject("impulse");
                for (String key : Arrays.asList("manifestPort", "manifest_port")) {
                    if (impulse.has(key)) {
                        int port = impulse.get(key).getAsInt();
                        if (validPort(port)) return port;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        String searchable = status.toString();
        Matcher marker = MOTD_PORT.matcher(searchable);
        if (marker.find()) {
            int port = parsePort(marker.group(1));
            if (validPort(port)) return port;
        }
        Matcher text = TEXT_PORT.matcher(searchable);
        if (text.find()) {
            int port = parsePort(text.group(1));
            if (validPort(port)) return port;
        }
        return DEFAULT_MANIFEST_PORT;
    }

    private static Address parseAddress(String input) throws IOException {
        String raw = clean(input, "");
        if (raw.length() == 0) throw new IOException("Enter a Minecraft server address.");
        if (raw.contains("://")) {
            try {
                URI uri = URI.create(raw);
                raw = uri.getHost() + (uri.getPort() > 0 ? ":" + uri.getPort() : "");
            } catch (Exception error) {
                throw new IOException("Invalid Minecraft server address.", error);
            }
        }
        String host;
        int port = DEFAULT_MINECRAFT_PORT;
        boolean explicitPort = false;
        if (raw.startsWith("[")) {
            int close = raw.indexOf(']');
            if (close < 0) throw new IOException("Invalid bracketed IPv6 address.");
            host = raw.substring(1, close);
            if (close + 1 < raw.length()) {
                if (raw.charAt(close + 1) != ':') throw new IOException("Invalid Minecraft server address.");
                port = parsePort(raw.substring(close + 2));
                explicitPort = true;
            }
        } else {
            int first = raw.indexOf(':');
            int last = raw.lastIndexOf(':');
            if (first > 0 && first == last) {
                host = raw.substring(0, first);
                port = parsePort(raw.substring(first + 1));
                explicitPort = true;
            } else {
                host = raw;
            }
        }
        host = host.trim();
        if (host.length() == 0 || !validPort(port)) throw new IOException("Invalid Minecraft server address or port.");
        if (!explicitPort && host.indexOf(':') < 0) {
            Address srv = resolveMinecraftSrv(host);
            if (srv != null) return srv;
        }
        return new Address(host, host, port);
    }

    private static Address resolveMinecraftSrv(String host) {
        DirContext context = null;
        try {
            Hashtable<String, String> environment = new Hashtable<String, String>();
            environment.put("java.naming.factory.initial", "com.sun.jndi.dns.DnsContextFactory");
            environment.put("com.sun.jndi.dns.timeout.initial", "2000");
            environment.put("com.sun.jndi.dns.timeout.retries", "1");
            context = new InitialDirContext(environment);
            Attributes attributes = context.getAttributes("_minecraft._tcp." + host, new String[] { "SRV" });
            Attribute records = attributes.get("SRV");
            if (records == null) return null;
            int bestPriority = Integer.MAX_VALUE;
            int bestWeight = -1;
            String bestTarget = null;
            int bestPort = -1;
            for (int index = 0; index < records.size(); index++) {
                String[] parts = String.valueOf(records.get(index)).trim().split("\\s+");
                if (parts.length != 4) continue;
                int priority = parsePort(parts[0]);
                int weight = parsePort(parts[1]);
                int candidatePort = parsePort(parts[2]);
                String target = parts[3];
                while (target.endsWith(".")) target = target.substring(0, target.length() - 1);
                if (!validPort(candidatePort) || target.length() == 0) continue;
                if (priority < bestPriority || priority == bestPriority && weight > bestWeight) {
                    bestPriority = priority;
                    bestWeight = weight;
                    bestTarget = target;
                    bestPort = candidatePort;
                }
            }
            return bestTarget == null ? null : new Address(host, bestTarget, bestPort);
        } catch (Exception ignored) {
            return null;
        } finally {
            if (context != null) try { context.close(); } catch (Exception ignored) { }
        }
    }

    private static void normalizeManifest(Manifest manifest) {
        if (manifest == null) return;
        if (manifest.server == null) manifest.server = new ServerInfo();
        if (manifest.minecraft == null) manifest.minecraft = new MinecraftInfo();
        if (manifest.mods == null) manifest.mods = new ArrayList<ManifestMod>();
        if (manifest.optional_mods == null) manifest.optional_mods = new ArrayList<ManifestMod>();
        if (manifest.optional_mod_categories == null) manifest.optional_mod_categories = new ArrayList<OptionalCategory>();
        for (ManifestMod mod : manifest.mods) normalizeMod(mod, true);
        for (ManifestMod mod : manifest.optional_mods) normalizeMod(mod, false);
    }

    private static void verifyManifestModOrigins(Manifest manifest) {
        List<ManifestMod> all = new ArrayList<ManifestMod>();
        all.addAll(safeMods(manifest));
        all.addAll(safeOptionalMods(manifest));
        JsonObject recognized = null;
        JsonObject versions = null;
        File cacheFile = new File(new File(new File(System.getProperty("user.dir", "."), "impulse"), "standalone"), "mod-verification-cache.json");
        VerificationCache cache = new VerificationCache();
        try {
            if (cacheFile.isFile()) cache = GSON.fromJson(readAll(new FileInputStream(cacheFile), 4 * 1024 * 1024), VerificationCache.class);
            if (cache == null) cache = new VerificationCache();
            if (cache.entries == null) cache.entries = new HashMap<String, VerificationCacheEntry>();
        } catch (Exception ignored) { cache = new VerificationCache(); }
        try {
            HttpPayload registry = readPayload(new URL("https://api.impulsemc.com/v1/mod-verification/recognized-mods"), 2 * 1024 * 1024, 5000, 10000);
            JsonObject root = new JsonParser().parse(new String(registry.body, StandardCharsets.UTF_8)).getAsJsonObject();
            recognized = root.has("mods") && root.get("mods").isJsonObject() ? root.getAsJsonObject("mods") : new JsonObject();
        } catch (Exception error) { System.err.println("[Impulse] Recognized mod registry unavailable: " + error.getMessage()); }
        try {
            JsonObject request = new JsonObject();
            JsonArray hashes = new JsonArray();
            for (ManifestMod mod : all) if (clean(mod.sha512, "").matches("[0-9a-f]{128}")) hashes.add(new JsonPrimitive(mod.sha512));
            request.add("hashes", hashes);
            request.addProperty("algorithm", "sha512");
            HttpURLConnection connection = (HttpURLConnection) new URL("https://api.modrinth.com/v2/version_files").openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(10000);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("User-Agent", "ImpulseStandalone/1.2 (https://impulsemc.com)");
            OutputStream output = connection.getOutputStream();
            try { output.write(request.toString().getBytes(StandardCharsets.UTF_8)); } finally { output.close(); }
            if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
            versions = new JsonParser().parse(readAll(connection.getInputStream(), 8 * 1024 * 1024)).getAsJsonObject();
            connection.disconnect();
        } catch (Exception error) { System.err.println("[Impulse] Modrinth verification unavailable: " + error.getMessage()); }
        for (ManifestMod mod : all) {
            mod.verification = new Verification();
            String hash = clean(mod.sha512, "");
            if (isImpulseFile(mod.file_name) || (recognized != null && recognized.has(hash))) mod.verification.status = "Recognized by Impulse";
            else if (versions != null) {
                if (!versions.has(hash) || !versions.get(hash).isJsonObject()) mod.verification.modrinth_status = "Unverified";
                else {
                    JsonObject version = versions.getAsJsonObject(hash);
                    boolean game = jsonArrayContains(version.get("game_versions"), clean(manifest.minecraft.version, ""));
                    boolean loader = jsonArrayContains(version.get("loaders"), clean(manifest.minecraft.loader, "").toLowerCase(Locale.US));
                    mod.verification.modrinth_status = game && loader ? "Matched on Modrinth" : "Incompatible Modrinth listing";
                    if ("Matched on Modrinth".equals(mod.verification.modrinth_status)) mod.verification.status = mod.verification.modrinth_status;
                }
            }
            VerificationCacheEntry cached = cache.entries.get(hash);
            if ("Pending CurseForge verification".equals(mod.verification.status) && cached != null && cached.expires_at > System.currentTimeMillis()
                && ("Matched on Modrinth".equals(cached.status) || "Recognized by Impulse".equals(cached.status))) mod.verification.status = cached.status;
            if (hash.length() > 0 && !"Pending CurseForge verification".equals(mod.verification.status)) {
                VerificationCacheEntry entry = new VerificationCacheEntry();
                entry.status = mod.verification.status;
                boolean known = "Matched on Modrinth".equals(entry.status) || "Recognized by Impulse".equals(entry.status);
                entry.expires_at = System.currentTimeMillis() + (known ? 30L : 1L) * 24L * 60L * 60L * 1000L;
                cache.entries.put(hash, entry);
            }
        }
        try { writeTextAtomic(cacheFile, GSON.toJson(cache)); } catch (Exception error) { System.err.println("[Impulse] Could not save mod verification cache: " + error.getMessage()); }
    }

    private static void finalizeManifestModOrigins(File gameDirectory, Manifest manifest, List<ManifestMod> effective, File managedDirectory) {
        List<CurseForgeCandidate> candidates = new ArrayList<CurseForgeCandidate>();
        FingerprintCache fingerprints = loadFingerprintCache(gameDirectory);
        for (ManifestMod mod : effective) {
            if (mod.verification == null) mod.verification = new Verification();
            if ("Recognized by Impulse".equals(mod.verification.status) || "Matched on Modrinth".equals(mod.verification.status)) continue;
            File file = new File(managedDirectory, safeFileName(mod.file_name));
            if (!file.isFile()) {
                mod.verification.status = "User provided";
                continue;
            }
            try {
                Long cached = fingerprints.entries.get(mod.sha512);
                long fingerprint = cached == null ? curseForgeFingerprint(file) : cached.longValue();
                fingerprints.entries.put(mod.sha512, Long.valueOf(fingerprint));
                candidates.add(new CurseForgeCandidate(mod, fingerprint));
            } catch (Exception error) {
                mod.verification.status = "Verification unavailable";
                System.err.println("[Impulse] Could not fingerprint " + mod.file_name + ": " + error.getMessage());
            }
        }
        saveFingerprintCache(gameDirectory, fingerprints);
        if (candidates.isEmpty()) return;

        Map<String, JsonObject> results = new HashMap<String, JsonObject>();
        boolean available = true;
        try {
            for (int offset = 0; offset < candidates.size(); offset += 100) {
                List<CurseForgeCandidate> chunk = candidates.subList(offset, Math.min(candidates.size(), offset + 100));
                JsonObject request = new JsonObject();
                request.addProperty("minecraft_version", clean(manifest.minecraft.version, ""));
                request.addProperty("loader", clean(manifest.minecraft.loader, "").toLowerCase(Locale.US));
                JsonArray files = new JsonArray();
                for (CurseForgeCandidate candidate : chunk) {
                    JsonObject file = new JsonObject();
                    file.addProperty("sha512", candidate.mod.sha512);
                    file.addProperty("fingerprint", candidate.fingerprint);
                    files.add(file);
                }
                request.add("files", files);
                HttpURLConnection connection = (HttpURLConnection) new URL(CURSEFORGE_VERIFICATION_URL).openConnection();
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(15000);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("User-Agent", "ImpulseStandalone/1.2 (https://impulsemc.com)");
                OutputStream output = connection.getOutputStream();
                try { output.write(request.toString().getBytes(StandardCharsets.UTF_8)); } finally { output.close(); }
                if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
                JsonObject response = new JsonParser().parse(readAll(connection.getInputStream(), 4 * 1024 * 1024)).getAsJsonObject();
                JsonObject matches = response.has("matches") && response.get("matches").isJsonObject() ? response.getAsJsonObject("matches") : new JsonObject();
                for (Map.Entry<String, JsonElement> entry : matches.entrySet()) if (entry.getValue().isJsonObject()) results.put(entry.getKey(), entry.getValue().getAsJsonObject());
                connection.disconnect();
            }
        } catch (Exception error) {
            available = false;
            System.err.println("[Impulse] CurseForge verification unavailable: " + error.getMessage());
        }

        for (CurseForgeCandidate candidate : candidates) {
            ManifestMod mod = candidate.mod;
            String modrinth = clean(mod.verification.modrinth_status, "Verification unavailable");
            JsonObject result = results.get(mod.sha512);
            String curseForge = result == null ? "" : clean(jsonString(result, "status"), "");
            if ("Matched on CurseForge".equals(curseForge)) mod.verification.status = curseForge;
            else if ("Incompatible Modrinth listing".equals(modrinth)) mod.verification.status = modrinth;
            else if ("Incompatible CurseForge listing".equals(curseForge)) mod.verification.status = curseForge;
            else mod.verification.status = available ? "Unverified" : "Verification unavailable";
            mod.verification.curseforge = result;
        }
    }

    public static long curseForgeFingerprint(File file) throws IOException {
        long normalizedLength = 0L;
        InputStream countInput = new FileInputStream(file);
        try {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = countInput.read(buffer)) >= 0) for (int i = 0; i < read; i++) if (!curseForgeWhitespace(buffer[i] & 0xff)) normalizedLength++;
        } finally { countInput.close(); }
        int multiplier = 0x5bd1e995;
        int hash = 1 ^ (int) normalizedLength;
        int chunk = 0;
        int chunkBytes = 0;
        InputStream input = new FileInputStream(file);
        try {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                for (int i = 0; i < read; i++) {
                    int value = buffer[i] & 0xff;
                    if (curseForgeWhitespace(value)) continue;
                    chunk |= value << (chunkBytes * 8);
                    chunkBytes++;
                    if (chunkBytes == 4) {
                        int mixed = chunk * multiplier;
                        mixed ^= mixed >>> 24;
                        mixed *= multiplier;
                        hash = hash * multiplier ^ mixed;
                        chunk = 0;
                        chunkBytes = 0;
                    }
                }
            }
        } finally { input.close(); }
        if (chunkBytes > 0) {
            hash ^= chunk;
            hash *= multiplier;
        }
        hash ^= hash >>> 13;
        hash *= multiplier;
        hash ^= hash >>> 15;
        return ((long) hash) & 0xffffffffL;
    }

    private static boolean curseForgeWhitespace(int value) { return value == 0x09 || value == 0x0a || value == 0x0d || value == 0x20; }

    private static FingerprintCache loadFingerprintCache(File gameDirectory) {
        File file = new File(standaloneRoot(gameDirectory), "curseforge-fingerprints.json");
        if (!file.isFile()) return new FingerprintCache();
        try {
            FingerprintCache cache = GSON.fromJson(readAll(new FileInputStream(file), 2 * 1024 * 1024), FingerprintCache.class);
            if (cache == null) cache = new FingerprintCache();
            if (cache.entries == null) cache.entries = new LinkedHashMap<String, Long>();
            return cache;
        } catch (Exception ignored) { return new FingerprintCache(); }
    }

    private static void saveFingerprintCache(File gameDirectory, FingerprintCache cache) {
        try {
            if (cache.entries.size() > 5000) {
                List<String> keys = new ArrayList<String>(cache.entries.keySet());
                for (int i = 0; i < keys.size() - 5000; i++) cache.entries.remove(keys.get(i));
            }
            writeTextAtomic(new File(standaloneRoot(gameDirectory), "curseforge-fingerprints.json"), GSON.toJson(cache));
        } catch (Exception error) { System.err.println("[Impulse] Could not save CurseForge fingerprint cache: " + error.getMessage()); }
    }

    private static boolean jsonArrayContains(JsonElement element, String expected) {
        if (element == null || !element.isJsonArray()) return false;
        for (JsonElement value : element.getAsJsonArray()) if (expected.equalsIgnoreCase(value.getAsString())) return true;
        return false;
    }

    private static String jsonString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) return "";
        try { return object.get(key).getAsString(); } catch (Exception ignored) { return ""; }
    }

    private static void normalizeMod(ManifestMod mod, boolean required) {
        if (mod == null) return;
        mod.file_name = safeFileName(clean(mod.file_name, clean(mod.name, "mod.jar")));
        mod.id = normalizeId(clean(mod.id, clean(mod.sha512, clean(mod.sha1, mod.file_name))));
        mod.name = clean(mod.name, mod.file_name);
        mod.description = clean(mod.description, "");
        mod.sha1 = clean(mod.sha1, "").toLowerCase(Locale.US);
        mod.sha512 = clean(mod.sha512, "").toLowerCase(Locale.US);
        mod.required = required;
        if (mod.dependencies == null) mod.dependencies = new ArrayList<String>();
        if (mod.conflicts == null) mod.conflicts = new ArrayList<String>();
        mod.dependencies = normalizeIds(mod.dependencies);
        mod.conflicts = normalizeIds(mod.conflicts);
    }

    private static String manifestSignature(Manifest manifest) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            List<String> lines = new ArrayList<String>();
            for (ManifestMod mod : safeMods(manifest)) lines.add(normalizeId(mod.id) + ":" + clean(mod.sha512, ""));
            for (ManifestMod mod : safeOptionalMods(manifest)) lines.add(normalizeId(mod.id) + ":" + clean(mod.sha512, "") + ":" + mod.dependencies + ":" + mod.conflicts);
            Collections.sort(lines);
            return hex(digest.digest(lines.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            return String.valueOf(manifest == null ? 0 : manifest.hashCode());
        }
    }

    private static synchronized void saveStore(File gameDirectory, Store store) throws IOException {
        File root = standaloneRoot(gameDirectory);
        if (!root.exists() && !root.mkdirs()) throw new IOException("Could not create " + root);
        writeTextAtomic(storeFile(gameDirectory), GSON.toJson(store));
    }

    private static void writeTextAtomic(File target, String value) throws IOException {
        File parent = target.getParentFile();
        if (!parent.exists()) parent.mkdirs();
        File temporary = new File(parent, target.getName() + ".tmp");
        FileOutputStream output = new FileOutputStream(temporary);
        try { output.write(value.getBytes(StandardCharsets.UTF_8)); } finally { output.close(); }
        moveAtomic(temporary, target);
    }

    private static void moveAtomic(File source, File target) throws IOException {
        try {
            Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception ignored) {
            Files.move(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static File standaloneRoot(File gameDirectory) { return new File(gameDirectory, "impulse/standalone"); }
    private static File storeFile(File gameDirectory) { return new File(standaloneRoot(gameDirectory), "profiles.json"); }

    private static Profile activeProfile(Store store) {
        if (store == null || store.active_profile_id == null) return null;
        Profile profile = findProfile(store, store.active_profile_id);
        return profile;
    }

    private static Profile findProfile(Store store, String id) {
        if (store == null || store.profiles == null || id == null) return null;
        for (Profile profile : store.profiles) if (profile != null && id.equals(profile.id)) return profile;
        return null;
    }

    private static String profileId(String host, int port, int manifestPort) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            String hash = hex(digest.digest((host.toLowerCase(Locale.US) + ":" + port + ":" + manifestPort).getBytes(StandardCharsets.UTF_8)));
            return hash.substring(0, 16);
        } catch (Exception error) {
            return Integer.toHexString((host + port + manifestPort).hashCode());
        }
    }

    public static String sha1(File file) throws IOException {
        if (file == null || !file.isFile()) return "";
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            FileInputStream input = new FileInputStream(file);
            try {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) digest.update(buffer, 0, read);
            } finally { input.close(); }
            return hex(digest.digest());
        } catch (IOException error) {
            throw error;
        } catch (Exception error) {
            throw new IOException("Could not hash " + file, error);
        }
    }

    public static String sha512(File file) throws IOException {
        return digestFile(file, "SHA-512");
    }

    private static String digestFile(File file, String algorithm) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance(algorithm);
            FileInputStream input = new FileInputStream(file);
            try {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) digest.update(buffer, 0, read);
            } finally { input.close(); }
            return hex(digest.digest());
        } catch (Exception error) { throw new IOException("Unable to calculate " + algorithm + " for " + file.getName(), error); }
    }

    public static void requireSha512(List<ManifestMod> mods) throws IOException {
        for (ManifestMod mod : mods == null ? Collections.<ManifestMod>emptyList() : mods) {
            if (mod == null || !clean(mod.sha512, "").matches("[0-9a-f]{128}")) throw new IOException(OUTDATED_HASH_MESSAGE);
        }
    }

    private static HttpPayload readPayload(URL url, int limit, int connectTimeout, int readTimeout) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(connectTimeout);
        connection.setReadTimeout(readTimeout);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "Impulse-Standalone/0.1");
        int status = connection.getResponseCode();
        if (status != 200) {
            connection.disconnect();
            throw new IOException("HTTP " + status + " while fetching " + url);
        }
        InputStream input = connection.getInputStream();
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (output.size() + read > limit) throw new IOException("Response exceeds " + limit + " bytes.");
                output.write(buffer, 0, read);
            }
            return new HttpPayload(
                output.toByteArray(),
                connection.getHeaderField("X-Impulse-Signature-Algorithm"),
                connection.getHeaderField("X-Impulse-Public-Key"),
                connection.getHeaderField("X-Impulse-Key-Id"),
                connection.getHeaderField("X-Impulse-Signature")
            );
        } finally { input.close(); connection.disconnect(); }
    }

    private static String verifyManifestPayload(HttpPayload payload, String expectedPublicKey) throws IOException {
        boolean any = clean(payload.algorithm, "").length() > 0 || clean(payload.publicKey, "").length() > 0
            || clean(payload.keyId, "").length() > 0 || clean(payload.signature, "").length() > 0;
        if (!any) {
            if (clean(expectedPublicKey, "").length() > 0) throw new IOException("Manifest security check failed: this server stopped signing its manifest.");
            return null;
        }
        if (!"ed25519".equalsIgnoreCase(clean(payload.algorithm, "")) || clean(payload.publicKey, "").length() == 0 || clean(payload.signature, "").length() == 0) {
            throw new IOException("Manifest security check failed: incomplete Ed25519 signature headers.");
        }
        try {
            byte[] publicBytes = Base64.getUrlDecoder().decode(payload.publicKey);
            String fingerprint = hex(MessageDigest.getInstance("SHA-256").digest(publicBytes));
            if (clean(payload.keyId, "").length() > 0 && !fingerprint.equalsIgnoreCase(payload.keyId)) {
                throw new IOException("Manifest security check failed: the signing key fingerprint is invalid.");
            }
            if (clean(expectedPublicKey, "").length() > 0 && !expectedPublicKey.equals(payload.publicKey)) {
                throw new IOException("Manifest signing key changed. Expected " + shortFingerprint(expectedPublicKey) + ", received " + fingerprint + ".");
            }
            PublicKey key = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(publicBytes));
            Signature verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(key);
            verifier.update(payload.body);
            if (!verifier.verify(Base64.getUrlDecoder().decode(payload.signature))) {
                throw new IOException("Manifest security check failed: invalid Ed25519 signature.");
            }
            return payload.publicKey;
        } catch (IOException error) {
            throw error;
        } catch (Exception error) {
            throw new IOException("Manifest security check failed: " + error.getMessage(), error);
        }
    }

    private static String shortFingerprint(String publicKey) {
        try { return hex(MessageDigest.getInstance("SHA-256").digest(Base64.getUrlDecoder().decode(publicKey))); }
        catch (Exception ignored) { return "unknown"; }
    }

    private static String readAll(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            if (output.size() + read > limit) throw new IOException("Response exceeds " + limit + " bytes.");
            output.write(buffer, 0, read);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void writePacket(OutputStream output, byte[] body) throws IOException {
        writeVarInt(output, body.length);
        output.write(body);
        output.flush();
    }

    private static void writeString(OutputStream output, String value) throws IOException {
        byte[] data = value.getBytes(StandardCharsets.UTF_8);
        writeVarInt(output, data.length);
        output.write(data);
    }

    private static void writeVarInt(OutputStream output, int value) throws IOException {
        while ((value & -128) != 0) {
            output.write(value & 127 | 128);
            value >>>= 7;
        }
        output.write(value);
    }

    private static int readVarInt(DataInputStream input) throws IOException {
        int value = 0;
        int position = 0;
        byte current;
        do {
            current = input.readByte();
            value |= (current & 127) << position++ * 7;
            if (position > 5) throw new IOException("VarInt is too large.");
        } while ((current & 128) == 128);
        return value;
    }

    private static List<String> normalizeIds(List<String> values) {
        LinkedHashSet<String> ids = new LinkedHashSet<String>();
        if (values != null) for (String value : values) {
            String id = normalizeId(value);
            if (id.length() > 0) ids.add(id);
        }
        return new ArrayList<String>(ids);
    }

    private static String normalizeId(String value) { return clean(value, "").toLowerCase(Locale.US); }
    private static String clean(String value, String fallback) { return value == null || value.trim().length() == 0 ? fallback : value.trim(); }
    private static int parsePort(String value) { try { return Integer.parseInt(value); } catch (Exception ignored) { return -1; } }
    private static boolean validPort(int port) { return port > 0 && port <= 65535; }
    private static String safeFileName(String value) {
        String normalized = clean(value, "mod.jar").replace('\\', '/');
        String name = normalized.substring(normalized.lastIndexOf('/') + 1);
        if (name.length() == 0 || ".".equals(name) || "..".equals(name)) return "mod.jar";
        return name;
    }
    private static boolean isImpulseFile(String value) { return "impulse.jar".equalsIgnoreCase(safeFileName(value)); }
    private static String displayName(ManifestMod mod) { return mod == null ? "unknown mod" : clean(mod.name, mod.file_name); }
    private static String formatAddress(String host, int port) { return host.indexOf(':') >= 0 ? "[" + host + "]:" + port : host + ":" + port; }
    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(Locale.US, "%02x", value & 0xff));
        return out.toString();
    }
    private static void closeQuietly(InputStream input) { if (input != null) try { input.close(); } catch (Exception ignored) { } }
    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        try { Files.deleteIfExists(file.toPath()); } catch (Exception ignored) { }
    }
    private static List<ManifestMod> safeMods(Manifest manifest) { return manifest == null || manifest.mods == null ? Collections.<ManifestMod>emptyList() : manifest.mods; }
    private static List<ManifestMod> safeOptionalMods(Manifest manifest) { return manifest == null || manifest.optional_mods == null ? Collections.<ManifestMod>emptyList() : manifest.optional_mods; }
    private static List<OptionalCategory> safeCategories(Manifest manifest) { return manifest == null || manifest.optional_mod_categories == null ? Collections.<OptionalCategory>emptyList() : manifest.optional_mod_categories; }

    public interface ProgressReporter {
        ProgressReporter NONE = new ProgressReporter() {
            public void message(String text) { }
            public void begin(String text, int steps) { }
            public void progress(String text, int current, int total) { }
            public void end() { }
        };
        void message(String text);
        void begin(String text, int steps);
        void progress(String text, int current, int total);
        void end();
    }

    public enum UiOutcome {
        SELECTED,
        FALLBACK,
        QUIT
    }

    private static final class UiBundle {
        final String classpath;
        final File assetsDirectory;
        final File rootDirectory;

        UiBundle(String classpath, File assetsDirectory, File rootDirectory) {
            this.classpath = classpath;
            this.assetsDirectory = assetsDirectory;
            this.rootDirectory = rootDirectory;
        }
    }

    public static final class UiRequest {
        public String game_directory;
        public String minecraft_version;
        public String loader;
        public String loader_version;
        public String session_directory;
        public String assets_directory;
        public long parent_pid;
        public String impulse_version;
    }

    public static final class UiResult {
        public String status;
        public String profile_id;
        public String error;
    }

    public static final class Store {
        public int version = 1;
        public String active_profile_id;
        public List<Profile> profiles = new ArrayList<Profile>();
    }

    public static final class Profile {
        public String id;
        public String name;
        public String address;
        public String host;
        public int minecraft_port = DEFAULT_MINECRAFT_PORT;
        public int manifest_port = DEFAULT_MANIFEST_PORT;
        public List<String> selected_optional_ids = new ArrayList<String>();
        public String manifest_signature;
        public String manifest_public_key;
        public String accepted_unverified_mod_signature;
        public long created_at;
        public long updated_at;
    }

    public static final class CustomModState {
        public int version = 1;
        public List<CustomModEntry> mods = new ArrayList<CustomModEntry>();
        public long updated_at;
    }

    public static final class CustomModEntry {
        public String project_id;
        public String version_id;
        public String name;
        public String description;
        public String version_number;
        public String file_name;
        public String download_url;
        public String sha1;
        public long size;
        public List<String> mod_ids = new ArrayList<String>();
        public boolean explicit;
        public List<String> required_by = new ArrayList<String>();
        public String channel = "release";
        public String status = "ready";
        public String status_message;
        public String update_version_id;
        public String update_version_number;
        public String location = "profile";
    }

    private static final class SkippedGlobalState {
        public List<SkippedGlobalFile> files = new ArrayList<SkippedGlobalFile>();
    }

    private static final class SkippedGlobalFile {
        public String file_name;
    }

    public static final class Manifest {
        public int manifest_version;
        public String name;
        public String description;
        public String icon_url;
        public String banner_url;
        public String video_background_url;
        public ServerInfo server;
        public MinecraftInfo minecraft;
        public List<ManifestMod> mods = new ArrayList<ManifestMod>();
        public List<ManifestMod> optional_mods = new ArrayList<ManifestMod>();
        public List<OptionalCategory> optional_mod_categories = new ArrayList<OptionalCategory>();
    }

    public static final class ServerInfo {
        public String address;
        public int port = DEFAULT_MINECRAFT_PORT;
        public boolean auto_connect;
    }

    public static final class MinecraftInfo {
        public String version;
        public String loader = "forge";
        public String loader_version;
    }

    public static final class ManifestMod {
        public String id;
        public String name;
        public String description;
        public String file_name;
        public String download_url;
        public String sha1;
        public String sha512;
        public Verification verification;
        public long size;
        public boolean required;
        public String category_id;
        public List<String> dependencies = new ArrayList<String>();
        public List<String> conflicts = new ArrayList<String>();
    }

    public static final class Verification {
        public String status = "Pending CurseForge verification";
        public String modrinth_status = "Verification unavailable";
        public JsonObject curseforge;
    }
    private static final class VerificationCache { Map<String, VerificationCacheEntry> entries = new HashMap<String, VerificationCacheEntry>(); }
    private static final class VerificationCacheEntry { String status; long expires_at; }
    private static final class FingerprintCache { Map<String, Long> entries = new LinkedHashMap<String, Long>(); }
    private static final class CurseForgeCandidate {
        final ManifestMod mod;
        final long fingerprint;
        CurseForgeCandidate(ManifestMod mod, long fingerprint) { this.mod = mod; this.fingerprint = fingerprint; }
    }

    public static final class OptionalCategory {
        public String id;
        public String name;
        public String description;
        public boolean default_enabled;
        public int order;
    }

    public static final class Discovery {
        public final String host;
        public final int minecraftPort;
        public final int manifestPort;
        public final String manifestUrl;
        public final String rawManifest;
        public final Manifest manifest;
        public final String manifestPublicKey;

        private Discovery(String host, int minecraftPort, int manifestPort, String manifestUrl, String rawManifest, Manifest manifest, String manifestPublicKey) {
            this.host = host;
            this.minecraftPort = minecraftPort;
            this.manifestPort = manifestPort;
            this.manifestUrl = manifestUrl;
            this.rawManifest = rawManifest;
            this.manifest = manifest;
            this.manifestPublicKey = manifestPublicKey;
        }

        public long totalRequiredBytes() {
            long total = 0L;
            for (ManifestMod mod : safeMods(manifest)) total += Math.max(0L, mod.size);
            return total;
        }
    }

    public static final class RestrictedServerException extends IOException {
        public final String host;
        public final String reasonCode;
        public final String title;
        public final String description;

        private RestrictedServerException(String host, String reasonCode, String title, String description) {
            super(SERVER_ACCESS_RESTRICTED_HEADING + ". " + title + ": " + description);
            this.host = clean(host, "Unknown server");
            this.reasonCode = clean(reasonCode, "policy_violation");
            this.title = clean(title, "Security restriction");
            this.description = clean(description, "Impulse has restricted access to this server because it may present a risk to players.");
        }
    }

    private static final class HttpPayload {
        final byte[] body;
        final String algorithm;
        final String publicKey;
        final String keyId;
        final String signature;

        HttpPayload(byte[] body, String algorithm, String publicKey, String keyId, String signature) {
            this.body = body;
            this.algorithm = algorithm;
            this.publicKey = publicKey;
            this.keyId = keyId;
            this.signature = signature;
        }
    }

    public static final class BootstrapResult {
        public final boolean active;
        public final boolean setupRequired;
        public final File managedModsDirectory;
        public final File customModsDirectory;
        public final List<File> customModFiles;
        public final Profile profile;
        public final Manifest manifest;

        private BootstrapResult(boolean active, boolean setupRequired, File managedModsDirectory, File customModsDirectory,
                                List<File> customModFiles, Profile profile, Manifest manifest) {
            this.active = active;
            this.setupRequired = setupRequired;
            this.managedModsDirectory = managedModsDirectory;
            this.customModsDirectory = customModsDirectory;
            this.customModFiles = customModFiles == null ? Collections.<File>emptyList() : customModFiles;
            this.profile = profile;
            this.manifest = manifest;
        }

        private static BootstrapResult inactive() { return new BootstrapResult(false, false, null, null, null, null, null); }
        private static BootstrapResult setupRequired() { return new BootstrapResult(false, true, null, null, null, null, null); }
    }

    private static final class Address {
        final String host;
        final String connectHost;
        final int port;
        Address(String host, String connectHost, int port) { this.host = host; this.connectHost = connectHost; this.port = port; }
    }
}
