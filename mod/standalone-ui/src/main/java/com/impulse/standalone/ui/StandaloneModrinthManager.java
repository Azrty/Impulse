package com.impulse.standalone.ui;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.impulse.bootstrap.ImpulseStandaloneBootstrap;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

/** Modrinth-backed custom mod manager used by the standalone helper process. */
public final class StandaloneModrinthManager {
    private static final String API = "https://api.modrinth.com/v2";
    private static final String USER_AGENT = "Azrty/Impulse-Standalone (https://impulsemc.com)";
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Set<Integer> RETRYABLE = new HashSet<Integer>(Arrays.asList(408, 429, 500, 502, 503, 504, 521, 522, 524));

    private final File gameDirectory;
    private final ImpulseStandaloneBootstrap.Profile profile;
    private final String minecraftVersion;
    private final String loader;

    public StandaloneModrinthManager(File gameDirectory, ImpulseStandaloneBootstrap.Profile profile,
                                     String minecraftVersion, String loader) {
        this.gameDirectory = gameDirectory;
        this.profile = profile;
        this.minecraftVersion = minecraftVersion;
        this.loader = loader == null ? "neoforge" : loader.toLowerCase(Locale.ROOT);
    }

    public ImpulseStandaloneBootstrap.CustomModState state() {
        return ImpulseStandaloneBootstrap.loadCustomModState(gameDirectory, profile.id);
    }

    public List<SearchProject> search(String query) throws IOException {
        String facets = "[[\"project_type:mod\"],[\"categories:" + jsonEscape(loader) + "\"],[\"versions:"
            + jsonEscape(minecraftVersion) + "\"],[\"client_side!=unsupported\"]]";
        JsonObject response = getObject("/search?query=" + encode(query) + "&facets=" + encode(facets) + "&limit=40&index=relevance");
        List<SearchProject> results = new ArrayList<SearchProject>();
        JsonArray hits = array(response, "hits");
        for (JsonElement element : hits) {
            if (!element.isJsonObject()) continue;
            JsonObject hit = element.getAsJsonObject();
            SearchProject project = new SearchProject();
            project.project_id = string(hit, "project_id");
            project.slug = string(hit, "slug");
            project.title = string(hit, "title");
            project.description = string(hit, "description");
            project.author = string(hit, "author");
            project.icon_url = string(hit, "icon_url");
            project.featured_gallery = string(hit, "featured_gallery");
            project.client_side = string(hit, "client_side");
            project.server_side = string(hit, "server_side");
            project.categories = strings(array(hit, "categories"));
            project.downloads = number(hit, "downloads");
            if (!project.project_id.isEmpty() && !"unsupported".equals(project.client_side)) results.add(project);
        }
        return results;
    }

    public ProjectDetails project(String projectId) throws IOException {
        JsonObject json = getObject("/project/" + encodePath(projectId));
        ProjectDetails project = new ProjectDetails();
        project.project_id = string(json, "id");
        project.slug = string(json, "slug");
        project.title = string(json, "title");
        project.description = string(json, "description");
        project.body = string(json, "body");
        project.icon_url = string(json, "icon_url");
        project.featured_gallery = string(json, "featured_gallery");
        project.client_side = string(json, "client_side");
        project.server_side = string(json, "server_side");
        project.source_url = string(json, "source_url");
        project.issues_url = string(json, "issues_url");
        project.wiki_url = string(json, "wiki_url");
        project.discord_url = string(json, "discord_url");
        project.team_id = string(json, "team");
        project.categories = strings(array(json, "categories"));
        project.game_versions = strings(array(json, "game_versions"));
        project.loaders = strings(array(json, "loaders"));
        if (json.has("license") && json.get("license").isJsonObject()) {
            JsonObject license = json.getAsJsonObject("license");
            project.license_id = string(license, "id");
            project.license_name = string(license, "name");
            project.license_url = string(license, "url");
        }
        for (JsonElement element : array(json, "gallery")) {
            if (!element.isJsonObject()) continue;
            JsonObject source = element.getAsJsonObject();
            GalleryImage image = new GalleryImage();
            image.url = string(source, "url");
            image.title = string(source, "title");
            image.description = string(source, "description");
            image.featured = bool(source, "featured");
            image.ordering = (int) number(source, "ordering");
            if (!empty(image.url)) project.gallery.add(image);
        }
        project.gallery.sort(Comparator.comparingInt((GalleryImage image) -> image.ordering)
            .thenComparing(image -> image.title == null ? "" : image.title, String.CASE_INSENSITIVE_ORDER));
        if (empty(project.featured_gallery)) {
            for (GalleryImage image : project.gallery) if (image.featured) {
                project.featured_gallery = image.url;
                break;
            }
        }
        if (empty(project.featured_gallery) && !project.gallery.isEmpty()) project.featured_gallery = project.gallery.get(0).url;
        try {
            for (JsonElement element : getArray("/project/" + encodePath(projectId) + "/members")) {
                if (!element.isJsonObject()) continue;
                JsonObject member = element.getAsJsonObject();
                if (!member.has("user") || !member.get("user").isJsonObject()) continue;
                JsonObject user = member.getAsJsonObject("user");
                String author = string(user, "name");
                if (empty(author)) author = string(user, "username");
                if (!empty(author) && !project.authors.contains(author)) project.authors.add(author);
                TeamMember teamMember = new TeamMember();
                teamMember.username = string(user, "username");
                teamMember.name = author;
                teamMember.role = string(member, "role");
                project.team.add(teamMember);
            }
        } catch (IOException ignored) {
        }
        project.downloads = number(json, "downloads");
        return project;
    }

    public List<ProjectVersion> versions(String projectId, Channel channel) throws IOException {
        JsonArray json = getArray("/project/" + encodePath(projectId) + "/version?game_versions="
            + encode("[\"" + jsonEscape(minecraftVersion) + "\"]") + "&loaders="
            + encode("[\"" + jsonEscape(loader) + "\"]") + "&include_changelog=true");
        List<ProjectVersion> versions = new ArrayList<ProjectVersion>();
        for (JsonElement element : json) {
            if (!element.isJsonObject()) continue;
            ProjectVersion version = parseVersion(element.getAsJsonObject());
            if (channel.accepts(version.version_type) && compatible(version)) versions.add(version);
        }
        versions.sort(Comparator.comparing((ProjectVersion value) -> value.date_published == null ? "" : value.date_published).reversed());
        return versions;
    }

    public InstallPlan plan(String projectId, String versionId, Channel channel) throws IOException {
        InstallPlan plan = new InstallPlan();
        plan.channel = channel;
        resolve(projectId, versionId, true, null, channel, plan, new LinkedHashSet<String>());
        return plan;
    }

    public void install(InstallPlan original, Set<String> selectedOptionalProjects, InstallLocation location,
                        ProgressListener listener) throws Exception {
        InstallPlan plan = original.copy();
        for (OptionalDependency optional : original.optional_dependencies) {
            if (!selectedOptionalProjects.contains(optional.project_id)) continue;
            List<ProjectVersion> versions = versions(optional.project_id, original.channel);
            if (versions.isEmpty() && original.channel != Channel.ALL) versions = versions(optional.project_id, Channel.ALL);
            if (versions.isEmpty()) throw new IOException("No compatible version was found for optional dependency " + optional.name + ".");
            resolve(optional.project_id, versions.get(0).id, true, null, original.channel, plan, new LinkedHashSet<String>());
        }
        if (plan.items.isEmpty()) throw new IOException("The installation plan is empty.");

        File installDirectory = directoryFor(location);
        if (!installDirectory.exists() && !installDirectory.mkdirs()) throw new IOException("Could not create " + installDirectory);
        File staging = new File(ImpulseStandaloneBootstrap.profileDirectory(gameDirectory, profile.id), ".custom_mods_stage");
        deleteTree(staging);
        if (!staging.mkdirs()) throw new IOException("Could not create custom mod staging directory.");

        AtomicInteger completed = new AtomicInteger();
        ExecutorService pool = Executors.newFixedThreadPool(4);
        List<Future<File>> futures = new ArrayList<Future<File>>();
        try {
            for (PlanItem item : plan.items.values()) {
                futures.add(pool.submit(new Callable<File>() {
                    public File call() throws Exception {
                        File target = new File(staging, safeFileName(item.file.filename));
                        listener.update("Downloading " + item.project.title, completed.get(), plan.items.size());
                        downloadWithRetries(item.file, target);
                        int done = completed.incrementAndGet();
                        listener.update("Downloaded " + item.project.title, done, plan.items.size());
                        return target;
                    }
                }));
            }
            for (Future<File> future : futures) {
                try { future.get(); }
                catch (ExecutionException error) {
                    Throwable cause = error.getCause();
                    if (cause instanceof Exception) throw (Exception) cause;
                    throw new IOException("Custom mod download failed.", cause);
                }
            }

            listener.update("Checking mod compatibility", 0, plan.items.size());
            validateCollisions(plan, staging, location);
            commit(plan, staging, location, listener);
        } finally {
            pool.shutdownNow();
            deleteTree(staging);
        }
    }

    public void remove(String projectId) throws IOException {
        ImpulseStandaloneBootstrap.CustomModState state = state();
        Map<String, ImpulseStandaloneBootstrap.CustomModEntry> entries = byProject(state);
        ImpulseStandaloneBootstrap.CustomModEntry root = entries.get(projectId);
        if (root == null) throw new IOException("This custom mod is no longer installed.");
        root.explicit = false;
        removeOwner(entries, projectId);

        boolean changed;
        do {
            changed = false;
            for (ImpulseStandaloneBootstrap.CustomModEntry entry : new ArrayList<ImpulseStandaloneBootstrap.CustomModEntry>(entries.values())) {
                if (entry.explicit || (entry.required_by != null && !entry.required_by.isEmpty())) continue;
                entries.remove(entry.project_id);
                removeOwner(entries, entry.project_id);
                deleteOwnedFile(entry);
                changed = true;
            }
        } while (changed);
        state.mods = new ArrayList<ImpulseStandaloneBootstrap.CustomModEntry>(entries.values());
        state.updated_at = System.currentTimeMillis();
        ImpulseStandaloneBootstrap.saveCustomModState(gameDirectory, profile.id, state);
    }

    public void repair(String projectId, ProgressListener listener) throws Exception {
        ImpulseStandaloneBootstrap.CustomModEntry installed = byProject(state()).get(projectId);
        if (installed == null) throw new IOException("This custom mod is no longer installed.");
        InstallPlan plan = plan(projectId, installed.version_id, Channel.from(installed.channel));
        install(plan, Collections.<String>emptySet(), InstallLocation.from(installed.location), listener);
    }

    public ImpulseStandaloneBootstrap.CustomModState checkUpdates() throws IOException {
        ImpulseStandaloneBootstrap.CustomModState state = state();
        for (ImpulseStandaloneBootstrap.CustomModEntry entry : state.mods) {
            if (entry == null) continue;
            entry.update_version_id = null;
            entry.update_version_number = null;
            if (!entry.explicit || empty(entry.project_id)) continue;
            try {
                List<ProjectVersion> candidates = versions(entry.project_id, Channel.from(entry.channel));
                if (!candidates.isEmpty() && !candidates.get(0).id.equals(entry.version_id)) {
                    entry.update_version_id = candidates.get(0).id;
                    entry.update_version_number = candidates.get(0).version_number;
                }
            } catch (IOException error) {
                entry.status_message = "Update check failed: " + error.getMessage();
            }
        }
        state.updated_at = System.currentTimeMillis();
        ImpulseStandaloneBootstrap.saveCustomModState(gameDirectory, profile.id, state);
        return state;
    }

    public List<GlobalModInfo> globalMods() {
        List<GlobalModInfo> results = new ArrayList<GlobalModInfo>();
        Map<String, ImpulseStandaloneBootstrap.CustomModEntry> managedByHash = new HashMap<String, ImpulseStandaloneBootstrap.CustomModEntry>();
        for (ImpulseStandaloneBootstrap.CustomModEntry entry : state().mods) {
            if (entry != null && InstallLocation.from(entry.location) == InstallLocation.GLOBAL && !empty(entry.sha1)) {
                managedByHash.put(entry.sha1.toLowerCase(Locale.ROOT), entry);
            }
        }
        Map<String, String> serverIds = new HashMap<String, String>();
        collectIds(new File(ImpulseStandaloneBootstrap.profileDirectory(gameDirectory, profile.id), "mods"), serverIds, Collections.<String>emptySet());
        Map<String, GlobalModInfo> globalIds = new HashMap<String, GlobalModInfo>();
        File[] files = ImpulseStandaloneBootstrap.globalModsDirectory(gameDirectory).listFiles();
        if (files == null) return results;
        Arrays.sort(files, Comparator.comparing(File::getName, String.CASE_INSENSITIVE_ORDER));
        for (File file : files) {
            if (!file.isFile() || !file.getName().toLowerCase(Locale.ROOT).endsWith(".jar")
                || ImpulseStandaloneBootstrap.isImpulseJar(file)) continue;
            GlobalModInfo info = new GlobalModInfo();
            info.file_name = file.getName();
            info.size = file.length();
            info.name = file.getName();
            info.compatibility = "unknown";
            try {
                info.sha1 = ImpulseStandaloneBootstrap.sha1(file);
                info.mod_ids.addAll(ImpulseStandaloneBootstrap.readModIds(file));
                ImpulseStandaloneBootstrap.CustomModEntry managed = managedByHash.get(info.sha1.toLowerCase(Locale.ROOT));
                if (managed != null) {
                    info.managed = true;
                    info.name = managed.name;
                    info.version_number = managed.version_number;
                    info.project_id = managed.project_id;
                }
                for (String id : info.mod_ids) {
                    String conflict = serverIds.get(normalize(id));
                    if (conflict != null) {
                        info.compatibility = "incompatible";
                        info.reason = "Already provided by server mod " + conflict + ".";
                        break;
                    }
                }
                if (!"incompatible".equals(info.compatibility)) {
                    ProjectVersion version = versionFromHash(info.sha1);
                    if (version != null) {
                        info.project_id = version.project_id;
                        info.version_number = version.version_number;
                        try {
                            ProjectDetails details = project(version.project_id);
                            info.name = details.title;
                            info.icon_url = details.icon_url;
                            info.author = details.authors.isEmpty() ? "Modrinth" : String.join(", ", details.authors);
                        } catch (Exception ignored) { }
                        if (compatible(version)) info.compatibility = "compatible";
                        else {
                            info.compatibility = "incompatible";
                            info.reason = "This file does not support NeoForge " + minecraftVersion + ".";
                        }
                    } else {
                        info.reason = "Not identified on Modrinth; compatibility could not be confirmed.";
                    }
                }
            } catch (Exception error) {
                info.reason = "Compatibility check failed: " + error.getMessage();
            }
            for (String id : info.mod_ids) {
                String normalized = normalize(id);
                GlobalModInfo other = globalIds.get(normalized);
                if (other != null) {
                    info.compatibility = "incompatible";
                    other.compatibility = "incompatible";
                    info.reason = "Duplicates mod ID " + id + " from " + other.file_name + ".";
                    other.reason = "Duplicates mod ID " + id + " from " + info.file_name + ".";
                } else globalIds.put(normalized, info);
            }
            results.add(info);
        }
        return results;
    }

    private ProjectVersion versionFromHash(String sha1) throws IOException {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(API + "/version_file/" + encodePath(sha1) + "?algorithm=sha1").openConnection();
            connection.setConnectTimeout(7000);
            connection.setReadTimeout(20000);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", USER_AGENT);
            int status = connection.getResponseCode();
            if (status == 404) return null;
            if (status != 200) throw new IOException("Modrinth returned HTTP " + status + ".");
            try (InputStream input = connection.getInputStream()) {
                JsonElement json = new JsonParser().parse(readAll(input, 4 * 1024 * 1024));
                if (!json.isJsonObject()) throw new IOException("Modrinth returned invalid file metadata.");
                return parseVersion(json.getAsJsonObject());
            }
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void resolve(String projectId, String versionId, boolean explicit, String requiredBy, Channel channel,
                         InstallPlan plan, Set<String> visiting) throws IOException {
        if (plan.items.containsKey(projectId)) {
            PlanItem existing = plan.items.get(projectId);
            existing.explicit |= explicit;
            if (requiredBy != null) existing.required_by.add(requiredBy);
            return;
        }
        if (!visiting.add(projectId)) throw new IOException("Modrinth dependency cycle detected at " + projectId + ".");
        ProjectVersion version = version(versionId);
        if (!compatible(version)) throw new IOException(version.name + " does not support NeoForge " + minecraftVersion + ".");
        ProjectDetails project = project(projectId);
        if ("unsupported".equals(project.client_side)) throw new IOException(project.title + " does not support Minecraft clients.");
        DownloadFile file = version.primaryFile();
        if (file == null) throw new IOException(version.name + " has no downloadable SHA-1 verified jar.");

        PlanItem item = new PlanItem();
        item.project = project;
        item.version = version;
        item.file = file;
        item.explicit = explicit;
        if (requiredBy != null) item.required_by.add(requiredBy);
        plan.items.put(projectId, item);

        for (Dependency dependency : version.dependencies) {
            if ("optional".equals(dependency.dependency_type) && !empty(dependency.project_id)) {
                OptionalDependency optional = new OptionalDependency();
                optional.project_id = dependency.project_id;
                try { optional.name = project(dependency.project_id).title; }
                catch (Exception ignored) { optional.name = dependency.project_id; }
                if (!plan.hasOptional(optional.project_id)) plan.optional_dependencies.add(optional);
                continue;
            }
            if (!"required".equals(dependency.dependency_type)) continue;
            String dependencyProject = dependency.project_id;
            String dependencyVersion = dependency.version_id;
            if (empty(dependencyProject) && !empty(dependencyVersion)) dependencyProject = version(dependencyVersion).project_id;
            if (empty(dependencyProject)) throw new IOException(project.title + " has a required dependency without a Modrinth project ID.");
            if (empty(dependencyVersion)) {
                List<ProjectVersion> candidates = versions(dependencyProject, channel);
                if (candidates.isEmpty() && channel != Channel.ALL) candidates = versions(dependencyProject, Channel.ALL);
                if (candidates.isEmpty()) throw new IOException("No compatible dependency was found for " + dependencyProject + ".");
                dependencyVersion = candidates.get(0).id;
            }
            resolve(dependencyProject, dependencyVersion, false, projectId, channel, plan, visiting);
        }
        visiting.remove(projectId);
    }

    private void validateCollisions(InstallPlan plan, File staging, InstallLocation location) throws IOException {
        Map<String, String> occupied = new HashMap<String, String>();
        Set<String> replacing = new HashSet<String>(plan.items.keySet());
        ImpulseStandaloneBootstrap.CustomModState state = state();
        Set<String> replacedGlobal = new HashSet<String>();
        Set<String> replacedProfile = new HashSet<String>();
        for (ImpulseStandaloneBootstrap.CustomModEntry entry : state.mods) {
            if (!replacing.contains(entry.project_id)) continue;
            String fileName = safeFileName(entry.file_name).toLowerCase(Locale.ROOT);
            if (InstallLocation.from(entry.location) == InstallLocation.GLOBAL) replacedGlobal.add(fileName);
            else replacedProfile.add(fileName);
        }
        collectIds(new File(gameDirectory, "mods"), occupied, replacedGlobal);
        collectIds(new File(ImpulseStandaloneBootstrap.profileDirectory(gameDirectory, profile.id), "mods"), occupied, Collections.<String>emptySet());
        collectIds(ImpulseStandaloneBootstrap.customModsDirectory(gameDirectory, profile.id), occupied, replacedProfile);

        Map<String, String> planned = new HashMap<String, String>();
        for (PlanItem item : plan.items.values()) {
            File jar = new File(staging, safeFileName(item.file.filename));
            Set<String> ids = ImpulseStandaloneBootstrap.readModIds(jar);
            if (ids.isEmpty()) throw new IOException("Could not read NeoForge mod metadata from " + item.file.filename + ".");
            item.mod_ids.addAll(ids);
            for (String id : ids) {
                String normalized = normalize(id);
                if (occupied.containsKey(normalized)) {
                    throw new IOException(item.project.title + " is already provided by " + occupied.get(normalized) + ". Remove that copy before installing it as a custom mod.");
                }
                if (planned.containsKey(normalized) && !planned.get(normalized).equals(item.project.project_id)) {
                    throw new IOException(item.project.title + " and " + planned.get(normalized) + " provide the same mod ID " + id + ".");
                }
                planned.put(normalized, item.project.title);
            }
        }
    }

    private void commit(InstallPlan plan, File staging, InstallLocation location, ProgressListener listener) throws IOException {
        ImpulseStandaloneBootstrap.CustomModState state = state();
        Map<String, ImpulseStandaloneBootstrap.CustomModEntry> entries = byProject(state);
        for (PlanItem item : plan.items.values()) {
            if (item.explicit) removeOwner(entries, item.project.project_id);
        }
        File backupDirectory = new File(staging, "backup");
        backupDirectory.mkdirs();
        List<FileMove> backups = new ArrayList<FileMove>();
        List<File> added = new ArrayList<File>();
        try {
            int index = 0;
            for (PlanItem item : plan.items.values()) {
                listener.update("Installing " + item.project.title, index++, plan.items.size());
                ImpulseStandaloneBootstrap.CustomModEntry previous = entries.get(item.project.project_id);
                if (previous != null) {
                    File old = new File(directoryFor(InstallLocation.from(previous.location)), safeFileName(previous.file_name));
                    if (old.isFile()) {
                        File backup = new File(backupDirectory, Integer.toHexString(item.project.project_id.hashCode()) + "-" + old.getName());
                        move(old, backup);
                        backups.add(new FileMove(backup, old));
                    }
                }
                File source = new File(staging, safeFileName(item.file.filename));
                File target = new File(directoryFor(location), safeFileName(item.file.filename));
                move(source, target);
                added.add(target);

                ImpulseStandaloneBootstrap.CustomModEntry entry = new ImpulseStandaloneBootstrap.CustomModEntry();
                entry.project_id = item.project.project_id;
                entry.version_id = item.version.id;
                entry.name = item.project.title;
                entry.description = item.project.description;
                entry.version_number = item.version.version_number;
                entry.file_name = item.file.filename;
                entry.download_url = item.file.url;
                entry.sha1 = item.file.sha1;
                entry.size = item.file.size;
                entry.mod_ids = new ArrayList<String>(item.mod_ids);
                entry.explicit = item.explicit || (previous != null && previous.explicit);
                entry.required_by = new ArrayList<String>(item.required_by);
                if (previous != null && previous.required_by != null) for (String owner : previous.required_by) if (!entry.required_by.contains(owner)) entry.required_by.add(owner);
                entry.channel = plan.channel.id;
                entry.status = "ready";
                entry.location = location.id;
                entries.put(entry.project_id, entry);
            }
            boolean pruned;
            do {
                pruned = false;
                for (ImpulseStandaloneBootstrap.CustomModEntry entry : new ArrayList<ImpulseStandaloneBootstrap.CustomModEntry>(entries.values())) {
                    if (entry.explicit || (entry.required_by != null && !entry.required_by.isEmpty())) continue;
                    entries.remove(entry.project_id);
                    removeOwner(entries, entry.project_id);
                    File orphan = new File(directoryFor(InstallLocation.from(entry.location)), safeFileName(entry.file_name));
                    if (orphan.isFile() && (empty(entry.sha1) || entry.sha1.equalsIgnoreCase(ImpulseStandaloneBootstrap.sha1(orphan)))) {
                        File backup = new File(backupDirectory, Integer.toHexString(entry.project_id.hashCode()) + "-orphan-" + orphan.getName());
                        move(orphan, backup);
                        backups.add(new FileMove(backup, orphan));
                    }
                    pruned = true;
                }
            } while (pruned);
            state.mods = new ArrayList<ImpulseStandaloneBootstrap.CustomModEntry>(entries.values());
            state.updated_at = System.currentTimeMillis();
            ImpulseStandaloneBootstrap.saveCustomModState(gameDirectory, profile.id, state);
            for (FileMove backup : backups) Files.deleteIfExists(backup.from.toPath());
            listener.update("Custom mods installed", plan.items.size(), plan.items.size());
        } catch (IOException error) {
            for (File file : added) Files.deleteIfExists(file.toPath());
            Collections.reverse(backups);
            for (FileMove backup : backups) if (backup.from.isFile()) move(backup.from, backup.to);
            throw error;
        }
    }

    private void downloadWithRetries(DownloadFile file, File target) throws Exception {
        Exception last = null;
        long[] delays = { 500L, 1500L, 3000L };
        for (int attempt = 1; attempt <= 3; attempt++) {
            try {
                download(file.url, target, file.size);
                String actual = ImpulseStandaloneBootstrap.sha1(target);
                if (!file.sha1.equalsIgnoreCase(actual)) throw new IOException("SHA-1 mismatch for " + file.filename + ".");
                return;
            } catch (Exception error) {
                last = error;
                if (attempt < 3) Thread.sleep(delays[attempt - 1]);
            }
        }
        throw new IOException("Failed to download " + file.filename + " after 3 attempts: " + (last == null ? "unknown error" : last.getMessage()), last);
    }

    private void download(String rawUrl, File target, long expectedSize) throws IOException {
        URI uri;
        try { uri = URI.create(rawUrl); }
        catch (Exception error) { throw new IOException("Invalid Modrinth download URL.", error); }
        if (!"https".equalsIgnoreCase(uri.getScheme())) throw new IOException("Refusing a non-HTTPS Modrinth download.");
        File part = new File(target.getParentFile(), target.getName() + ".part");
        HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(60000);
        connection.setRequestProperty("User-Agent", USER_AGENT);
        int status = connection.getResponseCode();
        if (status != 200) {
            connection.disconnect();
            throw new IOException("HTTP " + status + " while downloading " + target.getName() + ".");
        }
        try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(part)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
        } finally { connection.disconnect(); }
        if (expectedSize > 0 && part.length() != expectedSize) throw new IOException("Incomplete download for " + target.getName() + ".");
        move(part, target);
    }

    private ProjectVersion version(String versionId) throws IOException {
        return parseVersion(getObject("/version/" + encodePath(versionId)));
    }

    private ProjectVersion parseVersion(JsonObject json) {
        ProjectVersion version = new ProjectVersion();
        version.id = string(json, "id");
        version.project_id = string(json, "project_id");
        version.name = string(json, "name");
        version.version_number = string(json, "version_number");
        version.version_type = string(json, "version_type");
        version.changelog = string(json, "changelog");
        version.date_published = string(json, "date_published");
        version.game_versions = strings(array(json, "game_versions"));
        version.loaders = strings(array(json, "loaders"));
        for (JsonElement element : array(json, "dependencies")) {
            if (!element.isJsonObject()) continue;
            Dependency dependency = new Dependency();
            dependency.project_id = string(element.getAsJsonObject(), "project_id");
            dependency.version_id = string(element.getAsJsonObject(), "version_id");
            dependency.dependency_type = string(element.getAsJsonObject(), "dependency_type");
            version.dependencies.add(dependency);
        }
        for (JsonElement element : array(json, "files")) {
            if (!element.isJsonObject()) continue;
            JsonObject source = element.getAsJsonObject();
            DownloadFile file = new DownloadFile();
            file.filename = string(source, "filename");
            file.url = string(source, "url");
            file.size = number(source, "size");
            file.primary = bool(source, "primary");
            file.sha1 = source.has("hashes") && source.get("hashes").isJsonObject() ? string(source.getAsJsonObject("hashes"), "sha1") : "";
            if (!empty(file.filename) && !empty(file.url) && !empty(file.sha1)) version.files.add(file);
        }
        return version;
    }

    private boolean compatible(ProjectVersion version) {
        return version.game_versions.contains(minecraftVersion) && version.loaders.contains(loader);
    }

    private JsonObject getObject(String path) throws IOException {
        JsonElement element = request(path);
        if (!element.isJsonObject()) throw new IOException("Modrinth returned an invalid object.");
        return element.getAsJsonObject();
    }

    private JsonArray getArray(String path) throws IOException {
        JsonElement element = request(path);
        if (!element.isJsonArray()) throw new IOException("Modrinth returned an invalid list.");
        return element.getAsJsonArray();
    }

    private JsonElement request(String path) throws IOException {
        IOException last = null;
        long[] delays = { 500L, 1500L, 3000L };
        for (int attempt = 1; attempt <= 3; attempt++) {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(API + path).openConnection();
                connection.setConnectTimeout(7000);
                connection.setReadTimeout(20000);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("User-Agent", USER_AGENT);
                int status = connection.getResponseCode();
                if (status == 200) {
                    try (InputStream input = connection.getInputStream()) {
                        return new JsonParser().parse(readAll(input, 12 * 1024 * 1024));
                    }
                }
                if (!RETRYABLE.contains(status)) throw new IOException("Modrinth returned HTTP " + status + ".");
                last = new IOException(status == 429 ? "Modrinth rate limited this request." : "Modrinth returned HTTP " + status + ".");
                if (status == 429) {
                    long reset = parseLong(connection.getHeaderField("X-Ratelimit-Reset"));
                    if (reset > 0 && reset <= 10) delays[Math.min(attempt - 1, delays.length - 1)] = reset * 1000L;
                }
            } catch (IOException error) {
                last = error;
            } finally {
                if (connection != null) connection.disconnect();
            }
            if (attempt < 3) try { Thread.sleep(delays[attempt - 1]); } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IOException("Modrinth request was cancelled.", error);
            }
        }
        throw last == null ? new IOException("Modrinth is unavailable.") : last;
    }

    private void collectIds(File directory, Map<String, String> output, Set<String> excludedFiles) {
        File[] files = directory == null ? null : directory.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (!file.isFile() || !file.getName().toLowerCase(Locale.ROOT).endsWith(".jar")
                || excludedFiles.contains(file.getName().toLowerCase(Locale.ROOT))) continue;
            for (String id : ImpulseStandaloneBootstrap.readModIds(file)) output.put(normalize(id), file.getName());
        }
    }

    private Map<String, ImpulseStandaloneBootstrap.CustomModEntry> byProject(ImpulseStandaloneBootstrap.CustomModState state) {
        Map<String, ImpulseStandaloneBootstrap.CustomModEntry> entries = new LinkedHashMap<String, ImpulseStandaloneBootstrap.CustomModEntry>();
        for (ImpulseStandaloneBootstrap.CustomModEntry entry : state.mods) if (entry != null && !empty(entry.project_id)) entries.put(entry.project_id, entry);
        return entries;
    }

    private void removeOwner(Map<String, ImpulseStandaloneBootstrap.CustomModEntry> entries, String owner) {
        for (ImpulseStandaloneBootstrap.CustomModEntry entry : entries.values()) {
            if (entry.required_by != null) entry.required_by.removeIf(owner::equals);
        }
    }

    private void deleteOwnedFile(ImpulseStandaloneBootstrap.CustomModEntry entry) throws IOException {
        File file = new File(directoryFor(InstallLocation.from(entry.location)), safeFileName(entry.file_name));
        if (file.isFile() && (empty(entry.sha1) || entry.sha1.equalsIgnoreCase(ImpulseStandaloneBootstrap.sha1(file)))) Files.deleteIfExists(file.toPath());
    }

    private File directoryFor(InstallLocation location) {
        return location == InstallLocation.GLOBAL
            ? ImpulseStandaloneBootstrap.globalModsDirectory(gameDirectory)
            : ImpulseStandaloneBootstrap.customModsDirectory(gameDirectory, profile.id);
    }

    private static String readAll(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            if (output.size() + read > limit) throw new IOException("Modrinth response is too large.");
            output.write(buffer, 0, read);
        }
        return output.toString(StandardCharsets.UTF_8);
    }

    private static void move(File source, File target) throws IOException {
        File parent = target.getParentFile();
        if (!parent.exists() && !parent.mkdirs()) throw new IOException("Could not create " + parent);
        try { Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
        catch (Exception ignored) { Files.move(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING); }
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        try { Files.deleteIfExists(file.toPath()); } catch (Exception ignored) { }
    }

    private static String encode(String value) { return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8).replace("+", "%20"); }
    private static String encodePath(String value) { return encode(value).replace("%2F", "/"); }
    private static String safeFileName(String value) {
        String clean = value == null ? "mod.jar" : value.replace('\\', '/');
        clean = clean.substring(clean.lastIndexOf('/') + 1);
        return clean.isBlank() || clean.equals(".") || clean.equals("..") ? "mod.jar" : clean;
    }
    private static String normalize(String value) { return value == null ? "" : value.trim().toLowerCase(Locale.ROOT); }
    private static boolean empty(String value) { return value == null || value.isBlank(); }
    private static long parseLong(String value) { try { return Long.parseLong(value); } catch (Exception ignored) { return 0L; } }
    private static String jsonEscape(String value) { return (value == null ? "" : value).replace("\\", "\\\\").replace("\"", "\\\""); }
    private static String string(JsonObject object, String key) { try { return object.has(key) && !object.get(key).isJsonNull() ? object.get(key).getAsString() : ""; } catch (Exception ignored) { return ""; } }
    private static long number(JsonObject object, String key) { try { return object.has(key) ? object.get(key).getAsLong() : 0L; } catch (Exception ignored) { return 0L; } }
    private static boolean bool(JsonObject object, String key) { try { return object.has(key) && object.get(key).getAsBoolean(); } catch (Exception ignored) { return false; } }
    private static JsonArray array(JsonObject object, String key) { return object.has(key) && object.get(key).isJsonArray() ? object.getAsJsonArray(key) : new JsonArray(); }
    private static List<String> strings(JsonArray array) { List<String> result = new ArrayList<String>(); for (JsonElement value : array) try { result.add(value.getAsString()); } catch (Exception ignored) { } return result; }

    public interface ProgressListener { void update(String message, int completed, int total); }

    public enum Channel {
        RELEASE("release"), BETA("beta"), ALL("all");
        public final String id;
        Channel(String id) { this.id = id; }
        public boolean accepts(String type) { return this == ALL || this == BETA && !"alpha".equals(type) || this == RELEASE && "release".equals(type); }
        public static Channel from(String value) { for (Channel channel : values()) if (channel.id.equalsIgnoreCase(value)) return channel; return RELEASE; }
    }

    public enum InstallLocation {
        PROFILE("profile"), GLOBAL("global");
        public final String id;
        InstallLocation(String id) { this.id = id; }
        public static InstallLocation from(String value) {
            return "global".equalsIgnoreCase(value) ? GLOBAL : PROFILE;
        }
    }

    public static final class SearchProject {
        public String project_id, slug, title, description, author, icon_url, featured_gallery, client_side, server_side;
        public List<String> categories = new ArrayList<String>();
        public long downloads;
    }
    public static final class ProjectDetails {
        public String project_id, slug, title, description, body, icon_url, featured_gallery;
        public String client_side, server_side, source_url, issues_url, wiki_url, discord_url, team_id;
        public String license_id, license_name, license_url;
        public List<String> authors = new ArrayList<String>();
        public List<String> categories = new ArrayList<String>();
        public List<String> game_versions = new ArrayList<String>();
        public List<String> loaders = new ArrayList<String>();
        public List<GalleryImage> gallery = new ArrayList<GalleryImage>();
        public List<TeamMember> team = new ArrayList<TeamMember>();
        public long downloads;
    }
    public static final class TeamMember {
        public String username, name, role;
    }
    public static final class GalleryImage {
        public String url, title, description;
        public boolean featured;
        public int ordering;
    }
    public static final class ProjectVersion {
        public String id, project_id, name, version_number, version_type, changelog, date_published;
        public List<String> game_versions = new ArrayList<String>();
        public List<String> loaders = new ArrayList<String>();
        public List<Dependency> dependencies = new ArrayList<Dependency>();
        public List<DownloadFile> files = new ArrayList<DownloadFile>();
        public DownloadFile primaryFile() { for (DownloadFile file : files) if (file.primary) return file; return files.isEmpty() ? null : files.get(0); }
    }
    public static final class Dependency { public String project_id, version_id, dependency_type; }
    public static final class DownloadFile { public String filename, url, sha1; public long size; public boolean primary; }
    public static final class OptionalDependency { public String project_id, name; }
    public static final class GlobalModInfo {
        public String file_name, sha1, name, version_number, project_id, compatibility, reason, icon_url, author;
        public long size;
        public boolean managed;
        public Set<String> mod_ids = new LinkedHashSet<String>();
        public boolean incompatible() { return "incompatible".equals(compatibility); }
    }
    public static final class PlanItem {
        public ProjectDetails project;
        public ProjectVersion version;
        public DownloadFile file;
        public boolean explicit;
        public Set<String> required_by = new LinkedHashSet<String>();
        public Set<String> mod_ids = new LinkedHashSet<String>();
    }
    public static final class InstallPlan {
        public Channel channel = Channel.RELEASE;
        public LinkedHashMap<String, PlanItem> items = new LinkedHashMap<String, PlanItem>();
        public List<OptionalDependency> optional_dependencies = new ArrayList<OptionalDependency>();
        public boolean hasOptional(String id) { for (OptionalDependency dependency : optional_dependencies) if (dependency.project_id.equals(id)) return true; return false; }
        public InstallPlan copy() { InstallPlan copy = new InstallPlan(); copy.channel = channel; copy.items.putAll(items); copy.optional_dependencies.addAll(optional_dependencies); return copy; }
        public long totalSize() { long size = 0L; for (PlanItem item : items.values()) size += item.file.size; return size; }
    }
    private static final class FileMove { final File from, to; FileMove(File from, File to) { this.from = from; this.to = to; } }
}
