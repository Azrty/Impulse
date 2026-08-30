package com.impulse.standalone.ui;

import co.casterlabs.rakurai.json.element.JsonArray;
import co.casterlabs.rakurai.json.element.JsonString;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.impulse.bootstrap.ImpulseStandaloneBootstrap;
import dev.webview.Webview;
import com.sun.jna.Library;
import com.sun.jna.Native;
import com.sun.jna.Pointer;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/** WebView standalone profile selector launched before NeoForge mod discovery. */
public final class ImpulseStandaloneUi {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final int MAX_IMAGE_BYTES = 6 * 1024 * 1024;
    private static final int MAX_FRONTEND_BYTES = 8 * 1024 * 1024;
    private static final long FRONTEND_READY_TIMEOUT_MS = 60000L;
    private static final int MAX_UPDATES_BYTES = 1024 * 1024;
    private static final long IMAGE_CACHE_MAX_BYTES = 100L * 1024L * 1024L;
    private static final long IMAGE_CACHE_MAX_AGE = 30L * 24L * 60L * 60L * 1000L;
    private static final String UPDATES_URL = "https://api.impulsemc.com/v1/standalone/updates";
    private static final Set<String> UPDATE_ICONS = Set.of("sparkles", "shield-check", "package-plus", "scan-check", "wrench", "rocket", "server", "download");

    private final ImpulseStandaloneBootstrap.UiRequest request;
    private final File gameDirectory;
    private final File sessionDirectory;
    private final ExecutorService operations = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "impulse-web-operations");
        thread.setDaemon(true);
        return thread;
    });
    private final ExecutorService images = Executors.newFixedThreadPool(4, runnable -> {
        Thread thread = new Thread(runnable, "impulse-web-images");
        thread.setDaemon(true);
        return thread;
    });
    private final Map<String, Operation> operationMap = new ConcurrentHashMap<String, Operation>();
    private final Map<String, ImageJob> imageJobs = new ConcurrentHashMap<String, ImageJob>();
    private volatile String selectedProfileId;
    private volatile boolean legalAccepted;
    private volatile boolean completed;
    private volatile Webview webview;
    private volatile boolean webviewRunning;
    private volatile boolean frontendReady;
    private volatile ImpulseStandaloneBootstrap.RestrictedServerException currentRestriction;
    private volatile UpdateRegistry updateRegistry;

    private ImpulseStandaloneUi(ImpulseStandaloneBootstrap.UiRequest request) {
        this.request = request;
        this.gameDirectory = new File(request.game_directory);
        this.sessionDirectory = new File(request.session_directory);
        this.legalAccepted = loadLegalAcceptance();
        this.updateRegistry = loadCachedUpdates();
        ImpulseStandaloneBootstrap.Store store = ImpulseStandaloneBootstrap.loadStore(gameDirectory);
        this.selectedProfileId = store.active_profile_id;
        if (selectedProfileId == null && store.profiles != null && !store.profiles.isEmpty()) {
            selectedProfileId = store.profiles.get(0).id;
        }
    }

    public static void main(String[] args) {
        ImpulseStandaloneBootstrap.UiRequest request = null;
        try {
            if (args.length != 1) throw new IOException("Expected the standalone UI request path.");
            request = GSON.fromJson(Files.readString(new File(args[0]).toPath(), StandardCharsets.UTF_8),
                ImpulseStandaloneBootstrap.UiRequest.class);
            if (request == null || request.session_directory == null || request.game_directory == null) {
                throw new IOException("The standalone UI request is invalid.");
            }
            new ImpulseStandaloneUi(request).run();
        } catch (Throwable error) {
            System.err.println("[Impulse UI] WebView selector failed: " + error.getMessage());
            error.printStackTrace(System.err);
            if (request != null) writeFailure(request, error);
        }
    }

    private void run() throws Exception {
        System.out.println("[Impulse UI] Starting WebView profile selector for " + request.loader + " " + request.loader_version);
        cleanupImageCache();
        configureWindowsDpi();
        Webview window = null;
        try {
            File frontend = extractFrontend();
            String frontendUrl = frontend.toURI().toASCIIString();
            System.out.println("[Impulse UI] WebView backend: " + webviewBackend());
            System.out.println("[Impulse UI] Standalone frontend: " + frontend.getAbsolutePath() + " (" + frontend.length() + " bytes)");
            window = new Webview(Boolean.getBoolean("impulse.ui.debug"));
            this.webview = window;
            startParentWatchdog();
            window.setTitle("Impulse - Choose a server");
            window.setMinSize(760, 520);
            window.setSize(1180, 760);
            window.bind("impulseBridge", this::bridge);
            System.out.println("[Impulse UI] Navigating to " + frontendUrl);
            window.loadURL(frontendUrl);
            startFrontendReadyWatchdog();
            webviewRunning = true;
            window.run();
        } catch (Throwable error) {
            System.err.println("[Impulse UI] WebView startup or navigation failed: " + clean(error.getMessage(), error.getClass().getSimpleName()));
            if (error instanceof Exception) throw (Exception) error;
            if (error instanceof Error) throw (Error) error;
            throw new RuntimeException(error);
        } finally {
            System.out.println("[Impulse UI] Cleaning up standalone WebView resources.");
            webviewRunning = false;
            webview = null;
            for (Operation operation : operationMap.values()) operation.cancel();
            operations.shutdownNow();
            images.shutdownNow();
            awaitExecutor(operations);
            awaitExecutor(images);
            operationMap.clear();
            imageJobs.clear();
            System.out.println("[Impulse UI] Standalone WebView cleanup complete.");
        }
        if (!completed) writeResult(legalAccepted ? "fallback" : "quit", null, null);
    }

    private void startParentWatchdog() {
        if (request.parent_pid <= 0L) return;
        Thread watchdog = new Thread(() -> {
            while (!completed && webview != null) {
                boolean parentAlive = ProcessHandle.of(request.parent_pid).map(ProcessHandle::isAlive).orElse(false);
                if (!parentAlive) {
                    System.err.println("[Impulse UI] Minecraft exited; closing the standalone selector.");
                    completed = true;
                    closeWindow();
                    return;
                }
                try { Thread.sleep(2000L); }
                catch (InterruptedException ignored) { Thread.currentThread().interrupt(); return; }
            }
        }, "impulse-parent-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
    }

    private void startFrontendReadyWatchdog() {
        Thread watchdog = new Thread(() -> {
            try { Thread.sleep(FRONTEND_READY_TIMEOUT_MS); }
            catch (InterruptedException ignored) { Thread.currentThread().interrupt(); return; }
            if (frontendReady || completed || webview == null) return;
            System.err.println("[Impulse UI] React frontend did not become ready within 60 seconds; closing the WebView.");
            writeResult(legalAccepted ? "fallback" : "quit", null,
                new IOException("The standalone web interface did not become ready."));
            completed = true;
            closeWindow();
        }, "impulse-frontend-ready-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
    }

    private static void awaitExecutor(ExecutorService executor) {
        try {
            if (!executor.awaitTermination(2L, TimeUnit.SECONDS)) {
                System.err.println("[Impulse UI] A background worker did not stop before shutdown.");
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    private co.casterlabs.rakurai.json.element.JsonElement bridge(JsonArray arguments) {
        String response;
        try {
            String raw = arguments == null || arguments.isEmpty() ? "{}" : arguments.getString(0);
            JsonObject command = new JsonParser().parse(raw).getAsJsonObject();
            String action = string(command, "action");
            Object data = handle(action, command);
            Map<String, Object> envelope = new LinkedHashMap<String, Object>();
            envelope.put("ok", true);
            envelope.put("data", data);
            response = GSON.toJson(envelope);
        } catch (Throwable error) {
            Map<String, Object> envelope = new LinkedHashMap<String, Object>();
            envelope.put("ok", false);
            envelope.put("error", clean(error.getMessage(), "The operation failed."));
            response = GSON.toJson(envelope);
            System.err.println("[Impulse UI] Bridge error: " + clean(error.getMessage(), error.getClass().getSimpleName()));
        }
        return new JsonString(response);
    }

    private Object handle(String action, JsonObject command) throws Exception {
        if ("ready".equals(action)) {
            frontendReady = true;
            writeSignal("ready");
            writeSignal("heartbeat");
            System.out.println("[Impulse UI] React bridge ready.");
            return Collections.singletonMap("time", System.currentTimeMillis());
        }
        if ("heartbeat".equals(action)) {
            writeSignal("heartbeat");
            return Collections.singletonMap("time", System.currentTimeMillis());
        }
        if ("state".equals(action)) return state();
        if ("selectProfile".equals(action)) {
            currentRestriction = null;
            selectedProfileId = required(command, "profile_id");
            ImpulseStandaloneBootstrap.setActiveProfile(gameDirectory, selectedProfileId);
            return state();
        }
        if ("clearRestriction".equals(action)) {
            currentRestriction = null;
            return state();
        }
        if ("setUpdateChannel".equals(action)) {
            setUpdateChannel(string(command, "channel"));
            return state();
        }
        if ("completeOnboarding".equals(action)) {
            setOnboardingVersion(1);
            return state();
        }
        if ("replayOnboarding".equals(action)) {
            setOnboardingVersion(0);
            return state();
        }
        if ("dismissUpdate".equals(action)) {
            dismissUpdate(required(command, "id"));
            return state();
        }
        if ("refreshUpdates".equals(action)) {
            refreshUpdates();
            return state();
        }
        if ("acceptLegal".equals(action)) {
            saveLegalAcceptance();
            legalAccepted = true;
            return state();
        }
        if ("quit".equals(action)) {
            writeResult("quit", null, null);
            completed = true;
            closeWindow();
            return true;
        }
        if ("fallback".equals(action)) {
            if (!legalAccepted) throw new IOException("The Privacy Policy and Terms must be accepted first.");
            writeResult("fallback", null, null);
            completed = true;
            closeWindow();
            return true;
        }
        if ("start".equals(action)) return startOperation(required(command, "kind"), command);
        if ("operation".equals(action)) return operationMap.get(required(command, "id"));
        if ("cancelOperation".equals(action)) return cancelOperation(required(command, "id"));
        if ("image".equals(action)) return image(required(command, "url"));
        if ("clipboardRead".equals(action)) return clipboardRead();
        if ("clipboardWrite".equals(action)) {
            clipboardWrite(string(command, "text"));
            return true;
        }
        if ("openExternal".equals(action)) {
            openExternal(required(command, "url"));
            return true;
        }
        throw new IOException("Unsupported bridge action: " + action);
    }

    private Map<String, Object> state() {
        ImpulseStandaloneBootstrap.Store store = ImpulseStandaloneBootstrap.loadStore(gameDirectory);
        ImpulseStandaloneBootstrap.Profile selected = findProfile(store, selectedProfileId);
        if (selected == null && store.active_profile_id != null) selected = findProfile(store, store.active_profile_id);
        if (selected == null && store.profiles != null && !store.profiles.isEmpty()) selected = store.profiles.get(0);
        if (selected != null) selectedProfileId = selected.id;
        ImpulseStandaloneBootstrap.Manifest manifest = ImpulseStandaloneBootstrap.loadCachedManifest(gameDirectory, selected);

        Map<String, Object> state = new LinkedHashMap<String, Object>();
        state.put("legal_accepted", legalAccepted);
        state.put("legal_version", ImpulseStandaloneBootstrap.LEGAL_DOCUMENT_VERSION);
        state.put("privacy_url", ImpulseStandaloneBootstrap.PRIVACY_POLICY_URL);
        state.put("terms_url", ImpulseStandaloneBootstrap.TERMS_OF_SERVICE_URL);
        state.put("profiles", store.profiles == null ? Collections.emptyList() : store.profiles);
        state.put("active_profile_id", store.active_profile_id);
        state.put("selected_profile", selected);
        state.put("manifest", manifest);
        state.put("update_channel", loadUpdateChannel());
        state.put("impulse_version", clean(request.impulse_version, "unknown"));
        state.put("onboarding_completed", loadOnboardingVersion() >= 1);
        state.put("dismissed_update_ids", dismissedUpdateIds());
        state.put("publications", updateRegistry == null ? Collections.emptyList() : updateRegistry.publications);
        state.put("minecraft_version", request.minecraft_version);
        state.put("loader", request.loader);
        if (currentRestriction != null) state.put("restriction", restrictionMap(currentRestriction));
        if (selected != null) {
            state.put("custom_mods", ImpulseStandaloneBootstrap.loadCustomModState(gameDirectory, selected.id).mods);
            try {
                ImpulseStandaloneBootstrap.RestrictedServerException restriction = ImpulseStandaloneBootstrap.serverRestriction(selected.address);
                if (restriction != null) {
                    currentRestriction = restriction;
                    state.put("restriction", restrictionMap(restriction));
                }
            } catch (Exception error) {
                System.err.println("[Impulse UI] Restriction check failed: " + error.getMessage());
            }
        }
        return state;
    }

    private String startOperation(String kind, JsonObject command) throws IOException {
        if (operationMap.values().stream().anyMatch(value -> "running".equals(value.status))) {
            throw new IOException("Another operation is already running.");
        }
        String id = UUID.randomUUID().toString();
        Operation operation = new Operation(id, kind);
        operationMap.put(id, operation);
        operation.attach(operations.submit(() -> execute(operation, command)));
        return id;
    }

    private Operation cancelOperation(String id) throws IOException {
        Operation operation = operationMap.get(id);
        if (operation == null) throw new IOException("The launch operation no longer exists.");
        if (!"play".equals(operation.kind)) throw new IOException("Only a game launch can be cancelled here.");
        operation.cancel();
        return operation;
    }

    private void execute(Operation operation, JsonObject command) {
        try {
            ImpulseStandaloneBootstrap.setProgressReporter(new ImpulseStandaloneBootstrap.ProgressReporter() {
                public void message(String label) { operation.update(label, operation.completed, operation.total); }
                public void begin(String label, int total) { operation.update(label, 0, total); }
                public void progress(String label, int completed, int total) { operation.update(label, completed, total); }
                public void end() { }
            });
            switch (operation.kind) {
                case "add" -> addServer(operation, required(command, "address"));
                case "refresh" -> refresh(operation, required(command, "profile_id"));
                case "delete" -> delete(operation, required(command, "profile_id"));
                case "report" -> reportServer(operation, command);
                case "optional" -> updateOptional(operation, required(command, "profile_id"), strings(command, "ids"));
                case "play" -> play(operation, required(command, "profile_id"), bool(command, "accept_unverified"));
                case "searchMods" -> searchMods(operation, command);
                case "project" -> project(operation, command);
                case "versions" -> versions(operation, command);
                case "planMod" -> planMod(operation, command);
                case "installMod" -> installMod(operation, command);
                case "removeMod" -> removeMod(operation, command);
                case "repairMod" -> repairMod(operation, command);
                case "checkUpdates" -> checkUpdates(operation, command);
                case "globalMods" -> globalMods(operation, command);
                default -> throw new IOException("Unsupported operation: " + operation.kind);
            }
            operation.done(operation.result);
        } catch (Throwable error) {
            if (operation.cancelRequested || Thread.currentThread().isInterrupted()) {
                operation.cancelled();
                System.out.println("[Impulse UI] Launch cancelled.");
                return;
            }
            if (error instanceof ImpulseStandaloneBootstrap.RestrictedServerException restricted) {
                currentRestriction = restricted;
            }
            operation.fail(error);
            System.err.println("[Impulse UI] " + operation.kind + " failed: " + error.getMessage());
            error.printStackTrace(System.err);
        } finally {
            ImpulseStandaloneBootstrap.setProgressReporter(null);
        }
    }

    private void addServer(Operation operation, String address) throws Exception {
        currentRestriction = null;
        operation.update("Contacting " + address, 0, 1);
        ImpulseStandaloneBootstrap.Discovery discovery = ImpulseStandaloneBootstrap.discoverForSetup(address);
        ImpulseStandaloneBootstrap.validateRuntime(discovery.manifest, request.minecraft_version, request.loader, request.loader_version);
        List<String> defaults = ImpulseStandaloneBootstrap.defaultOptionalIds(discovery.manifest);
        ImpulseStandaloneBootstrap.Profile profile = ImpulseStandaloneBootstrap.saveProfile(gameDirectory, discovery, defaults);
        selectedProfileId = profile.id;
        operation.result = state();
    }

    private void refresh(Operation operation, String profileId) throws Exception {
        currentRestriction = null;
        ImpulseStandaloneBootstrap.Profile profile = requireProfile(profileId);
        operation.update("Refreshing " + clean(profile.name, profile.address), 0, 1);
        ImpulseStandaloneBootstrap.Discovery discovery = ImpulseStandaloneBootstrap.discover(profile.address);
        ImpulseStandaloneBootstrap.validateRuntime(discovery.manifest, request.minecraft_version, request.loader, request.loader_version);
        ImpulseStandaloneBootstrap.saveProfile(gameDirectory, discovery, profile.selected_optional_ids);
        selectedProfileId = profileId;
        operation.result = state();
    }

    private void delete(Operation operation, String profileId) throws Exception {
        ImpulseStandaloneBootstrap.deleteProfile(gameDirectory, profileId);
        selectedProfileId = null;
        operation.result = state();
    }

    private void updateOptional(Operation operation, String profileId, List<String> ids) throws Exception {
        ImpulseStandaloneBootstrap.updateOptionalSelection(gameDirectory, profileId, ids);
        operation.result = state();
    }

    private void reportServer(Operation operation, JsonObject command) throws Exception {
        ImpulseStandaloneBootstrap.Profile profile = requireProfile(required(command, "profile_id"));
        String category = required(command, "category");
        String details = required(command, "details").trim();
        if (!Set.of("malicious_files", "credential_theft", "impersonation", "fraud", "abuse", "other_security").contains(category)) {
            throw new IOException("Select a valid report reason.");
        }
        if (details.length() < 20 || details.length() > 2000) {
            throw new IOException("The report description must contain between 20 and 2000 characters.");
        }
        operation.update("Submitting report", 0, 1);
        JsonObject payload = new JsonObject();
        payload.addProperty("server_name", clean(profile.name, "Minecraft Server"));
        payload.addProperty("server_address", profile.address);
        payload.addProperty("server_host", profile.host);
        payload.addProperty("category", category);
        payload.addProperty("details", details);
        payload.addProperty("minecraft_version", request.minecraft_version);
        payload.addProperty("loader", request.loader);
        payload.addProperty("client", "standalone");

        String apiBase = System.getProperty("impulse.presence.api", "https://api.impulsemc.com").trim();
        if (!apiBase.startsWith("https://") && !apiBase.startsWith("http://127.0.0.1") && !apiBase.startsWith("http://localhost")) {
            throw new IOException("The Impulse report service URL is invalid.");
        }
        HttpURLConnection connection = (HttpURLConnection) new URL(apiBase.replaceAll("/+$", "") + "/v1/security/server-reports").openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(10000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setRequestProperty("User-Agent", "Impulse-Standalone/" + clean(System.getProperty("impulse.version"), "unknown"));
        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(body.length);
        try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
        int status = connection.getResponseCode();
        InputStream responseStream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        String responseBody = responseStream == null ? "" : new String(readLimited(responseStream, 64 * 1024), StandardCharsets.UTF_8);
        if (status < 200 || status >= 300) {
            String message = "Report service returned HTTP " + status + ".";
            try {
                JsonObject error = new JsonParser().parse(responseBody).getAsJsonObject();
                if (error.has("error")) message = error.get("error").getAsString();
            } catch (Exception ignored) { }
            throw new IOException(message);
        }
        JsonObject response = new JsonParser().parse(responseBody).getAsJsonObject();
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("report_submitted", true);
        result.put("report_id", response.has("report_id") ? response.get("report_id").getAsString() : "");
        operation.update("Report submitted", 1, 1);
        operation.result = result;
    }

    private void play(Operation operation, String profileId, boolean acceptUnverified) throws Exception {
        ensureLaunchActive(operation);
        currentRestriction = null;
        ImpulseStandaloneBootstrap.Profile profile = requireProfile(profileId);
        ImpulseStandaloneBootstrap.RestrictedServerException restriction = ImpulseStandaloneBootstrap.serverRestriction(profile.address);
        if (restriction != null) throw restriction;
        operation.update("Checking server", 0, 1);
        ImpulseStandaloneBootstrap.Discovery discovery = ImpulseStandaloneBootstrap.discover(profile.address);
        ensureLaunchActive(operation);
        ImpulseStandaloneBootstrap.validateRuntime(discovery.manifest, request.minecraft_version, request.loader, request.loader_version);
        ImpulseStandaloneBootstrap.Profile prepared = ImpulseStandaloneBootstrap.prepareProfileForLaunch(
            gameDirectory, discovery, profile.selected_optional_ids);
        ensureLaunchActive(operation);
        List<ImpulseStandaloneBootstrap.ManifestMod> problems = ImpulseStandaloneBootstrap.problematicMods(
            discovery.manifest, prepared.selected_optional_ids);
        String signature = ImpulseStandaloneBootstrap.problematicSignature(problems);
        if (!problems.isEmpty() && !signature.equals(prepared.accepted_unverified_mod_signature)) {
            if (!acceptUnverified) {
                Map<String, Object> warning = new LinkedHashMap<String, Object>();
                warning.put("confirmation_required", true);
                warning.put("mods", problems);
                warning.put("signature", signature);
                operation.result = warning;
                return;
            }
            ImpulseStandaloneBootstrap.acceptUnverifiedMods(gameDirectory, prepared.id, signature);
        }
        ImpulseStandaloneBootstrap.setActiveProfile(gameDirectory, prepared.id);
        writeResult("selected", prepared.id, null);
        completed = true;
        operation.result = Collections.singletonMap("selected", true);
        Thread closer = new Thread(() -> {
            try { Thread.sleep(250L); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            closeWindow();
        }, "impulse-web-close");
        closer.setDaemon(true);
        closer.start();
    }

    private static void ensureLaunchActive(Operation operation) throws InterruptedException {
        if (operation.cancelRequested || Thread.currentThread().isInterrupted()) throw new InterruptedException("Launch cancelled.");
    }

    private void searchMods(Operation operation, JsonObject command) throws Exception {
        StandaloneModrinthManager manager = manager(required(command, "profile_id"));
        operation.update("Searching Modrinth", 0, 1);
        operation.result = manager.search(string(command, "query"));
    }

    private void project(Operation operation, JsonObject command) throws Exception {
        operation.result = manager(required(command, "profile_id")).project(required(command, "project_id"));
    }

    private void versions(Operation operation, JsonObject command) throws Exception {
        operation.result = manager(required(command, "profile_id")).versions(required(command, "project_id"),
            StandaloneModrinthManager.Channel.from(string(command, "channel")));
    }

    private void planMod(Operation operation, JsonObject command) throws Exception {
        StandaloneModrinthManager manager = manager(required(command, "profile_id"));
        StandaloneModrinthManager.Channel channel = StandaloneModrinthManager.Channel.from(string(command, "channel"));
        String projectId = required(command, "project_id");
        String versionId = compatibleVersionId(manager, projectId, string(command, "version_id"), channel);
        operation.result = manager.plan(projectId, versionId, channel);
    }

    private void installMod(Operation operation, JsonObject command) throws Exception {
        StandaloneModrinthManager manager = manager(required(command, "profile_id"));
        StandaloneModrinthManager.Channel channel = StandaloneModrinthManager.Channel.from(string(command, "channel"));
        String projectId = required(command, "project_id");
        String versionId = compatibleVersionId(manager, projectId, string(command, "version_id"), channel);
        StandaloneModrinthManager.InstallPlan plan = manager.plan(projectId, versionId, channel);
        StandaloneModrinthManager.InstallLocation location = StandaloneModrinthManager.InstallLocation.from(string(command, "location"));
        manager.install(plan, new HashSet<String>(strings(command, "optional_projects")), location, operation::update);
        operation.result = manager.checkUpdates();
    }

    private String compatibleVersionId(StandaloneModrinthManager manager, String projectId, String requested,
                                       StandaloneModrinthManager.Channel channel) throws IOException {
        if (requested != null && !requested.isEmpty()) return requested;
        List<StandaloneModrinthManager.ProjectVersion> versions = manager.versions(projectId, channel);
        if (versions.isEmpty()) throw new IOException("No compatible version is available for this channel.");
        return versions.get(0).id;
    }

    private void removeMod(Operation operation, JsonObject command) throws Exception {
        StandaloneModrinthManager manager = manager(required(command, "profile_id"));
        manager.remove(required(command, "project_id"));
        operation.result = manager.state();
    }

    private void repairMod(Operation operation, JsonObject command) throws Exception {
        StandaloneModrinthManager manager = manager(required(command, "profile_id"));
        manager.repair(required(command, "project_id"), operation::update);
        operation.result = manager.state();
    }

    private void checkUpdates(Operation operation, JsonObject command) throws Exception {
        operation.result = manager(required(command, "profile_id")).checkUpdates();
    }

    private void globalMods(Operation operation, JsonObject command) throws Exception {
        operation.result = manager(required(command, "profile_id")).globalMods();
    }

    private StandaloneModrinthManager manager(String profileId) throws IOException {
        return new StandaloneModrinthManager(gameDirectory, requireProfile(profileId), request.minecraft_version, request.loader);
    }

    private ImpulseStandaloneBootstrap.Profile requireProfile(String id) throws IOException {
        ImpulseStandaloneBootstrap.Profile profile = findProfile(ImpulseStandaloneBootstrap.loadStore(gameDirectory), id);
        if (profile == null) throw new IOException("Standalone profile not found: " + id);
        return profile;
    }

    private ImpulseStandaloneBootstrap.Profile findProfile(ImpulseStandaloneBootstrap.Store store, String id) {
        if (store == null || store.profiles == null || id == null) return null;
        for (ImpulseStandaloneBootstrap.Profile profile : store.profiles) if (profile != null && id.equals(profile.id)) return profile;
        return null;
    }

    private Map<String, Object> restrictionMap(ImpulseStandaloneBootstrap.RestrictedServerException restriction) {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("heading", ImpulseStandaloneBootstrap.SERVER_ACCESS_RESTRICTED_HEADING);
        out.put("host", restriction.host);
        out.put("reason_code", restriction.reasonCode);
        out.put("title", restriction.title);
        out.put("description", restriction.description);
        return out;
    }

    private ImageJob image(String source) throws IOException {
        URI uri;
        try { uri = URI.create(source); }
        catch (Exception error) { throw new IOException("Invalid image URL."); }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) throw new IOException("Only HTTPS images are allowed.");
        String key = imageCacheFile(source).getName();
        ImageJob existing = imageJobs.get(key);
        if (existing != null) return existing;
        ImageJob created = new ImageJob();
        ImageJob raced = imageJobs.putIfAbsent(key, created);
        if (raced != null) return raced;
        images.submit(() -> {
            try { created.data = loadImageData(source); created.status = "done"; }
            catch (Throwable error) { created.error = clean(error.getMessage(), "Image unavailable"); created.status = "error"; }
        });
        return created;
    }

    private String loadImageData(String source) throws IOException {
        URI uri;
        try { uri = URI.create(source); }
        catch (Exception error) { throw new IOException("Invalid image URL."); }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"https".equals(scheme)) throw new IOException("Only HTTPS images are allowed.");
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        if (host.isEmpty()) throw new IOException("The image host is invalid.");

        File cache = imageCacheFile(source);
        byte[] bytes;
        String contentType;
        if (cache.isFile() && System.currentTimeMillis() - cache.lastModified() < IMAGE_CACHE_MAX_AGE) {
            bytes = Files.readAllBytes(cache.toPath());
        } else {
            HttpURLConnection connection = (HttpURLConnection) new URL(source).openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(8000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "Impulse-Standalone-WebView/1.0 (+https://impulsemc.com)");
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IOException("Image request returned HTTP " + status + ".");
            int declared = connection.getContentLength();
            if (declared > MAX_IMAGE_BYTES) throw new IOException("The image is too large.");
            String declaredType = clean(connection.getContentType(), "").split(";", 2)[0];
            if (!declaredType.isEmpty() && !declaredType.startsWith("image/")) throw new IOException("The URL is not an image.");
            try (InputStream input = connection.getInputStream()) { bytes = readLimited(input, MAX_IMAGE_BYTES); }
            File parent = cache.getParentFile();
            if (!parent.exists()) parent.mkdirs();
            Files.write(cache.toPath(), bytes, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        }
        contentType = detectImageType(bytes);
        return "data:" + contentType + ";base64," + Base64.getEncoder().encodeToString(bytes);
    }

    private String detectImageType(byte[] bytes) throws IOException {
        if (bytes.length >= 8 && (bytes[0] & 0xff) == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4e && bytes[3] == 0x47) return "image/png";
        if (bytes.length >= 3 && (bytes[0] & 0xff) == 0xff && (bytes[1] & 0xff) == 0xd8 && (bytes[2] & 0xff) == 0xff) return "image/jpeg";
        if (bytes.length >= 6 && bytes[0] == 'G' && bytes[1] == 'I' && bytes[2] == 'F') return "image/gif";
        if (bytes.length >= 12 && bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F'
            && bytes[8] == 'W' && bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P') return "image/webp";
        throw new IOException("Unsupported or invalid image data.");
    }

    private File imageCacheFile(String url) {
        String name = Integer.toHexString(url.hashCode());
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(url.getBytes(StandardCharsets.UTF_8));
            StringBuilder value = new StringBuilder();
            for (byte item : hash) value.append(String.format(Locale.ROOT, "%02x", item & 0xff));
            name = value.toString();
        } catch (Exception ignored) { }
        return new File(new File(gameDirectory, "impulse/standalone/ui/cache/server-images"), name + ".image");
    }

    private void cleanupImageCache() {
        File directory = new File(gameDirectory, "impulse/standalone/ui/cache/server-images");
        File[] files = directory.listFiles();
        if (files == null) return;
        List<File> retained = new ArrayList<File>();
        long total = 0L;
        for (File file : files) {
            if (!file.isFile()) continue;
            if (System.currentTimeMillis() - file.lastModified() > IMAGE_CACHE_MAX_AGE) {
                file.delete();
            } else {
                retained.add(file);
                total += file.length();
            }
        }
        retained.sort((left, right) -> Long.compare(left.lastModified(), right.lastModified()));
        for (File file : retained) {
            if (total <= IMAGE_CACHE_MAX_BYTES) break;
            total -= file.length();
            file.delete();
        }
    }

    private void openExternal(String value) throws IOException {
        URI uri = URI.create(value);
        if (!"https".equalsIgnoreCase(uri.getScheme())) throw new IOException("Only HTTPS links are allowed.");
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        if (os.contains("mac")) new ProcessBuilder("open", uri.toString()).start();
        else if (os.contains("win")) new ProcessBuilder("rundll32", "url.dll,FileProtocolHandler", uri.toString()).start();
        else new ProcessBuilder("xdg-open", uri.toString()).start();
    }

    private String clipboardRead() throws IOException {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        Process process;
        if (os.contains("mac")) {
            process = new ProcessBuilder("pbpaste").start();
        } else if (os.contains("win")) {
            process = new ProcessBuilder("powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw").start();
        } else {
            try { process = new ProcessBuilder("wl-paste", "--no-newline").start(); }
            catch (IOException ignored) { process = new ProcessBuilder("xclip", "-selection", "clipboard", "-out").start(); }
        }
        byte[] bytes;
        try (InputStream input = process.getInputStream()) { bytes = readLimited(input, 1024 * 1024); }
        waitForClipboard(process);
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private void clipboardWrite(String text) throws IOException {
        if (text == null) text = "";
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 1024 * 1024) throw new IOException("Clipboard text is too large.");
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        Process process;
        if (os.contains("mac")) {
            process = new ProcessBuilder("pbcopy").start();
        } else if (os.contains("win")) {
            process = new ProcessBuilder("powershell", "-NoProfile", "-NonInteractive", "-Command",
                "$value = [Console]::In.ReadToEnd(); Set-Clipboard -Value $value").start();
        } else {
            try { process = new ProcessBuilder("wl-copy").start(); }
            catch (IOException ignored) { process = new ProcessBuilder("xclip", "-selection", "clipboard", "-in").start(); }
        }
        try (java.io.OutputStream output = process.getOutputStream()) { output.write(bytes); }
        waitForClipboard(process);
    }

    private void waitForClipboard(Process process) throws IOException {
        try {
            if (!process.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new IOException("The system clipboard did not respond.");
            }
            if (process.exitValue() != 0) throw new IOException("The system clipboard is unavailable.");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("Clipboard operation interrupted.", error);
        }
    }

    private static void configureWindowsDpi() {
        if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win")) return;
        try {
            if (WindowsUser32.INSTANCE.SetProcessDpiAwarenessContext(Pointer.createConstant(-4L))) return;
        } catch (Throwable ignored) { }
        try {
            if (WindowsShcore.INSTANCE.SetProcessDpiAwareness(2) == 0) return;
        } catch (Throwable ignored) { }
        try { WindowsUser32.INSTANCE.SetProcessDPIAware(); }
        catch (Throwable error) { System.err.println("[Impulse UI] Could not enable per-monitor DPI awareness: " + error.getMessage()); }
    }

    private File extractFrontend() throws IOException {
        File assetsDirectory = new File(request.assets_directory);
        File bundleRoot = assetsDirectory.getParentFile();
        if (bundleRoot == null || !bundleRoot.isDirectory()) throw new IOException("The standalone UI bundle directory is unavailable.");
        File webDirectory = new File(bundleRoot, "web");
        if (!webDirectory.exists() && !webDirectory.mkdirs()) throw new IOException("Could not create the standalone frontend directory.");
        File target = new File(webDirectory, "index.html");
        byte[] html;
        try (InputStream input = ImpulseStandaloneUi.class.getResourceAsStream("/standalone-web/index.html")) {
            if (input == null) throw new IOException("The embedded standalone web application is missing.");
            html = readLimited(input, MAX_FRONTEND_BYTES);
        }
        if (html.length == 0) throw new IOException("The embedded standalone web application is empty.");
        File temporary = new File(webDirectory, "index.html." + UUID.randomUUID() + ".part");
        Files.write(temporary.toPath(), html, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
        try { Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
        catch (Exception ignored) { Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING); }
        if (!target.isFile() || target.length() != html.length) throw new IOException("The standalone frontend could not be extracted completely.");
        return target;
    }

    private static String webviewBackend() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        if (os.contains("win")) return "WebView2";
        if (os.contains("mac")) return "WKWebView";
        return "WebKitGTK";
    }

    private boolean loadLegalAcceptance() {
        try {
            File file = new File(gameDirectory, "impulse/standalone/legal.json");
            if (!file.isFile()) return false;
            JsonObject json = new JsonParser().parse(Files.readString(file.toPath(), StandardCharsets.UTF_8)).getAsJsonObject();
            return ImpulseStandaloneBootstrap.LEGAL_DOCUMENT_VERSION.equals(string(json, "version"));
        } catch (Exception ignored) { return false; }
    }

    private void saveLegalAcceptance() throws IOException {
        Map<String, Object> value = new LinkedHashMap<String, Object>();
        value.put("version", ImpulseStandaloneBootstrap.LEGAL_DOCUMENT_VERSION);
        value.put("accepted_at", Instant.now().toString());
        writeJsonAtomic(new File(gameDirectory, "impulse/standalone/legal.json"), value);
    }

    private String loadUpdateChannel() {
        try {
            File file = new File(gameDirectory, "impulse/standalone/settings.json");
            if (!file.isFile()) return "stable";
            JsonObject json = new JsonParser().parse(Files.readString(file.toPath(), StandardCharsets.UTF_8)).getAsJsonObject();
            return "beta".equalsIgnoreCase(string(json, "update_channel")) ? "beta" : "stable";
        } catch (Exception ignored) { return "stable"; }
    }

    private int loadOnboardingVersion() {
        JsonObject settings = loadStandaloneSettings();
        try { return settings.has("onboarding_version") ? Math.max(0, settings.get("onboarding_version").getAsInt()) : 0; }
        catch (Exception ignored) { return 0; }
    }

    private void setOnboardingVersion(int version) throws IOException {
        JsonObject settings = loadStandaloneSettings();
        settings.addProperty("onboarding_version", Math.max(0, version));
        writeJsonAtomic(standaloneSettingsFile(), settings);
    }

    private List<String> dismissedUpdateIds() {
        JsonObject settings = loadStandaloneSettings();
        List<String> ids = new ArrayList<String>();
        if (!settings.has("dismissed_update_ids") || !settings.get("dismissed_update_ids").isJsonArray()) return ids;
        for (JsonElement item : settings.getAsJsonArray("dismissed_update_ids")) {
            if (item.isJsonPrimitive()) {
                String id = item.getAsString().trim();
                if (!id.isEmpty() && !ids.contains(id)) ids.add(id);
            }
        }
        return ids;
    }

    private void dismissUpdate(String id) throws IOException {
        boolean known = updateRegistry != null && updateRegistry.publications != null
            && updateRegistry.publications.stream().anyMatch(publication -> id.equals(publication.id));
        if (!known) throw new IOException("This update publication is no longer available.");
        JsonObject settings = loadStandaloneSettings();
        List<String> ids = dismissedUpdateIds();
        if (!ids.contains(id)) ids.add(id);
        ids.sort(String::compareTo);
        settings.add("dismissed_update_ids", GSON.toJsonTree(ids));
        writeJsonAtomic(standaloneSettingsFile(), settings);
    }

    private File standaloneSettingsFile() {
        return new File(gameDirectory, "impulse/standalone/settings.json");
    }

    private JsonObject loadStandaloneSettings() {
        try {
            File file = standaloneSettingsFile();
            if (!file.isFile()) return new JsonObject();
            JsonElement parsed = new JsonParser().parse(Files.readString(file.toPath(), StandardCharsets.UTF_8));
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : new JsonObject();
        } catch (Exception ignored) { return new JsonObject(); }
    }

    private void setUpdateChannel(String channel) throws IOException {
        String normalized = "beta".equalsIgnoreCase(channel) ? "beta" : "stable";
        JsonObject settings = loadStandaloneSettings();
        settings.addProperty("update_channel", normalized);
        writeJsonAtomic(standaloneSettingsFile(), settings);
    }

    private File updatesCacheFile() {
        return new File(gameDirectory, "impulse/standalone/ui/cache/standalone-updates.json");
    }

    private File updatesEtagFile() {
        return new File(gameDirectory, "impulse/standalone/ui/cache/standalone-updates.etag");
    }

    private UpdateRegistry loadCachedUpdates() {
        try {
            File cache = updatesCacheFile();
            if (!cache.isFile()) return new UpdateRegistry();
            return parseUpdateRegistry(Files.readString(cache.toPath(), StandardCharsets.UTF_8));
        } catch (Exception error) {
            System.err.println("[Impulse UI] Ignoring invalid cached standalone updates: " + error.getMessage());
            return new UpdateRegistry();
        }
    }

    private void refreshUpdates() {
        HttpURLConnection connection = null;
        try {
            String configured = System.getProperty("impulse.updates.api", UPDATES_URL).trim();
            URI uri = URI.create(configured);
            boolean local = "http".equalsIgnoreCase(uri.getScheme()) && ("127.0.0.1".equals(uri.getHost()) || "localhost".equalsIgnoreCase(uri.getHost()));
            if (!"https".equalsIgnoreCase(uri.getScheme()) && !local) throw new IOException("Standalone updates must use HTTPS.");
            connection = (HttpURLConnection) uri.toURL().openConnection();
            connection.setConnectTimeout(4000);
            connection.setReadTimeout(6000);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "Impulse-Standalone/" + clean(request.impulse_version, "unknown"));
            File etagFile = updatesEtagFile();
            if (etagFile.isFile()) connection.setRequestProperty("If-None-Match", Files.readString(etagFile.toPath(), StandardCharsets.UTF_8).trim());
            int status = connection.getResponseCode();
            if (status == HttpURLConnection.HTTP_NOT_MODIFIED) return;
            if (status != HttpURLConnection.HTTP_OK) throw new IOException("Standalone updates returned HTTP " + status + ".");
            String body;
            try (InputStream input = connection.getInputStream()) { body = new String(readLimited(input, MAX_UPDATES_BYTES), StandardCharsets.UTF_8); }
            UpdateRegistry parsed = parseUpdateRegistry(body);
            writeJsonAtomic(updatesCacheFile(), parsed);
            String etag = clean(connection.getHeaderField("ETag"), "");
            if (!etag.isEmpty()) {
                File parent = updatesEtagFile().getParentFile();
                if (!parent.exists()) parent.mkdirs();
                Files.writeString(updatesEtagFile().toPath(), etag, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            }
            updateRegistry = parsed;
        } catch (Exception error) {
            System.err.println("[Impulse UI] Could not refresh standalone updates; using cache: " + error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private UpdateRegistry parseUpdateRegistry(String body) throws IOException {
        UpdateRegistry registry;
        try { registry = GSON.fromJson(body, UpdateRegistry.class); }
        catch (Exception error) { throw new IOException("Invalid standalone updates JSON.", error); }
        if (registry == null || registry.schema_version != 1 || registry.publications == null) throw new IOException("Unsupported standalone updates registry.");
        Set<String> ids = new HashSet<String>();
        for (UpdatePublication publication : registry.publications) {
            if (publication == null || !publication.valid() || !ids.add(publication.id)) throw new IOException("Invalid standalone update publication.");
        }
        registry.publications.sort((left, right) -> Long.compare(parseTime(right.published_at), parseTime(left.published_at)));
        return registry;
    }

    private static long parseTime(String value) {
        try { return Instant.parse(value).toEpochMilli(); }
        catch (Exception ignored) { return 0L; }
    }

    private void writeJsonAtomic(File target, Object value) throws IOException {
        File parent = target.getParentFile();
        if (!parent.exists() && !parent.mkdirs()) throw new IOException("Could not create " + parent);
        File temporary = new File(parent, target.getName() + ".tmp");
        Files.writeString(temporary.toPath(), GSON.toJson(value), StandardCharsets.UTF_8,
            StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        try { Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
        catch (Exception ignored) { Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING); }
    }

    private void writeSignal(String name) throws IOException {
        Files.writeString(new File(sessionDirectory, name).toPath(), Long.toString(System.currentTimeMillis()),
            StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
    }

    private void writeResult(String status, String profileId, Throwable error) {
        try {
            ImpulseStandaloneBootstrap.UiResult result = new ImpulseStandaloneBootstrap.UiResult();
            result.status = status;
            result.profile_id = profileId;
            result.error = error == null ? null : clean(error.getMessage(), error.getClass().getSimpleName());
            writeJsonAtomic(new File(sessionDirectory, "result.json"), result);
        } catch (Exception writeError) {
            System.err.println("[Impulse UI] Could not write selector result: " + writeError.getMessage());
        }
    }

    private void closeWindow() {
        Webview current = webview;
        if (current == null) return;
        try {
            if (webviewRunning) current.dispatch(current::close);
            else current.close();
        } catch (Throwable error) {
            System.err.println("[Impulse UI] Could not close the native WebView cleanly: " + error.getMessage());
        }
    }

    private static void writeFailure(ImpulseStandaloneBootstrap.UiRequest request, Throwable error) {
        try {
            ImpulseStandaloneBootstrap.UiResult result = new ImpulseStandaloneBootstrap.UiResult();
            result.status = hasCurrentLegalAcceptance(new File(request.game_directory)) ? "error" : "quit";
            result.error = clean(error.getMessage(), error.getClass().getSimpleName());
            Files.writeString(new File(request.session_directory, "result.json").toPath(), GSON.toJson(result), StandardCharsets.UTF_8);
        } catch (Exception ignored) { }
    }

    private static boolean hasCurrentLegalAcceptance(File gameDirectory) {
        try {
            File file = new File(gameDirectory, "impulse/standalone/legal.json");
            if (!file.isFile()) return false;
            JsonObject json = new JsonParser().parse(Files.readString(file.toPath(), StandardCharsets.UTF_8)).getAsJsonObject();
            return ImpulseStandaloneBootstrap.LEGAL_DOCUMENT_VERSION.equals(string(json, "version"));
        } catch (Exception ignored) { return false; }
    }

    private static byte[] readLimited(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int total = 0;
        int count;
        while ((count = input.read(buffer)) >= 0) {
            total += count;
            if (total > limit) throw new IOException("The response is too large.");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static String required(JsonObject json, String key) throws IOException {
        String value = string(json, key);
        if (value.isEmpty()) throw new IOException("Missing field: " + key);
        return value;
    }

    private static String string(JsonObject json, String key) {
        if (json == null || !json.has(key) || json.get(key).isJsonNull()) return "";
        try { return json.get(key).getAsString(); }
        catch (Exception ignored) { return ""; }
    }

    private static boolean bool(JsonObject json, String key) {
        try { return json.has(key) && json.get(key).getAsBoolean(); }
        catch (Exception ignored) { return false; }
    }

    private static List<String> strings(JsonObject json, String key) {
        List<String> values = new ArrayList<String>();
        if (json == null || !json.has(key) || !json.get(key).isJsonArray()) return values;
        for (JsonElement item : json.getAsJsonArray(key)) if (!item.isJsonNull()) values.add(item.getAsString());
        return values;
    }

    private static String clean(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }

    private static final class UpdateRegistry {
        int schema_version = 1;
        List<UpdatePublication> publications = new ArrayList<UpdatePublication>();
    }

    private static final class UpdatePublication {
        String id;
        String title;
        String subtitle;
        List<String> versions;
        String published_at;
        String hero_image_url;
        List<UpdateSection> sections;

        boolean valid() {
            if (!clean(id, "").matches("[a-z0-9][a-z0-9-]{0,79}")) return false;
            if (clean(title, "").isEmpty() || clean(title, "").length() > 120) return false;
            if (clean(subtitle, "").isEmpty() || clean(subtitle, "").length() > 240) return false;
            if (versions == null || versions.isEmpty() || versions.size() > 100) return false;
            for (String version : versions) if (!clean(version, "").matches("\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?")) return false;
            if (parseTime(published_at) <= 0L || sections == null || sections.isEmpty() || sections.size() > 8) return false;
            if (hero_image_url != null && !hero_image_url.trim().isEmpty()) {
                try { if (!"https".equalsIgnoreCase(URI.create(hero_image_url).getScheme())) return false; }
                catch (Exception ignored) { return false; }
            }
            for (UpdateSection section : sections) if (section == null || !section.valid()) return false;
            return true;
        }
    }

    private static final class UpdateSection {
        String icon;
        String title;
        String body;

        boolean valid() {
            return UPDATE_ICONS.contains(clean(icon, ""))
                && !clean(title, "").isEmpty() && clean(title, "").length() <= 100
                && !clean(body, "").isEmpty() && clean(body, "").length() <= 500;
        }
    }

    private static final class Operation {
        final String id;
        final String kind;
        volatile String status = "running";
        volatile String message = "Starting";
        volatile int completed;
        volatile int total = 1;
        volatile Object result;
        volatile String error;
        volatile boolean cancelRequested;
        transient volatile Future<?> future;

        Operation(String id, String kind) { this.id = id; this.kind = kind; }
        void update(String message, int completed, int total) {
            if (cancelRequested) return;
            this.message = clean(message, "Working");
            this.completed = Math.max(0, completed);
            this.total = Math.max(1, total);
        }
        void attach(Future<?> future) {
            this.future = future;
            if (cancelRequested) future.cancel(true);
        }
        void cancel() {
            if (!"running".equals(status)) return;
            cancelRequested = true;
            message = "Cancelling";
            Future<?> active = future;
            if (active != null) active.cancel(true);
            status = "cancelled";
        }
        void cancelled() { cancelRequested = true; status = "cancelled"; message = "Cancelled"; }
        void done(Object result) { if (!cancelRequested) { this.result = result; this.status = "done"; } }
        void fail(Throwable error) { if (!cancelRequested) { this.error = clean(error.getMessage(), error.getClass().getSimpleName()); this.status = "error"; } }
    }

    private static final class ImageJob {
        volatile String status = "loading";
        volatile String data;
        volatile String error;
    }

    private interface WindowsUser32 extends Library {
        WindowsUser32 INSTANCE = Native.load("user32", WindowsUser32.class);
        boolean SetProcessDpiAwarenessContext(Pointer context);
        boolean SetProcessDPIAware();
    }

    private interface WindowsShcore extends Library {
        WindowsShcore INSTANCE = Native.load("shcore", WindowsShcore.class);
        int SetProcessDpiAwareness(int awareness);
    }
}
