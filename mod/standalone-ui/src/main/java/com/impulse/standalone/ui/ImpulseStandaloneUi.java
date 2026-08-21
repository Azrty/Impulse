package com.impulse.standalone.ui;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.impulse.bootstrap.ImpulseStandaloneBootstrap;
import imgui.ImGui;
import imgui.ImDrawList;
import imgui.ImGuiStyle;
import imgui.ImVec2;
import imgui.app.Application;
import imgui.app.Configuration;
import imgui.app.WindowGlfw;
import imgui.flag.ImGuiCol;
import imgui.flag.ImGuiCond;
import imgui.flag.ImGuiKey;
import imgui.flag.ImGuiWindowFlags;
import imgui.type.ImBoolean;
import imgui.type.ImString;
import org.lwjgl.BufferUtils;
import org.lwjgl.glfw.GLFW;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL12;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.awt.Desktop;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Native standalone profile selector launched before NeoForge mod discovery. */
public final class ImpulseStandaloneUi extends Application {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Pattern MARKDOWN_LINK = Pattern.compile("\\[([^\\]\\r\\n]+)\\]\\((https://[^)\\s]+)\\)");
    private static ImpulseStandaloneBootstrap.UiRequest request;

    private final ImString address = new ImString(256);
    private final ImString modSearch = new ImString(256);
    private final ImBoolean privacyAccepted = new ImBoolean(false);
    private final ImBoolean termsAccepted = new ImBoolean(false);
    private final Set<String> selectedOptional = new LinkedHashSet<>();
    private final Set<String> selectedModrinthOptional = new LinkedHashSet<>();
    private ImpulseStandaloneBootstrap.Store store;
    private ImpulseStandaloneBootstrap.Profile selectedProfile;
    private ImpulseStandaloneBootstrap.Discovery discovery;
    private ImpulseStandaloneBootstrap.Manifest manifest;
    private volatile AsyncResult asyncResult;
    private volatile boolean busy;
    private boolean editorOpen;
    private boolean customModsOpen;
    private boolean completed;
    private boolean openRelationshipError;
    private boolean openDeleteConfirmation;
    private boolean openModVerificationWarning;
    private long modVerificationReadyAt;
    private List<ImpulseStandaloneBootstrap.ManifestMod> pendingUnverifiedMods = new ArrayList<>();
    private ImpulseStandaloneBootstrap.Profile pendingVerificationProfile;
    private ImpulseStandaloneBootstrap.Discovery pendingVerificationDiscovery;
    private String relationshipError = "";
    private String status = "Choose a profile or add an Impulse server.";
    private String deleteProfileId;
    private StandaloneModrinthManager modrinth;
    private ImpulseStandaloneBootstrap.CustomModState customModState = new ImpulseStandaloneBootstrap.CustomModState();
    private List<StandaloneModrinthManager.SearchProject> modSearchResults = new ArrayList<>();
    private StandaloneModrinthManager.SearchProject selectedModProject;
    private StandaloneModrinthManager.ProjectDetails selectedModDetails;
    private List<StandaloneModrinthManager.ProjectVersion> selectedModVersions = new ArrayList<>();
    private StandaloneModrinthManager.Channel modChannel = StandaloneModrinthManager.Channel.RELEASE;
    private StandaloneModrinthManager.InstallPlan pendingInstallPlan;
    private StandaloneModrinthManager.InstallLocation pendingInstallLocation = StandaloneModrinthManager.InstallLocation.PROFILE;
    private List<StandaloneModrinthManager.GlobalModInfo> globalMods = new ArrayList<>();
    private List<StandaloneModrinthManager.GlobalModInfo> incompatibleGlobalMods = new ArrayList<>();
    private final Map<String, StandaloneModrinthManager.ProjectDetails> projectCatalog = new LinkedHashMap<>();
    private ModsView modsView = ModsView.INSTALLED;
    private ModsView returnModsView = ModsView.INSTALLED;
    private float modListScroll;
    private boolean restoreModListScroll;
    private int galleryPage;
    private int lightboxIndex = -1;
    private boolean openGalleryLightbox;
    private String pendingLaunchProfileId;
    private volatile ModAsyncResult modAsyncResult;
    private volatile boolean modBusy;
    private volatile String modProgress = "";
    private volatile int modProgressCompleted;
    private volatile int modProgressTotal;
    private boolean openInstallConfirmation;
    private boolean openRemoveConfirmation;
    private boolean openIncompatibleWarning;
    private String removeCustomProjectId;
    private String changingCustomProjectId;
    private long lastHeartbeat;
    private int backgroundTexture;
    private int logoTexture;
    private AsyncImageCache imageCache;
    private boolean legalAccepted;
    private String updateChannel = "stable";

    public static void main(String[] args) {
        if (args.length != 1) System.exit(2);
        File requestFile = new File(args[0]);
        try {
            request = GSON.fromJson(Files.readString(requestFile.toPath(), StandardCharsets.UTF_8), ImpulseStandaloneBootstrap.UiRequest.class);
            if (request == null || request.game_directory == null || request.session_directory == null) {
                throw new IOException("Invalid Impulse selector request.");
            }
            System.out.println("[Impulse UI] Starting GLFW profile selector for " + request.loader + " " + request.loader_version);
            launch(new ImpulseStandaloneUi());
        } catch (Throwable error) {
            error.printStackTrace(System.out);
            writeEmergencyResult(requestFile, error);
            System.exit(2);
        }
    }

    @Override
    protected void configure(Configuration config) {
        config.setTitle("Impulse - Choose a server");
        config.setWidth(1040);
        config.setHeight(680);
    }

    @Override
    protected void initImGui(Configuration config) {
        super.initImGui(config);
        ImGui.getIO().setIniFilename(null);
        File font = systemFont();
        if (font != null) {
            try {
                ImGui.getIO().getFonts().addFontFromFileTTF(font.getAbsolutePath(), 17.0F);
            } catch (Throwable error) {
                System.out.println("[Impulse UI] Could not load system font: " + error.getMessage());
            }
        }
        applyStyle();
        File assets = new File(request.assets_directory == null ? "" : request.assets_directory);
        backgroundTexture = loadTexture(new File(assets, "background.jpg"));
        logoTexture = loadTexture(new File(assets, "logo.png"));
        imageCache = new AsyncImageCache(gameDirectory());
    }

    @Override
    protected void preRun() {
        if (getWindow() instanceof WindowGlfw window) {
            GLFW.glfwSetWindowSizeLimits(window.getHandle(), 760, 520, GLFW.GLFW_DONT_CARE, GLFW.GLFW_DONT_CARE);
        }
        reloadStore();
        legalAccepted = loadLegalAcceptance();
        updateChannel = loadUpdateChannel();
        if (store.profiles.isEmpty()) editorOpen = true;
        writeSignal("ready");
        writeSignal("heartbeat");
        lastHeartbeat = System.currentTimeMillis();
    }

    @Override
    public void process() {
        heartbeat();
        consumeAsyncResult();
        consumeModAsyncResult();
        if (imageCache != null) imageCache.pumpUploads();
        renderBackdrop();

        float width = ImGui.getIO().getDisplaySizeX();
        float height = ImGui.getIO().getDisplaySizeY();
        ImGui.setNextWindowPos(0, 0, ImGuiCond.Always);
        ImGui.setNextWindowSize(width, height, ImGuiCond.Always);
        int flags = ImGuiWindowFlags.NoTitleBar | ImGuiWindowFlags.NoResize | ImGuiWindowFlags.NoMove
            | ImGuiWindowFlags.NoCollapse | ImGuiWindowFlags.NoBringToFrontOnFocus;
        ImGui.pushStyleColor(ImGuiCol.WindowBg, 0.025F, 0.025F, 0.025F, 0.91F);
        if (ImGui.begin("##impulse-root", flags)) {
            if (!legalAccepted) {
                renderLegalAcknowledgement();
            } else {
                renderHeader();
                ImGui.separator();
                float contentHeight = Math.max(300.0F, ImGui.getContentRegionAvailY() - 46.0F);
                float sidebarWidth = Math.min(292.0F, Math.max(230.0F, width * 0.29F));
                renderSidebar(sidebarWidth, contentHeight);
                ImGui.sameLine();
                ImGui.beginChild("##content", 0, contentHeight, true);
                if (customModsOpen) renderCustomMods();
                else if (editorOpen) renderEditor();
                else renderProfileDetails();
                ImGui.endChild();
                renderStatus();
            }
        }
        ImGui.end();
        ImGui.popStyleColor();
        renderModals();
    }

    private void renderLegalAcknowledgement() {
        float available = ImGui.getContentRegionAvailX();
        float panelWidth = Math.min(620.0F, Math.max(420.0F, available - 80.0F));
        ImGui.setCursorPosX(Math.max(ImGui.getCursorPosX(), (available - panelWidth) / 2.0F));
        ImGui.beginChild("##legal-acknowledgement", panelWidth, 0, true);
        ImGui.setWindowFontScale(1.55F);
        ImGui.text("Before you continue");
        ImGui.setWindowFontScale(1.0F);
        ImGui.spacing();
        ImGui.textWrapped("To use Impulse Standalone, you must read and accept the Impulse Privacy Policy and Terms of Service.");
        ImGui.spacing();
        ImGui.textWrapped("These documents explain the rules for using Impulse and how its features and online services may process data. If you do not agree, you must quit Minecraft.");
        ImGui.spacing();
        ImGui.checkbox("I accept the Privacy Policy", privacyAccepted);
        ImGui.sameLine();
        if (outlineButton("Read##privacy", 76, 26)) openExternal(ImpulseStandaloneBootstrap.PRIVACY_POLICY_URL);
        ImGui.checkbox("I accept the Terms of Service", termsAccepted);
        ImGui.sameLine();
        if (outlineButton("Read##terms", 76, 26)) openExternal(ImpulseStandaloneBootstrap.TERMS_OF_SERVICE_URL);
        ImGui.spacing();
        ImGui.separator();
        ImGui.spacing();
        ImGui.beginDisabled(!privacyAccepted.get() || !termsAccepted.get());
        if (primaryButton("Accept and continue", 190, 36)) {
            if (saveLegalAcceptance()) legalAccepted = true;
        }
        ImGui.endDisabled();
        ImGui.sameLine();
        if (outlineButton("Quit Minecraft", 150, 36)) quitMinecraft();
        ImGui.endChild();
    }

    private boolean loadLegalAcceptance() {
        try {
            File file = legalAcceptanceFile();
            if (!file.isFile()) return false;
            Map<?, ?> value = GSON.fromJson(Files.readString(file.toPath(), StandardCharsets.UTF_8), Map.class);
            return value != null && ImpulseStandaloneBootstrap.LEGAL_DOCUMENT_VERSION.equals(String.valueOf(value.get("version")));
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean saveLegalAcceptance() {
        try {
            File target = legalAcceptanceFile();
            File parent = target.getParentFile();
            if (!parent.exists() && !parent.mkdirs()) throw new IOException("Could not create the Impulse standalone directory.");
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("version", ImpulseStandaloneBootstrap.LEGAL_DOCUMENT_VERSION);
            value.put("accepted_at", java.time.Instant.now().toString());
            File temporary = new File(parent, target.getName() + ".tmp");
            Files.writeString(temporary.toPath(), GSON.toJson(value), StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            try {
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (Exception ignored) {
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
            return true;
        } catch (Exception error) {
            status = "Could not save legal acceptance: " + clean(error.getMessage(), "Unknown error");
            return false;
        }
    }

    private File legalAcceptanceFile() {
        return new File(gameDirectory(), "impulse/standalone/legal.json");
    }

    private String loadUpdateChannel() {
        try {
            File file = standaloneSettingsFile();
            if (!file.isFile()) return "stable";
            Map<?, ?> value = GSON.fromJson(Files.readString(file.toPath(), StandardCharsets.UTF_8), Map.class);
            return value != null && "beta".equalsIgnoreCase(String.valueOf(value.get("update_channel"))) ? "beta" : "stable";
        } catch (Exception ignored) {
            return "stable";
        }
    }

    private void setUpdateChannel(String channel) {
        String normalized = "beta".equalsIgnoreCase(channel) ? "beta" : "stable";
        if (normalized.equals(updateChannel)) return;
        try {
            File target = standaloneSettingsFile();
            File parent = target.getParentFile();
            if (!parent.exists() && !parent.mkdirs()) throw new IOException("Could not create the Impulse standalone directory.");
            Map<String, Object> value = new LinkedHashMap<>();
            if (target.isFile()) {
                Map<?, ?> existing = GSON.fromJson(Files.readString(target.toPath(), StandardCharsets.UTF_8), Map.class);
                if (existing != null) for (Map.Entry<?, ?> entry : existing.entrySet()) value.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            value.put("update_channel", normalized);
            File temporary = new File(parent, target.getName() + ".tmp");
            Files.writeString(temporary.toPath(), GSON.toJson(value), StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            try {
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (Exception ignored) {
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
            updateChannel = normalized;
            status = "Update channel changed to " + ("beta".equals(normalized) ? "Beta." : "Stable.");
        } catch (Exception error) {
            status = "Could not save the update channel: " + clean(error.getMessage(), "Unknown error");
        }
    }

    private File standaloneSettingsFile() {
        return new File(gameDirectory(), "impulse/standalone/settings.json");
    }

    @Override
    protected void postRun() {
        if (!completed) writeResult(legalAccepted ? "fallback" : "quit", null, null);
    }

    @Override
    protected void disposeImGui() {
        if (backgroundTexture != 0) GL11.glDeleteTextures(backgroundTexture);
        if (logoTexture != 0) GL11.glDeleteTextures(logoTexture);
        if (imageCache != null) imageCache.close();
        super.disposeImGui();
    }

    private void renderBackdrop() {
        float width = ImGui.getIO().getDisplaySizeX();
        float height = ImGui.getIO().getDisplaySizeY();
        if (backgroundTexture != 0) {
            ImGui.getBackgroundDrawList().addImage(backgroundTexture, 0, 0, width, height, 0, 0, 1, 1, 0xFFFFFFFF);
        }
        ImGui.getBackgroundDrawList().addRectFilled(0, 0, width, height, ImGui.getColorU32(0.0F, 0.0F, 0.0F, 0.66F));
    }

    private void renderHeader() {
        float headerX = ImGui.getCursorPosX();
        float headerY = ImGui.getCursorPosY();
        float logoSize = 30.0F;
        if (logoTexture != 0) {
            ImGui.setCursorPosX(headerX);
            ImGui.setCursorPosY(headerY);
            ImGui.image(logoTexture, logoSize, logoSize);
        }

        ImGui.setCursorPosX(logoTexture != 0 ? headerX + logoSize + 10.0F : headerX);
        ImGui.setCursorPosY(headerY + 3.0F);
        ImGui.setWindowFontScale(1.32F);
        ImGui.text("IMPULSE");
        ImGui.setWindowFontScale(1.0F);
        ImGui.sameLine();
        ImGui.textDisabled("Standalone server setup");

        float channelWidth = 62.0F;
        float channelStart = Math.max(headerX + 340.0F, ImGui.getWindowWidth() - channelWidth * 2.0F - 92.0F);
        ImGui.setCursorPosX(channelStart);
        ImGui.setCursorPosY(headerY + 1.0F);
        ImGui.textDisabled("Updates");
        ImGui.sameLine();
        if (updateChannelButton("Stable", "stable", channelWidth)) setUpdateChannel("stable");
        ImGui.sameLine();
        if (updateChannelButton("Beta", "beta", channelWidth)) setUpdateChannel("beta");

        ImGui.setCursorPosX(headerX);
        ImGui.setCursorPosY(headerY + logoSize + 8.0F);
    }

    private void renderSidebar(float width, float height) {
        ImGui.beginChild("##profiles", width, height, true);
        ImGui.setScrollX(0.0F);
        float innerWidth = Math.max(120.0F, ImGui.getContentRegionAvailX());
        ImGui.textDisabled("PROFILES");
        ImGui.spacing();
        if (store.profiles.isEmpty()) {
            ImGui.textWrapped("No Impulse server has been configured for this Minecraft instance.");
        }
        for (ImpulseStandaloneBootstrap.Profile profile : store.profiles) {
            if (profile == null || profile.id == null) continue;
            boolean selected = selectedProfile != null && profile.id.equals(selectedProfile.id) && !editorOpen;
            String name = clean(profile.name, clean(profile.address, "Impulse server"));
            if (ImGui.selectable(name + "##" + profile.id, selected, 0, innerWidth, 28)) selectProfile(profile);
            ImGui.textDisabled(fitText(clean(profile.address, "Unknown address"), innerWidth));
            ImGui.spacing();
        }
        float buttonY = ImGui.getWindowHeight() - 47.0F;
        if (ImGui.getCursorPosY() < buttonY) ImGui.setCursorPosY(buttonY);
        if (outlineButton("+  Add server", innerWidth, 32)) openAddServer();
        ImGui.endChild();
    }

    private void renderProfileDetails() {
        if (selectedProfile == null) {
            ImGui.text("Choose a profile");
            ImGui.textDisabled("Select a server from the list or add a new one.");
            return;
        }
        if (manifest == null) manifest = ImpulseStandaloneBootstrap.loadCachedManifest(gameDirectory(), selectedProfile);
        ImGui.setWindowFontScale(1.45F);
        ImGui.text(clean(selectedProfile.name, "Impulse server"));
        ImGui.setWindowFontScale(1.0F);
        ImGui.textDisabled(clean(selectedProfile.address, "Unknown address"));
        ImGui.spacing();
        ImGui.separator();
        ImGui.spacing();

        if (manifest != null) {
            ImGui.textWrapped(clean(manifest.description, "A Minecraft server managed by Impulse."));
            ImGui.spacing();
            detailLine("Minecraft", manifest.minecraft == null ? "Unknown" : clean(manifest.minecraft.version, "Unknown"));
            detailLine("Loader", loaderLabel(manifest));
            detailLine("Required mods", String.valueOf(manifest.mods == null ? 0 : manifest.mods.size()));
            detailLine("Optional mods", String.valueOf(manifest.optional_mods == null ? 0 : manifest.optional_mods.size()));
        } else {
            ImGui.textWrapped("No cached manifest is available. Refresh this profile to inspect the server.");
        }

        ImGui.spacing();
        ImGui.separator();
        ImGui.spacing();
        ImGui.beginDisabled(busy);
        if (primaryButton(busy ? "Checking server..." : "Play", 170, 38)) playProfile();
        ImGui.sameLine();
        if (outlineButton("Refresh", 120, 38)) refreshProfile(false);
        ImGui.spacing();
        if (outlineButton("Add custom mods", 170, 36)) openCustomMods();
        ImGui.sameLine();
        if (outlineButton("Optional mods", 150, 38)) refreshProfile(true);
        ImGui.sameLine();
        if (outlineButton("Delete", 92, 38)) {
            deleteProfileId = selectedProfile.id;
            openDeleteConfirmation = true;
        }
        ImGui.endDisabled();
    }

    private void renderEditor() {
        ImGui.setWindowFontScale(1.36F);
        ImGui.text(discovery == null ? "Add an Impulse server" : clean(discovery.manifest.name, "Impulse server"));
        ImGui.setWindowFontScale(1.0F);
        ImGui.textDisabled("Impulse will check this server and prepare the mods you need.");
        ImGui.spacing();

        ImGui.setNextItemWidth(Math.max(220, ImGui.getContentRegionAvailX() - 146));
        ImGui.beginDisabled(busy || discovery != null);
        ImGui.inputTextWithHint("##server-address", "play.example.com:25565", address);
        ImGui.endDisabled();
        ImGui.sameLine();
        ImGui.beginDisabled(busy || discovery != null || address.get().trim().isEmpty());
        if (outlineButton(busy ? "Checking..." : "Check server", 132, 30)) checkNewServer();
        ImGui.endDisabled();

        if (discovery == null) {
            ImGui.spacing();
            ImGui.separator();
            ImGui.spacing();
            ImGui.textWrapped("Enter the server address, then select Check server.");
            if (!store.profiles.isEmpty()) {
                ImGui.spacing();
                if (outlineButton("Cancel", 110, 32)) closeEditor();
            }
            return;
        }

        manifest = discovery.manifest;
        ImGui.spacing();
        ImGui.separator();
        ImGui.spacing();
        detailLine("Address", discovery.host + ":" + discovery.minecraftPort);
        detailLine("Minecraft", manifest.minecraft == null ? "Unknown" : clean(manifest.minecraft.version, "Unknown"));
        detailLine("Loader", loaderLabel(manifest));
        detailLine("Required mods", String.valueOf(manifest.mods.size()));
        ImGui.spacing();
        ImGui.text("Optional mods");
        ImGui.textDisabled("Choose the additions you want in this profile. Dependencies are enabled automatically.");
        ImGui.spacing();
        ImGui.beginChild("##optional-mods", 0, Math.max(130, ImGui.getContentRegionAvailY() - 66), true);
        renderOptionalMods();
        ImGui.endChild();
        ImGui.spacing();
        ImGui.beginDisabled(busy);
        if (primaryButton("Save and play", 170, 36)) saveAndPlay();
        ImGui.sameLine();
        if (outlineButton("Save", 110, 36)) saveEditor(false);
        ImGui.sameLine();
        if (outlineButton("Cancel", 110, 36)) closeEditor();
        ImGui.endDisabled();
    }

    private void renderOptionalMods() {
        List<ImpulseStandaloneBootstrap.OptionalCategory> categories = new ArrayList<>(manifest.optional_mod_categories);
        categories.sort(Comparator.comparingInt((ImpulseStandaloneBootstrap.OptionalCategory category) -> category.order)
            .thenComparing(category -> clean(category.name, category.id), String.CASE_INSENSITIVE_ORDER));
        Set<String> rendered = new HashSet<>();
        for (ImpulseStandaloneBootstrap.OptionalCategory category : categories) {
            String id = normalize(category.id);
            renderCategory(id, clean(category.name, "Optional mods"), clean(category.description, ""));
            rendered.add(id);
        }
        boolean hasUngrouped = false;
        for (ImpulseStandaloneBootstrap.ManifestMod mod : manifest.optional_mods) {
            if (!rendered.contains(normalize(mod.category_id))) {
                hasUngrouped = true;
                break;
            }
        }
        if (hasUngrouped) renderCategory("", "Ungrouped", "Optional additions without a category.");
        if (manifest.optional_mods.isEmpty()) ImGui.textDisabled("This server does not publish optional mods.");
    }

    private void renderCategory(String categoryId, String name, String description) {
        List<ImpulseStandaloneBootstrap.ManifestMod> mods = new ArrayList<>();
        for (ImpulseStandaloneBootstrap.ManifestMod mod : manifest.optional_mods) {
            String modCategory = normalize(mod.category_id);
            if ((categoryId.isEmpty() && !knownCategory(modCategory)) || categoryId.equals(modCategory)) mods.add(mod);
        }
        if (mods.isEmpty()) return;
        boolean allExplicit = true;
        for (ImpulseStandaloneBootstrap.ManifestMod mod : mods) if (!selectedOptional.contains(normalize(mod.id))) allExplicit = false;
        ImBoolean categoryChecked = new ImBoolean(allExplicit);
        if (ImGui.checkbox(name + "##category-" + categoryId, categoryChecked)) {
            Set<String> changed = new LinkedHashSet<>(selectedOptional);
            for (ImpulseStandaloneBootstrap.ManifestMod mod : mods) {
                if (categoryChecked.get()) changed.add(normalize(mod.id));
                else changed.remove(normalize(mod.id));
            }
            applyOptionalSelection(changed);
        }
        if (!description.isEmpty()) {
            ImGui.indent(24);
            ImGui.textDisabled(shortDescription(description));
            ImGui.unindent(24);
        }
        Set<String> effective = effectiveOptional();
        ImGui.indent(24);
        for (ImpulseStandaloneBootstrap.ManifestMod mod : mods) {
            String id = normalize(mod.id);
            boolean explicit = selectedOptional.contains(id);
            boolean dependency = !explicit && effective.contains(id);
            ImBoolean checked = new ImBoolean(explicit || dependency);
            ImGui.beginDisabled(dependency);
            if (ImGui.checkbox(clean(mod.name, mod.file_name) + "##mod-" + id, checked)) {
                Set<String> changed = new LinkedHashSet<>(selectedOptional);
                if (checked.get()) changed.add(id); else changed.remove(id);
                applyOptionalSelection(changed);
            }
            ImGui.endDisabled();
            if (dependency) {
                ImGui.sameLine();
                ImGui.textDisabled("Required dependency");
            }
            if (mod.description != null && !mod.description.trim().isEmpty()) {
                ImGui.indent(24);
                ImGui.textWrapped(shortDescription(mod.description));
                ImGui.unindent(24);
            }
        }
        ImGui.unindent(24);
        ImGui.spacing();
    }

    private void openCustomMods() {
        if (selectedProfile == null) return;
        ImpulseStandaloneBootstrap.Manifest activeManifest = manifest == null
            ? ImpulseStandaloneBootstrap.loadCachedManifest(gameDirectory(), selectedProfile) : manifest;
        String minecraftVersion = activeManifest != null && activeManifest.minecraft != null
            ? clean(activeManifest.minecraft.version, request.minecraft_version) : request.minecraft_version;
        modrinth = new StandaloneModrinthManager(gameDirectory(), selectedProfile, minecraftVersion, "neoforge");
        customModState = modrinth.state();
        customModsOpen = true;
        editorOpen = false;
        modSearch.clear();
        modSearchResults.clear();
        globalMods.clear();
        projectCatalog.clear();
        modsView = ModsView.INSTALLED;
        returnModsView = ModsView.INSTALLED;
        modListScroll = 0.0F;
        clearSelectedModProject();
        status = "Manage custom mods for " + clean(selectedProfile.name, selectedProfile.address) + ".";
        runModTask(ModAction.UPDATES, "Checking custom mod updates", () -> modrinth.checkUpdates());
    }

    private void renderCustomMods() {
        ImGui.beginDisabled(modBusy);
        if (outlineButton("<  Back", 92, 30)) navigateBackFromMods();
        ImGui.endDisabled();
        ImGui.sameLine();
        ImGui.setWindowFontScale(1.34F);
        ImGui.text(modsView == ModsView.PROJECT ? clean(selectedModDetails == null ? null : selectedModDetails.title, "Mod details")
            : modsView == ModsView.VERSIONS ? "Versions" : "Custom mods");
        ImGui.setWindowFontScale(1.0F);
        if (modsView == ModsView.INSTALLED || modsView == ModsView.SEARCH) {
            ImGui.textDisabled("Discover and manage NeoForge mods for this profile.");
        }
        ImGui.spacing();

        if (modsView == ModsView.PROJECT) renderProjectPage();
        else if (modsView == ModsView.VERSIONS) renderVersionsPage();
        else {
            renderModBrowserToolbar();
            ImGui.separator();
            ImGui.spacing();
            float listHeight = Math.max(180.0F, ImGui.getContentRegionAvailY() - 62.0F);
            ImGui.beginChild("##custom-mod-list", 0, listHeight, true);
            if (restoreModListScroll) {
                ImGui.setScrollY(modListScroll);
                restoreModListScroll = false;
            }
            if (modsView == ModsView.SEARCH) renderModrinthSearchResults();
            else renderInstalledCustomMods();
            ImGui.endChild();
        }

        if (modBusy) {
            float fraction = modProgressTotal <= 0 ? 0.0F : Math.min(1.0F, (float) modProgressCompleted / (float) modProgressTotal);
            ImGui.progressBar(fraction, 0, 8, "");
            ImGui.textDisabled(clean(modProgress, "Working..."));
        } else {
            ImGui.textDisabled(clean(modProgress, customModState.mods.size() + " managed custom mod(s)."));
        }
    }

    private void renderModBrowserToolbar() {
        float searchButtonWidth = 92.0F;
        ImGui.setNextItemWidth(Math.max(220.0F, ImGui.getContentRegionAvailX() - searchButtonWidth - 12.0F));
        ImGui.beginDisabled(modBusy);
        ImGui.inputTextWithHint("##modrinth-search", "Search Modrinth", modSearch);
        ImGui.sameLine();
        if (primaryButton("Search", searchButtonWidth, 30)) searchModrinth();
        ImGui.endDisabled();
        renderChannelSelector();
        if (modsView == ModsView.SEARCH) {
            ImGui.sameLine();
            if (outlineButton("Installed", 96, 26)) {
                modsView = ModsView.INSTALLED;
                modSearch.clear();
                modSearchResults.clear();
            }
        }
    }

    private void renderChannelSelector() {
        ImGui.spacing();
        ImGui.textDisabled("Versions");
        ImGui.sameLine();
        if (channelButton("Release", StandaloneModrinthManager.Channel.RELEASE)) changeModChannel(StandaloneModrinthManager.Channel.RELEASE);
        ImGui.sameLine();
        if (channelButton("Beta", StandaloneModrinthManager.Channel.BETA)) changeModChannel(StandaloneModrinthManager.Channel.BETA);
        ImGui.sameLine();
        if (channelButton("All", StandaloneModrinthManager.Channel.ALL)) changeModChannel(StandaloneModrinthManager.Channel.ALL);
    }

    private boolean channelButton(String label, StandaloneModrinthManager.Channel channel) {
        if (modChannel == channel) {
            ImGui.pushStyleColor(ImGuiCol.Button, 0.82F, 0.82F, 0.82F, 1.0F);
            ImGui.pushStyleColor(ImGuiCol.ButtonHovered, 0.92F, 0.92F, 0.92F, 1.0F);
            ImGui.pushStyleColor(ImGuiCol.Text, 0.04F, 0.04F, 0.04F, 1.0F);
            boolean clicked = ImGui.button(label + "##channel", 82, 26);
            ImGui.popStyleColor(3);
            return clicked;
        }
        return outlineButton(label + "##channel", 82, 26);
    }

    private boolean channelStyleButton(String label, boolean selected, float width) {
        if (!selected) return outlineButton(label, width, 28);
        ImGui.pushStyleColor(ImGuiCol.Button, 0.82F, 0.82F, 0.82F, 1.0F);
        ImGui.pushStyleColor(ImGuiCol.ButtonHovered, 0.92F, 0.92F, 0.92F, 1.0F);
        ImGui.pushStyleColor(ImGuiCol.Text, 0.04F, 0.04F, 0.04F, 1.0F);
        boolean clicked = ImGui.button(label, width, 28);
        ImGui.popStyleColor(3);
        return clicked;
    }

    private void renderInstalledCustomMods() {
        ImGui.separatorText("Global /mods");
        renderGlobalMods();
        ImGui.separatorText("Profile mods");
        List<ImpulseStandaloneBootstrap.CustomModEntry> entries = new ArrayList<>();
        for (ImpulseStandaloneBootstrap.CustomModEntry entry : customModState.mods) {
            if (entry != null && StandaloneModrinthManager.InstallLocation.from(entry.location) == StandaloneModrinthManager.InstallLocation.PROFILE) entries.add(entry);
        }
        if (entries.isEmpty()) {
            ImGui.textDisabled("No profile-specific custom mods installed.");
            return;
        }
        entries.sort(Comparator.comparing(entry -> clean(entry.name, entry.file_name), String.CASE_INSENSITIVE_ORDER));
        for (ImpulseStandaloneBootstrap.CustomModEntry entry : entries) {
            StandaloneModrinthManager.ProjectDetails details = projectCatalog.get(entry.project_id);
            String icon = details == null ? null : details.icon_url;
            String meta = clean(entry.version_number, "Installed") + " · " + (entry.explicit ? "Profile" : "Dependency");
            String state = entry.update_version_id != null ? "Update available" : clean(entry.status, "Installed");
            if (renderModRow("managed-" + entry.project_id, icon, clean(entry.name, entry.file_name), meta,
                clean(entry.description, entry.file_name), state, false, true)) openProject(entry.project_id, null);
        }
    }

    private void renderGlobalMods() {
        if (globalMods.isEmpty()) {
            ImGui.textDisabled("No global mods found, or compatibility is still being checked.");
        } else {
            for (StandaloneModrinthManager.GlobalModInfo mod : globalMods) {
                String meta = clean(mod.version_number, "Local jar") + " · " + formatBytes(mod.size);
                String state = mod.incompatible() ? "Incompatible" : "compatible".equals(mod.compatibility) ? "Global" : "Unknown";
                boolean recognized = mod.project_id != null && !mod.project_id.isBlank();
                if (renderModRow("global-" + mod.file_name, mod.icon_url, clean(mod.name, mod.file_name), meta,
                    clean(mod.reason, mod.file_name), state, mod.incompatible(), recognized)) openProject(mod.project_id, null);
            }
        }
    }

    private void renderModrinthSearchResults() {
        if (modSearchResults.isEmpty()) {
            ImGui.text("No compatible mods found");
            ImGui.textDisabled("Results must support NeoForge and this profile's Minecraft version.");
            if (outlineButton("Show installed mods", 160, 28)) {
                modSearch.clear();
                clearSelectedModProject();
                modSearchResults.clear();
                modsView = ModsView.INSTALLED;
            }
            return;
        }
        for (StandaloneModrinthManager.SearchProject project : modSearchResults) {
            String state = installedProject(project.project_id) ? "Installed" : "Compatible";
            if (renderModRow("search-" + project.project_id, project.icon_url, project.title,
                clean(project.author, "Modrinth") + " · " + compactNumber(project.downloads) + " downloads",
                project.description, state, false, true)) openProject(project.project_id, project);
        }
    }

    private boolean renderModRow(String id, String iconUrl, String title, String meta, String description,
                                 String state, boolean incompatible, boolean clickable) {
        float width = Math.max(260.0F, ImGui.getContentRegionAvailX());
        float height = 88.0F;
        ImVec2 start = ImGui.getCursorScreenPos();
        ImGui.invisibleButton("##mod-row-" + id, width, height);
        boolean hovered = clickable && ImGui.isItemHovered();
        boolean clicked = clickable && ImGui.isItemClicked();
        ImDrawList draw = ImGui.getWindowDrawList();
        boolean warning = !clickable && "Unknown".equals(state);
        int background = ImGui.getColorU32(hovered ? 0.14F : 0.065F, hovered ? 0.14F : 0.065F, hovered ? 0.14F : 0.065F, 0.96F);
        int border = ImGui.getColorU32(incompatible ? 0.72F : warning ? 0.70F : 0.28F,
            incompatible ? 0.16F : warning ? 0.46F : 0.28F, incompatible ? 0.16F : warning ? 0.12F : 0.28F, 0.90F);
        draw.addRectFilled(start.x, start.y, start.x + width, start.y + height, background, 6.0F);
        draw.addRect(start.x, start.y, start.x + width, start.y + height, border, 6.0F);

        float iconX = start.x + 14.0F;
        float iconY = start.y + 14.0F;
        AsyncImageCache.Texture icon = imageCache == null ? null : imageCache.request(iconUrl, 128);
        if (icon != null) draw.addImageRounded(icon.id, iconX, iconY, iconX + 60.0F, iconY + 60.0F, 0, 1, 1, 0,
            0xFFFFFFFF, 6.0F);
        else drawPlaceholder(draw, iconX, iconY, 60.0F, initials(title));

        float textX = iconX + 74.0F;
        float stateWidth = Math.max(78.0F, ImGui.calcTextSizeX(state) + 20.0F);
        float textWidth = Math.max(90.0F, width - (textX - start.x) - stateWidth - 22.0F);
        int titleColor = ImGui.getColorU32(incompatible ? 1.0F : warning ? 1.0F : 0.96F,
            incompatible ? 0.34F : warning ? 0.72F : 0.96F, incompatible ? 0.34F : warning ? 0.30F : 0.96F, 1.0F);
        draw.addText(textX, start.y + 12.0F, titleColor, fitText(clean(title, "Unknown mod"), textWidth));
        draw.addText(textX, start.y + 34.0F, ImGui.getColorU32(0.62F, 0.62F, 0.62F, 1.0F), fitText(clean(meta, "Modrinth"), textWidth));
        List<String> lines = wrapDisplayText(clean(description, "No description available."), textWidth, 2);
        for (int i = 0; i < lines.size(); i++) {
            draw.addText(textX, start.y + 55.0F + i * 16.0F, ImGui.getColorU32(0.78F, 0.78F, 0.78F, 1.0F), lines.get(i));
        }
        int stateColor = ImGui.getColorU32(incompatible ? 1.0F : 0.72F, incompatible ? 0.34F : 0.82F, incompatible ? 0.34F : 0.92F, 1.0F);
        draw.addText(start.x + width - stateWidth, start.y + 14.0F, stateColor, state);
        if (clickable) draw.addText(start.x + width - 24.0F, start.y + height - 27.0F, ImGui.getColorU32(0.65F, 0.65F, 0.65F, 1.0F), ">");
        ImGui.spacing();
        return clicked;
    }

    private void renderProjectPage() {
        if (selectedModDetails == null) {
            ImGui.textDisabled(modBusy ? "Loading project..." : "This Modrinth project could not be loaded.");
            return;
        }
        StandaloneModrinthManager.ProjectDetails details = selectedModDetails;
        ImpulseStandaloneBootstrap.CustomModEntry installed = installedEntry(details.project_id);
        StandaloneModrinthManager.GlobalModInfo global = globalEntry(details.project_id);

        float iconSize = 92.0F;
        float startX = ImGui.getCursorPosX();
        float startY = ImGui.getCursorPosY();
        renderImageOrPlaceholder(details.icon_url, 128, iconSize, iconSize, initials(details.title));
        ImGui.sameLine();
        ImGui.beginGroup();
        ImGui.setWindowFontScale(1.62F);
        ImGui.textWrapped(clean(details.title, "Modrinth project"));
        ImGui.setWindowFontScale(1.0F);
        disabledWrapped(details.authors.isEmpty() ? "Modrinth" : "By " + String.join(", ", details.authors));
        disabledWrapped(compactNumber(details.downloads) + " downloads · " + compatibilityLabel(details));
        if (details.license_id != null && !details.license_id.isBlank()) {
            ImGui.textDisabled("License: " + clean(details.license_name, details.license_id));
        }
        ImGui.endGroup();
        ImGui.setCursorPosX(startX);
        ImGui.setCursorPosY(Math.max(ImGui.getCursorPosY(), startY + iconSize + 10.0F));

        ImGui.beginDisabled(modBusy || selectedModVersions.isEmpty());
        if (installed == null && global == null) {
            if (primaryButton("Install latest", 142, 34)) planCustomMod(details.project_id, selectedModVersions.get(0).id);
        } else if (installed != null && installed.update_version_id != null) {
            if (primaryButton("Update", 112, 34)) planCustomMod(details.project_id, installed.update_version_id);
        } else {
            ImGui.beginDisabled();
            primaryButton(global != null && installed == null ? "Installed globally" : "Installed", 142, 34);
            ImGui.endDisabled();
        }
        ImGui.endDisabled();
        ImGui.sameLine();
        if (outlineButton("Versions", 112, 34)) modsView = ModsView.VERSIONS;
        if (installed != null) {
            ImGui.newLine();
            if (outlineButton("Repair", 86, 34)) repairCustomMod(installed.project_id);
            String moveLabel = StandaloneModrinthManager.InstallLocation.from(installed.location) == StandaloneModrinthManager.InstallLocation.GLOBAL
                ? "Move to profile" : "Move to /mods";
            ImGui.sameLine();
            if (outlineButton(moveLabel, 132, 34)) {
                StandaloneModrinthManager.InstallLocation destination = StandaloneModrinthManager.InstallLocation.from(installed.location)
                    == StandaloneModrinthManager.InstallLocation.GLOBAL ? StandaloneModrinthManager.InstallLocation.PROFILE
                    : StandaloneModrinthManager.InstallLocation.GLOBAL;
                planCustomMod(installed.project_id, installed.version_id, destination);
            }
            if (installed.explicit) {
                ImGui.sameLine();
                if (outlineButton("Remove", 88, 34)) {
                    removeCustomProjectId = installed.project_id;
                    openRemoveConfirmation = true;
                }
            }
        }

        ImGui.spacing();
        List<String> facts = new ArrayList<>();
        if (global != null) facts.add("Installed in global /mods");
        else if (installed != null) facts.add("Installed for this profile");
        if (details.categories != null && !details.categories.isEmpty()) facts.add(String.join(" · ", details.categories));
        if (!facts.isEmpty()) disabledWrapped(String.join("   |   ", facts));
        ImGui.spacing();
        renderProjectGallery(details);
        ImGui.spacing();
        ImGui.separatorText("About");
        renderMarkdown(clean(details.body, details.description));
        renderProjectLinks(details);
    }

    private void renderVersionsPage() {
        if (selectedModDetails == null) return;
        renderChannelSelector();
        ImGui.spacing();
        if (selectedModVersions.isEmpty()) {
            ImGui.textDisabled(modBusy ? "Loading compatible versions..." : "No compatible versions are available for this channel.");
            return;
        }
        ImpulseStandaloneBootstrap.CustomModEntry installed = installedEntry(selectedModDetails.project_id);
        ImGui.beginChild("##versions-list", 0, Math.max(170.0F, ImGui.getContentRegionAvailY() - 18.0F), false);
        for (StandaloneModrinthManager.ProjectVersion version : selectedModVersions) {
            StandaloneModrinthManager.DownloadFile file = version.primaryFile();
            if (file == null) continue;
            ImGui.beginChild("##version-" + version.id, 0, version.changelog == null || version.changelog.isBlank() ? 78 : 128, true);
            ImGui.text(version.version_number);
            ImGui.sameLine();
            ImGui.textDisabled(version.version_type + " · " + formatDate(version.date_published) + " · " + formatBytes(file.size));
            boolean current = installed != null && version.id.equals(installed.version_id);
            ImGui.beginDisabled(modBusy || current);
            if (primaryButton(current ? "Current" : "Install", 92, 28)) planCustomMod(selectedModDetails.project_id, version.id);
            ImGui.endDisabled();
            if (version.changelog != null && !version.changelog.isBlank()) {
                disabledWrapped(shortDescription(version.changelog));
            }
            ImGui.endChild();
            ImGui.spacing();
        }
        ImGui.endChild();
    }

    private void renderProjectGallery(StandaloneModrinthManager.ProjectDetails details) {
        if (details.gallery.isEmpty()) return;
        String featured = clean(details.featured_gallery, details.gallery.get(0).url);
        AsyncImageCache.Texture hero = imageCache == null ? null : imageCache.request(featured, 1280);
        float available = Math.max(280.0F, ImGui.getContentRegionAvailX());
        float heroHeight = Math.min(260.0F, available * 0.48F);
        renderFixedImage("##featured-gallery", hero, available, heroHeight, "Gallery image", true);
        if (ImGui.isItemClicked()) {
            int index = 0;
            for (int i = 0; i < details.gallery.size(); i++) {
                if (featured.equals(details.gallery.get(i).url)) { index = i; break; }
            }
            openLightbox(index);
        }

        ImGui.spacing();
        float thumbnailWidth = 106.0F;
        float navigationWidth = details.gallery.size() > 1 ? 144.0F : 0.0F;
        int perPage = Math.max(1, Math.min(8,
            (int) Math.floor((available - navigationWidth) / (thumbnailWidth + 10.0F))));
        int pageCount = Math.max(1, (details.gallery.size() + perPage - 1) / perPage);
        galleryPage = Math.max(0, Math.min(galleryPage, pageCount - 1));
        int start = galleryPage * perPage;
        int end = Math.min(details.gallery.size(), start + perPage);

        if (pageCount > 1) {
            ImGui.beginDisabled(galleryPage == 0);
            if (outlineButton("<##gallery-previous", 58, 76)) galleryPage--;
            ImGui.endDisabled();
            ImGui.sameLine();
        }
        for (int i = start; i < end; i++) {
            StandaloneModrinthManager.GalleryImage image = details.gallery.get(i);
            AsyncImageCache.Texture texture = imageCache == null ? null : imageCache.request(image.url, 128);
            if (i > start) ImGui.sameLine();
            if (texture != null) {
                if (ImGui.imageButton("##gallery-" + i, texture.id, thumbnailWidth, 76)) openLightbox(i);
            } else {
                if (outlineButton("Image " + (i + 1) + "##gallery-placeholder-" + i, thumbnailWidth, 76)) openLightbox(i);
            }
        }
        if (pageCount > 1) {
            ImGui.sameLine();
            ImGui.beginDisabled(galleryPage >= pageCount - 1);
            if (outlineButton(">##gallery-next", 58, 76)) galleryPage++;
            ImGui.endDisabled();
            ImGui.textDisabled("Gallery " + (start + 1) + "-" + end + " of " + details.gallery.size());
        }
    }

    private void renderProjectLinks(StandaloneModrinthManager.ProjectDetails details) {
        List<String[]> links = new ArrayList<>();
        links.add(new String[] { "Modrinth", "https://modrinth.com/mod/" + clean(details.slug, details.project_id) });
        if (safeHttps(details.source_url)) links.add(new String[] { "Source", details.source_url });
        if (safeHttps(details.issues_url)) links.add(new String[] { "Issues", details.issues_url });
        if (safeHttps(details.wiki_url)) links.add(new String[] { "Wiki", details.wiki_url });
        if (safeHttps(details.discord_url)) links.add(new String[] { "Discord", details.discord_url });
        if (safeHttps(details.license_url)) links.add(new String[] { "License", details.license_url });
        if (links.isEmpty()) return;
        ImGui.spacing();
        ImGui.separatorText("Links");
        for (int i = 0; i < links.size(); i++) {
            if (i > 0) ImGui.sameLine();
            String[] link = links.get(i);
            if (outlineButton(link[0] + "##project-link-" + i, 92, 28)) openExternal(link[1]);
        }
    }

    private void navigateBackFromMods() {
        if (modsView == ModsView.VERSIONS) {
            modsView = ModsView.PROJECT;
            return;
        }
        if (modsView == ModsView.PROJECT) {
            modsView = returnModsView;
            restoreModListScroll = true;
            selectedModDetails = null;
            selectedModVersions.clear();
            selectedModProject = null;
            return;
        }
        customModsOpen = false;
        clearSelectedModProject();
        status = "Ready to check and load " + clean(selectedProfile == null ? null : selectedProfile.name,
            selectedProfile == null ? "this server" : selectedProfile.address) + ".";
    }

    private StandaloneModrinthManager.GlobalModInfo globalEntry(String projectId) {
        if (projectId == null) return null;
        for (StandaloneModrinthManager.GlobalModInfo item : globalMods) {
            if (item != null && projectId.equals(item.project_id)) return item;
        }
        return null;
    }

    private void loadProjectCatalog() {
        Set<String> ids = new LinkedHashSet<>();
        if (customModState != null && customModState.mods != null) {
            for (ImpulseStandaloneBootstrap.CustomModEntry entry : customModState.mods) {
                if (entry != null && entry.project_id != null && !entry.project_id.isBlank()) ids.add(entry.project_id);
            }
        }
        runModTask(ModAction.CATALOG, "Loading mod details", () -> {
            Map<String, StandaloneModrinthManager.ProjectDetails> catalog = new LinkedHashMap<>();
            for (String id : ids) {
                try { catalog.put(id, modrinth.project(id)); }
                catch (Exception error) { System.out.println("[Impulse UI] Could not load Modrinth project " + id + ": " + error.getMessage()); }
            }
            return catalog;
        });
    }

    private void renderImageOrPlaceholder(String url, int maxDimension, float width, float height, String label) {
        AsyncImageCache.Texture texture = imageCache == null ? null : imageCache.request(url, maxDimension);
        renderFixedImage("##image-" + Integer.toHexString((clean(url, label)).hashCode()), texture, width, height, label, false);
    }

    private static void disabledWrapped(String value) {
        ImGui.pushStyleColor(ImGuiCol.Text, 0.58F, 0.58F, 0.58F, 1.0F);
        ImGui.textWrapped(clean(value, ""));
        ImGui.popStyleColor();
    }

    private void renderImagePlaceholder(float width, float height, String label) {
        renderFixedImage("##placeholder-" + label, null, width, height, label, false);
    }

    private void renderFixedImage(String id, AsyncImageCache.Texture texture, float width, float height,
                                  String label, boolean button) {
        ImVec2 start = ImGui.getCursorScreenPos();
        ImGui.invisibleButton(id, width, height);
        ImDrawList draw = ImGui.getWindowDrawList();
        draw.addRectFilled(start.x, start.y, start.x + width, start.y + height,
            ImGui.getColorU32(0.045F, 0.045F, 0.045F, 1.0F), 6.0F);
        if (texture == null) {
            draw.addRect(start.x, start.y, start.x + width, start.y + height,
                ImGui.getColorU32(0.25F, 0.25F, 0.25F, 1.0F), 6.0F);
            String text = clean(label, "Image");
            draw.addText(start.x + Math.max(10.0F, (width - ImGui.calcTextSizeX(text)) / 2.0F),
                start.y + Math.max(8.0F, (height - ImGui.getTextLineHeight()) / 2.0F),
                ImGui.getColorU32(0.56F, 0.56F, 0.56F, 1.0F), text);
            return;
        }
        float scale = Math.min(width / texture.width, height / texture.height);
        float drawWidth = texture.width * scale;
        float drawHeight = texture.height * scale;
        float x = start.x + (width - drawWidth) / 2.0F;
        float y = start.y + (height - drawHeight) / 2.0F;
        draw.addImageRounded(texture.id, x, y, x + drawWidth, y + drawHeight, 0, 1, 1, 0,
            0xFFFFFFFF, button && ImGui.isItemHovered() ? 3.0F : 6.0F);
    }

    private static void drawPlaceholder(ImDrawList draw, float x, float y, float size, String label) {
        draw.addRectFilled(x, y, x + size, y + size, ImGui.getColorU32(0.13F, 0.13F, 0.13F, 1.0F), 6.0F);
        String text = clean(label, "?");
        draw.addText(x + Math.max(4.0F, (size - ImGui.calcTextSizeX(text)) / 2.0F),
            y + (size - ImGui.getTextLineHeight()) / 2.0F,
            ImGui.getColorU32(0.76F, 0.76F, 0.76F, 1.0F), text);
    }

    private static String initials(String value) {
        String clean = value == null ? "" : value.trim();
        if (clean.isEmpty()) return "?";
        StringBuilder initials = new StringBuilder(2);
        for (String part : clean.split("\\s+")) {
            if (!part.isEmpty()) initials.append(Character.toUpperCase(part.charAt(0)));
            if (initials.length() == 2) break;
        }
        return initials.toString();
    }

    private static List<String> wrapDisplayText(String value, float width, int maxLines) {
        List<String> lines = new ArrayList<>();
        StringBuilder line = new StringBuilder();
        String[] words = clean(value, "").replaceAll("\\s+", " ").split(" ");
        boolean truncated = false;
        for (String word : words) {
            String candidate = line.length() == 0 ? word : line + " " + word;
            if (line.length() > 0 && ImGui.calcTextSizeX(candidate) > width) {
                lines.add(line.toString());
                line.setLength(0);
                line.append(word);
                if (lines.size() == maxLines) { truncated = true; break; }
            } else {
                line.setLength(0);
                line.append(candidate);
            }
        }
        if (lines.size() < maxLines && line.length() > 0) lines.add(line.toString());
        if (lines.size() > maxLines) lines = new ArrayList<>(lines.subList(0, maxLines));
        if (truncated && lines.size() == maxLines) {
            String last = lines.get(maxLines - 1);
            while (ImGui.calcTextSizeX(last + "...") > width && !last.isEmpty()) last = last.substring(0, last.length() - 1);
            lines.set(maxLines - 1, last + "...");
        }
        return lines;
    }

    private static String compatibilityLabel(StandaloneModrinthManager.ProjectDetails details) {
        List<String> labels = new ArrayList<>();
        if (details.game_versions != null && !details.game_versions.isEmpty()) labels.add(details.game_versions.get(details.game_versions.size() - 1));
        if (details.loaders != null) {
            for (String loader : details.loaders) if ("neoforge".equalsIgnoreCase(loader)) { labels.add("NeoForge"); break; }
        }
        return labels.isEmpty() ? "Client mod" : String.join(" · ", labels);
    }

    private void renderMarkdown(String markdown) {
        String source = clean(markdown, "No description is available.");
        if (source.length() > 64 * 1024) source = source.substring(0, 64 * 1024) + "\n\nDescription truncated.";
        source = source.replaceAll("(?is)<[^>]+>", "");
        boolean code = false;
        int linkId = 0;
        for (String raw : source.split("\\R", -1)) {
            String line = raw.stripTrailing();
            if (line.trim().startsWith("```")) { code = !code; continue; }
            if (line.isBlank()) { ImGui.spacing(); continue; }
            if (code) {
                ImGui.pushStyleColor(ImGuiCol.Text, 0.78F, 0.84F, 0.88F, 1.0F);
                ImGui.textWrapped(line);
                ImGui.popStyleColor();
                continue;
            }
            int heading = 0;
            while (heading < line.length() && heading < 3 && line.charAt(heading) == '#') heading++;
            if (heading > 0 && line.length() > heading && Character.isWhitespace(line.charAt(heading))) {
                ImGui.setWindowFontScale(heading == 1 ? 1.32F : heading == 2 ? 1.18F : 1.08F);
                ImGui.textWrapped(stripMarkdown(line.substring(heading).trim()));
                ImGui.setWindowFontScale(1.0F);
                continue;
            }
            String prefix = "";
            String body = line.trim();
            if (body.startsWith("- ") || body.startsWith("* ")) { prefix = "• "; body = body.substring(2); }
            else if (body.startsWith("> ")) { prefix = "  "; body = body.substring(2); }
            Matcher link = MARKDOWN_LINK.matcher(body);
            if (link.find()) {
                String text = prefix + stripMarkdown(body.substring(0, link.start()) + link.group(1) + body.substring(link.end()));
                ImGui.textWrapped(text);
                if (safeHttps(link.group(2)) && outlineButton("Open link##markdown-" + linkId++, 92, 24)) openExternal(link.group(2));
            } else ImGui.textWrapped(prefix + stripMarkdown(body));
        }
    }

    private static String stripMarkdown(String value) {
        return value.replace("**", "").replace("__", "").replace("`", "").replace("~~", "");
    }

    private static boolean safeHttps(String value) {
        try { return value != null && "https".equalsIgnoreCase(URI.create(value).getScheme()); }
        catch (Exception ignored) { return false; }
    }

    private static void openExternal(String value) {
        if (!safeHttps(value) || !Desktop.isDesktopSupported()) return;
        try { Desktop.getDesktop().browse(URI.create(value)); }
        catch (Exception error) { System.out.println("[Impulse UI] Could not open link: " + error.getMessage()); }
    }

    private void openLightbox(int index) {
        if (selectedModDetails == null || selectedModDetails.gallery.isEmpty()) return;
        lightboxIndex = Math.max(0, Math.min(index, selectedModDetails.gallery.size() - 1));
        openGalleryLightbox = true;
    }

    private void searchModrinth() {
        String query = modSearch.get().trim();
        if (query.isEmpty()) {
            modSearchResults.clear();
            clearSelectedModProject();
            return;
        }
        runModTask(ModAction.SEARCH, "Searching Modrinth", () -> modrinth.search(query));
        changingCustomProjectId = null;
    }

    private void openProject(String projectId, StandaloneModrinthManager.SearchProject source) {
        if (modBusy) return;
        if (modsView == ModsView.INSTALLED || modsView == ModsView.SEARCH) {
            returnModsView = modsView;
            modListScroll = ImGui.getScrollY();
        }
        modsView = ModsView.PROJECT;
        if (source != null) selectedModProject = source;
        else {
            selectedModProject = new StandaloneModrinthManager.SearchProject();
            selectedModProject.project_id = projectId;
            ImpulseStandaloneBootstrap.CustomModEntry installed = installedEntry(projectId);
            StandaloneModrinthManager.GlobalModInfo global = globalEntry(projectId);
            selectedModProject.title = installed != null ? clean(installed.name, projectId)
                : global != null ? clean(global.name, projectId) : projectId;
        }
        selectedModDetails = null;
        selectedModVersions.clear();
        galleryPage = 0;
        StandaloneModrinthManager.ProjectDetails cached = projectCatalog.get(projectId);
        if (cached != null) selectedModDetails = cached;
        runModTask(ModAction.PROJECT, "Loading " + selectedModProject.title, () -> new ProjectPayload(
            modrinth.project(projectId), modrinth.versions(projectId, modChannel)));
    }

    private void changeModChannel(StandaloneModrinthManager.Channel channel) {
        if (modBusy || modChannel == channel) return;
        modChannel = channel;
        if (selectedModProject != null && (modsView == ModsView.PROJECT || modsView == ModsView.VERSIONS)) {
            runModTask(ModAction.PROJECT, "Loading compatible versions", () -> new ProjectPayload(
                modrinth.project(selectedModProject.project_id), modrinth.versions(selectedModProject.project_id, modChannel)));
        }
    }

    private void planCustomMod(String projectId, String versionId) {
        ImpulseStandaloneBootstrap.CustomModEntry installed = installedEntry(projectId);
        StandaloneModrinthManager.InstallLocation location = installed == null ? StandaloneModrinthManager.InstallLocation.PROFILE
            : StandaloneModrinthManager.InstallLocation.from(installed.location);
        planCustomMod(projectId, versionId, location);
    }

    private void planCustomMod(String projectId, String versionId, StandaloneModrinthManager.InstallLocation location) {
        pendingInstallLocation = location;
        runModTask(ModAction.PLAN, "Resolving dependencies", () -> modrinth.plan(projectId, versionId, modChannel));
    }

    private void installPendingPlan() {
        if (pendingInstallPlan == null) return;
        StandaloneModrinthManager.InstallPlan plan = pendingInstallPlan;
        Set<String> optional = new LinkedHashSet<>(selectedModrinthOptional);
        runModTask(ModAction.INSTALL, "Preparing downloads", () -> {
            modrinth.install(plan, optional, pendingInstallLocation, this::updateModProgress);
            return modrinth.checkUpdates();
        });
    }

    private void repairCustomMod(String projectId) {
        runModTask(ModAction.REPAIR, "Repairing custom mod", () -> {
            modrinth.repair(projectId, this::updateModProgress);
            return modrinth.checkUpdates();
        });
    }

    private void removeCustomMod() {
        String projectId = removeCustomProjectId;
        runModTask(ModAction.REMOVE, "Removing custom mod", () -> {
            modrinth.remove(projectId);
            return modrinth.state();
        });
    }

    private <T> void runModTask(ModAction action, String message, Callable<T> task) {
        if (modBusy) return;
        modBusy = true;
        modProgress = message;
        modProgressCompleted = 0;
        modProgressTotal = 1;
        Thread worker = new Thread(() -> {
            try { modAsyncResult = ModAsyncResult.success(action, task.call()); }
            catch (Throwable error) { modAsyncResult = ModAsyncResult.failure(action, error); }
        }, "impulse-modrinth-" + action.name().toLowerCase(Locale.ROOT));
        worker.setDaemon(true);
        worker.start();
    }

    private void updateModProgress(String message, int completed, int total) {
        modProgress = message;
        modProgressCompleted = completed;
        modProgressTotal = Math.max(1, total);
    }

    @SuppressWarnings("unchecked")
    private void consumeModAsyncResult() {
        ModAsyncResult result = modAsyncResult;
        if (result == null) return;
        modAsyncResult = null;
        modBusy = false;
        if (result.error != null) {
            String message = clean(result.error.getMessage(), "The custom mod operation failed.");
            modProgress = message;
            if (result.action == ModAction.PLAY_CHECK) {
                status = message;
                pendingLaunchProfileId = null;
            }
            return;
        }
        switch (result.action) {
            case SEARCH -> {
                modSearchResults = (List<StandaloneModrinthManager.SearchProject>) result.value;
                clearSelectedModProject();
                modsView = ModsView.SEARCH;
                modProgress = modSearchResults.size() + " compatible result(s).";
            }
            case PROJECT -> {
                ProjectPayload payload = (ProjectPayload) result.value;
                selectedModDetails = payload.details;
                selectedModVersions = payload.versions;
                if (payload.details != null && payload.details.project_id != null) {
                    projectCatalog.put(payload.details.project_id, payload.details);
                }
                if (selectedModProject != null) {
                    selectedModProject.title = clean(payload.details.title, selectedModProject.title);
                    selectedModProject.description = clean(payload.details.description, selectedModProject.description);
                }
                modProgress = selectedModVersions.size() + " compatible version(s).";
            }
            case PLAN -> {
                pendingInstallPlan = (StandaloneModrinthManager.InstallPlan) result.value;
                selectedModrinthOptional.clear();
                openInstallConfirmation = true;
                modProgress = "Installation plan ready.";
            }
            case GLOBAL -> {
                globalMods = (List<StandaloneModrinthManager.GlobalModInfo>) result.value;
                modProgress = globalMods.size() + " global mod(s) checked.";
                loadProjectCatalog();
            }
            case CATALOG -> {
                projectCatalog.clear();
                projectCatalog.putAll((Map<String, StandaloneModrinthManager.ProjectDetails>) result.value);
                int managedCount = customModState == null || customModState.mods == null ? 0 : customModState.mods.size();
                modProgress = managedCount + " managed custom mod(s).";
            }
            case PLAY_CHECK -> {
                List<StandaloneModrinthManager.GlobalModInfo> checked = (List<StandaloneModrinthManager.GlobalModInfo>) result.value;
                incompatibleGlobalMods = new ArrayList<>();
                for (StandaloneModrinthManager.GlobalModInfo mod : checked) if (mod.incompatible()) incompatibleGlobalMods.add(mod);
                if (incompatibleGlobalMods.isEmpty()) completeSelection(pendingLaunchProfileId);
                else openIncompatibleWarning = true;
            }
            case UPDATES, INSTALL, REPAIR, REMOVE -> {
                customModState = (ImpulseStandaloneBootstrap.CustomModState) result.value;
                pendingInstallPlan = null;
                modProgress = result.action == ModAction.REMOVE ? "Custom mod removed." : "Custom mods are ready.";
                runModTask(ModAction.GLOBAL, "Checking global mods", () -> modrinth.globalMods());
            }
        }
    }

    private boolean installedProject(String projectId) { return installedEntry(projectId) != null; }
    private ImpulseStandaloneBootstrap.CustomModEntry installedEntry(String projectId) {
        if (customModState == null || customModState.mods == null) return null;
        for (ImpulseStandaloneBootstrap.CustomModEntry entry : customModState.mods) if (entry != null && projectId.equals(entry.project_id)) return entry;
        return null;
    }

    private void clearSelectedModProject() {
        selectedModProject = null;
        selectedModDetails = null;
        selectedModVersions.clear();
        changingCustomProjectId = null;
    }

    private void renderStatus() {
        ImGui.spacing();
        if (busy) {
            ImGui.textColored(0.88F, 0.88F, 0.88F, 1.0F, "Working");
            ImGui.sameLine();
        }
        if (status != null && !status.isEmpty()) ImGui.textWrapped(status);
    }

    private void renderModals() {
        renderGalleryLightbox();
        if (openModVerificationWarning) {
            ImGui.openPopup("Some server mods could not be independently verified");
            openModVerificationWarning = false;
        }
        float warningWidth = Math.min(620.0F, Math.max(500.0F, ImGui.getIO().getDisplaySizeX() - 120.0F));
        float warningHeight = Math.min(460.0F, Math.max(380.0F, ImGui.getIO().getDisplaySizeY() - 110.0F));
        ImGui.setNextWindowSize(warningWidth, warningHeight, ImGuiCond.Appearing);
        if (ImGui.beginPopupModal("Some server mods could not be independently verified", ImGuiWindowFlags.NoTitleBar | ImGuiWindowFlags.NoResize)) {
            ImGui.textColored(1.0F, 0.72F, 0.28F, 1.0F, "MOD VERIFICATION");
            ImGui.text("Some server mods could not be independently verified");
            ImGui.spacing();
            ImGui.pushTextWrapPos(ImGui.getCursorPosX() + ImGui.getContentRegionAvailX());
            ImGui.textColored(0.70F, 0.70F, 0.70F, 1.0F, "Impulse confirmed that these files match the SHA-512 hashes declared by the server, but some could not be matched to a compatible Modrinth or CurseForge release, or the Impulse recognized-mod registry. Minecraft mods can run code on your computer. Continue only if you trust this server or have reviewed these files yourself.");
            ImGui.popTextWrapPos();
            ImGui.spacing();
            ImGui.separator();
            ImGui.spacing();
            float listHeight = Math.max(105.0F, ImGui.getContentRegionAvailY() - 54.0F);
            ImGui.beginChild("##unverified-mods", 0, listHeight, false);
            for (int index = 0; index < pendingUnverifiedMods.size(); index++) {
                ImpulseStandaloneBootstrap.ManifestMod mod = pendingUnverifiedMods.get(index);
                String hash = clean(mod.sha512, "");
                String statusLabel = mod.verification == null ? "Verification unavailable" : clean(mod.verification.status, "Verification unavailable");
                ImGui.pushStyleColor(ImGuiCol.ChildBg, 0.055F, 0.055F, 0.055F, 1.0F);
                ImGui.beginChild("##unverified-row-" + index, 0, 88, true, ImGuiWindowFlags.NoScrollbar);
                ImGui.text(clean(mod.name, mod.file_name));
                float statusWidth = ImGui.calcTextSizeX(statusLabel);
                ImGui.sameLine(Math.max(ImGui.getCursorPosX() + 12.0F, ImGui.getWindowWidth() - statusWidth - 18.0F));
                ImGui.textColored(1.0F, 0.72F, 0.28F, 1.0F, statusLabel);
                ImGui.textDisabled(clean(mod.file_name, "mod.jar"));
                ImGui.pushTextWrapPos(ImGui.getCursorPosX() + ImGui.getContentRegionAvailX());
                ImGui.textDisabled("SHA-512  " + hash);
                ImGui.popTextWrapPos();
                if (ImGui.smallButton("Copy hash##sha512-" + index)) ImGui.setClipboardText(hash);
                ImGui.endChild();
                ImGui.popStyleColor();
                if (index < pendingUnverifiedMods.size() - 1) ImGui.spacing();
            }
            ImGui.endChild();
            int seconds = Math.max(0, (int) Math.ceil((modVerificationReadyAt - System.currentTimeMillis()) / 1000.0));
            float cancelWidth = 120.0F;
            float continueWidth = 190.0F;
            ImGui.setCursorPosX(Math.max(ImGui.getCursorPosX(), ImGui.getWindowWidth() - cancelWidth - continueWidth - 32.0F));
            if (outlineButton("Cancel", 120, 32)) {
                pendingVerificationProfile = null; pendingVerificationDiscovery = null; pendingUnverifiedMods.clear(); ImGui.closeCurrentPopup();
            }
            ImGui.sameLine();
            ImGui.beginDisabled(seconds > 0);
            if (primaryButton(seconds > 0 ? "Continue anyway (" + seconds + ")" : "Continue anyway", 190, 32)) {
                try {
                    String signature = ImpulseStandaloneBootstrap.problematicSignature(pendingUnverifiedMods);
                    ImpulseStandaloneBootstrap.acceptUnverifiedMods(gameDirectory(), pendingVerificationProfile.id, signature);
                    ImGui.closeCurrentPopup(); finishSelected(pendingVerificationProfile.id);
                } catch (Exception error) { status = clean(error.getMessage(), "Could not save the verification choice."); }
            }
            ImGui.endDisabled();
            ImGui.endPopup();
        }
        if (openInstallConfirmation) {
            ImGui.openPopup("Install custom mods?");
            openInstallConfirmation = false;
        }
        ImGui.setNextWindowSize(520, 0, ImGuiCond.Appearing);
        if (ImGui.beginPopupModal("Install custom mods?", ImGuiWindowFlags.AlwaysAutoResize)) {
            if (pendingInstallPlan == null) {
                ImGui.textDisabled("The installation plan is no longer available.");
            } else {
                ImGui.textWrapped("Impulse will install these mods for this server profile.");
                ImGui.spacing();
                for (StandaloneModrinthManager.PlanItem item : pendingInstallPlan.items.values()) {
                    ImGui.text("- " + item.project.title + " " + item.version.version_number);
                    if (!item.explicit) {
                        ImGui.sameLine();
                        ImGui.textDisabled("required dependency");
                    }
                }
                if (!pendingInstallPlan.optional_dependencies.isEmpty()) {
                    ImGui.spacing();
                    ImGui.text("Optional additions");
                    for (StandaloneModrinthManager.OptionalDependency dependency : pendingInstallPlan.optional_dependencies) {
                        ImBoolean checked = new ImBoolean(selectedModrinthOptional.contains(dependency.project_id));
                        if (ImGui.checkbox(clean(dependency.name, dependency.project_id) + "##plan-optional-" + dependency.project_id, checked)) {
                            if (checked.get()) selectedModrinthOptional.add(dependency.project_id);
                            else selectedModrinthOptional.remove(dependency.project_id);
                        }
                    }
                }
                ImGui.spacing();
                ImGui.textDisabled(formatBytes(pendingInstallPlan.totalSize()) + " before optional additions");
                ImGui.spacing();
                ImGui.text("Install location");
                if (channelStyleButton("Profile mods", pendingInstallLocation == StandaloneModrinthManager.InstallLocation.PROFILE, 150)) {
                    pendingInstallLocation = StandaloneModrinthManager.InstallLocation.PROFILE;
                }
                ImGui.sameLine();
                if (channelStyleButton("Early loading /mods", pendingInstallLocation == StandaloneModrinthManager.InstallLocation.GLOBAL, 170)) {
                    pendingInstallLocation = StandaloneModrinthManager.InstallLocation.GLOBAL;
                }
                ImGui.textDisabled(pendingInstallLocation == StandaloneModrinthManager.InstallLocation.GLOBAL
                    ? "Loaded natively and available to every profile in this Minecraft instance."
                    : "Isolated to this Impulse server profile.");
            }
            ImGui.spacing();
            ImGui.beginDisabled(pendingInstallPlan == null || modBusy);
            if (primaryButton("Install", 112, 32)) {
                ImGui.closeCurrentPopup();
                installPendingPlan();
            }
            ImGui.endDisabled();
            ImGui.sameLine();
            if (outlineButton("Cancel", 112, 32)) {
                pendingInstallPlan = null;
                ImGui.closeCurrentPopup();
            }
            ImGui.endPopup();
        }

        if (openRemoveConfirmation) {
            ImGui.openPopup("Remove custom mod?");
            openRemoveConfirmation = false;
        }
        ImGui.setNextWindowSize(430, 0, ImGuiCond.Appearing);
        if (ImGui.beginPopupModal("Remove custom mod?", ImGuiWindowFlags.AlwaysAutoResize)) {
            ImpulseStandaloneBootstrap.CustomModEntry entry = installedEntry(removeCustomProjectId);
            ImGui.textWrapped("Remove " + (entry == null ? "this mod" : clean(entry.name, entry.file_name))
                + " and dependencies that are no longer needed?");
            ImGui.spacing();
            if (primaryButton("Remove", 110, 32)) {
                ImGui.closeCurrentPopup();
                removeCustomMod();
            }
            ImGui.sameLine();
            if (outlineButton("Cancel", 110, 32)) ImGui.closeCurrentPopup();
            ImGui.endPopup();
        }

        if (openRelationshipError) {
            ImGui.openPopup("Optional mod conflict");
            openRelationshipError = false;
        }
        ImGui.setNextWindowSize(460, 0, ImGuiCond.Appearing);
        if (ImGui.beginPopupModal("Optional mod conflict", ImGuiWindowFlags.AlwaysAutoResize)) {
            ImGui.textWrapped(relationshipError);
            ImGui.spacing();
            if (primaryButton("OK", 100, 30)) ImGui.closeCurrentPopup();
            ImGui.endPopup();
        }

        if (openIncompatibleWarning) {
            ImGui.openPopup("Incompatible global mods");
            openIncompatibleWarning = false;
        }
        ImGui.setNextWindowSize(540, 0, ImGuiCond.Appearing);
        if (ImGui.beginPopupModal("Incompatible global mods", ImGuiWindowFlags.AlwaysAutoResize)) {
            ImGui.textWrapped("Some mods in /mods are incompatible with this server profile. You can temporarily skip them for this launch.");
            ImGui.spacing();
            for (StandaloneModrinthManager.GlobalModInfo mod : incompatibleGlobalMods) {
                ImGui.textColored(1.0F, 0.34F, 0.34F, 1.0F, clean(mod.name, mod.file_name));
                ImGui.indent(14);
                ImGui.textWrapped(clean(mod.reason, mod.file_name));
                ImGui.unindent(14);
            }
            ImGui.spacing();
            if (primaryButton("Skip and play", 150, 32)) {
                try {
                    List<String> files = new ArrayList<>();
                    for (StandaloneModrinthManager.GlobalModInfo mod : incompatibleGlobalMods) files.add(mod.file_name);
                    ImpulseStandaloneBootstrap.stageSkippedGlobalMods(gameDirectory(), files);
                    ImGui.closeCurrentPopup();
                    completeSelection(pendingLaunchProfileId);
                } catch (Exception error) {
                    status = clean(error.getMessage(), "Could not temporarily skip incompatible mods.");
                }
            }
            ImGui.sameLine();
            if (outlineButton("Go back", 120, 32)) {
                pendingLaunchProfileId = null;
                ImGui.closeCurrentPopup();
            }
            ImGui.endPopup();
        }

        if (openDeleteConfirmation) {
            ImGui.openPopup("Delete profile?");
            openDeleteConfirmation = false;
        }
        ImGui.setNextWindowSize(430, 0, ImGuiCond.Appearing);
        if (ImGui.beginPopupModal("Delete profile?", ImGuiWindowFlags.AlwaysAutoResize)) {
            ImGui.textWrapped("This removes the standalone profile and its managed mod files. Your global mods folder is not changed.");
            ImGui.spacing();
            if (primaryButton("Delete", 110, 32)) {
                deleteSelectedProfile();
                ImGui.closeCurrentPopup();
            }
            ImGui.sameLine();
            if (outlineButton("Cancel", 110, 32)) ImGui.closeCurrentPopup();
            ImGui.endPopup();
        }
    }

    private void renderGalleryLightbox() {
        if (openGalleryLightbox) {
            ImGui.openPopup("Mod gallery");
            openGalleryLightbox = false;
        }
        float displayWidth = ImGui.getIO().getDisplaySizeX();
        float displayHeight = ImGui.getIO().getDisplaySizeY();
        ImGui.setNextWindowSize(Math.max(520.0F, displayWidth * 0.82F), Math.max(400.0F, displayHeight * 0.84F), ImGuiCond.Appearing);
        if (!ImGui.beginPopupModal("Mod gallery", ImGuiWindowFlags.NoResize)) return;
        if (selectedModDetails == null || selectedModDetails.gallery.isEmpty()) {
            ImGui.textDisabled("No gallery image is available.");
            if (outlineButton("Close", 100, 30)) ImGui.closeCurrentPopup();
            ImGui.endPopup();
            return;
        }
        lightboxIndex = Math.max(0, Math.min(lightboxIndex, selectedModDetails.gallery.size() - 1));
        if (ImGui.isKeyPressed(ImGuiKey.LeftArrow)) lightboxIndex = (lightboxIndex - 1 + selectedModDetails.gallery.size()) % selectedModDetails.gallery.size();
        if (ImGui.isKeyPressed(ImGuiKey.RightArrow)) lightboxIndex = (lightboxIndex + 1) % selectedModDetails.gallery.size();
        if (ImGui.isKeyPressed(ImGuiKey.Escape)) ImGui.closeCurrentPopup();

        StandaloneModrinthManager.GalleryImage image = selectedModDetails.gallery.get(lightboxIndex);
        AsyncImageCache.Texture texture = imageCache == null ? null : imageCache.request(image.url, 1280);
        float imageWidth = Math.max(300.0F, ImGui.getContentRegionAvailX());
        float imageHeight = Math.max(220.0F, ImGui.getContentRegionAvailY() - 78.0F);
        renderFixedImage("##lightbox-image", texture, imageWidth, imageHeight, "Loading image...", false);
        String caption = clean(image.title, image.description);
        if (caption != null && !caption.isBlank()) ImGui.textWrapped(caption);
        ImGui.textDisabled((lightboxIndex + 1) + " / " + selectedModDetails.gallery.size());
        ImGui.sameLine();
        ImGui.beginDisabled(selectedModDetails.gallery.size() < 2);
        if (outlineButton("Previous", 100, 28)) lightboxIndex = (lightboxIndex - 1 + selectedModDetails.gallery.size()) % selectedModDetails.gallery.size();
        ImGui.sameLine();
        if (outlineButton("Next", 100, 28)) lightboxIndex = (lightboxIndex + 1) % selectedModDetails.gallery.size();
        ImGui.endDisabled();
        ImGui.sameLine();
        if (primaryButton("Close", 100, 28)) ImGui.closeCurrentPopup();
        ImGui.endPopup();
    }

    private void selectProfile(ImpulseStandaloneBootstrap.Profile profile) {
        selectedProfile = profile;
        manifest = ImpulseStandaloneBootstrap.loadCachedManifest(gameDirectory(), profile);
        selectedOptional.clear();
        if (profile.selected_optional_ids != null) selectedOptional.addAll(profile.selected_optional_ids);
        discovery = null;
        editorOpen = false;
        customModsOpen = false;
        status = "Ready to check and load " + clean(profile.name, profile.address) + ".";
    }

    private void openAddServer() {
        editorOpen = true;
        discovery = null;
        manifest = null;
        selectedOptional.clear();
        address.clear();
        status = "Enter the Minecraft server address.";
    }

    private void closeEditor() {
        editorOpen = false;
        discovery = null;
        if (selectedProfile == null && !store.profiles.isEmpty()) selectProfile(store.profiles.get(0));
    }

    private void checkNewServer() {
        runDiscovery(address.get().trim(), AsyncAction.EDIT, null);
    }

    private void refreshProfile(boolean edit) {
        if (selectedProfile == null) return;
        runDiscovery(selectedProfile.address, edit ? AsyncAction.EDIT : AsyncAction.REFRESH, selectedProfile);
    }

    private void playProfile() {
        if (selectedProfile == null) return;
        runDiscovery(selectedProfile.address, AsyncAction.PLAY, selectedProfile);
    }

    private void runDiscovery(String serverAddress, AsyncAction action, ImpulseStandaloneBootstrap.Profile profile) {
        if (busy) return;
        busy = true;
        status = "Checking " + serverAddress + " and its Impulse manifest...";
        Thread worker = new Thread(() -> {
            try {
                ImpulseStandaloneBootstrap.Discovery found = ImpulseStandaloneBootstrap.discover(serverAddress);
                ImpulseStandaloneBootstrap.validateRuntime(found.manifest, request.minecraft_version, request.loader, request.loader_version);
                ImpulseStandaloneBootstrap.Profile preparedProfile = profile;
                if (action == AsyncAction.PLAY && preparedProfile != null) {
                    List<String> selections = preparedProfile.selected_optional_ids == null ? Collections.emptyList() : preparedProfile.selected_optional_ids;
                    preparedProfile = ImpulseStandaloneBootstrap.prepareProfileForLaunch(gameDirectory(), found, selections);
                }
                asyncResult = AsyncResult.success(action, preparedProfile, found);
            } catch (Throwable error) {
                asyncResult = AsyncResult.failure(error);
            }
        }, "impulse-ui-discovery");
        worker.setDaemon(true);
        worker.start();
    }

    private void consumeAsyncResult() {
        AsyncResult result = asyncResult;
        if (result == null) return;
        asyncResult = null;
        busy = false;
        if (result.error != null) {
            status = clean(result.error.getMessage(), "Could not reach this Impulse server.");
            return;
        }
        discovery = result.discovery;
        manifest = discovery.manifest;
        if (result.action == AsyncAction.PLAY) {
            try {
                List<String> selections = result.profile.selected_optional_ids == null
                    ? Collections.emptyList() : result.profile.selected_optional_ids;
                List<ImpulseStandaloneBootstrap.ManifestMod> launchMods = ImpulseStandaloneBootstrap.launchMods(discovery.manifest, selections);
                ImpulseStandaloneBootstrap.requireSha512(launchMods);
                List<ImpulseStandaloneBootstrap.ManifestMod> problems = ImpulseStandaloneBootstrap.problematicMods(discovery.manifest, selections);
                String signature = ImpulseStandaloneBootstrap.problematicSignature(problems);
                if (!problems.isEmpty() && !signature.equals(result.profile.accepted_unverified_mod_signature)) {
                    pendingUnverifiedMods = problems;
                    pendingVerificationProfile = result.profile;
                    pendingVerificationDiscovery = discovery;
                    modVerificationReadyAt = System.currentTimeMillis() + 5000L;
                    openModVerificationWarning = true;
                    return;
                }
                finishSelected(result.profile.id);
            } catch (Exception error) {
                status = clean(error.getMessage(), "Could not save this profile.");
            }
            return;
        }
        if (result.profile != null) {
            selectedProfile = result.profile;
            selectedOptional.clear();
            if (result.profile.selected_optional_ids != null) selectedOptional.addAll(result.profile.selected_optional_ids);
        } else {
            selectedOptional.clear();
            selectedOptional.addAll(ImpulseStandaloneBootstrap.defaultOptionalIds(manifest));
        }
        if (result.action == AsyncAction.EDIT) {
            address.set(discovery.host + ":" + discovery.minecraftPort);
            editorOpen = true;
            status = "Manifest loaded. Review the optional mods before continuing.";
        } else {
            try {
                ImpulseStandaloneBootstrap.Profile saved = ImpulseStandaloneBootstrap.saveProfile(
                    gameDirectory(), discovery, new ArrayList<>(selectedOptional));
                selectedProfile = saved;
                editorOpen = false;
                reloadStore();
                status = "Manifest refreshed successfully.";
            } catch (Exception error) {
                status = clean(error.getMessage(), "The manifest was checked but could not be saved.");
            }
        }
    }

    private void saveAndPlay() {
        saveEditor(true);
    }

    private void saveEditor(boolean play) {
        if (discovery == null) return;
        try {
            ImpulseStandaloneBootstrap.effectiveOptionalIds(manifest, new ArrayList<>(selectedOptional));
            ImpulseStandaloneBootstrap.Profile saved = ImpulseStandaloneBootstrap.saveProfile(
                gameDirectory(), discovery, new ArrayList<>(selectedOptional));
            selectedProfile = saved;
            reloadStore();
            if (play) finishSelected(saved.id);
            else {
                editorOpen = false;
                selectProfile(findProfile(saved.id));
                status = "Profile saved. Select Play when you are ready.";
            }
        } catch (Exception error) {
            status = clean(error.getMessage(), "Could not save this profile.");
        }
    }

    private void applyOptionalSelection(Set<String> proposed) {
        try {
            ImpulseStandaloneBootstrap.effectiveOptionalIds(manifest, new ArrayList<>(proposed));
            selectedOptional.clear();
            selectedOptional.addAll(proposed);
        } catch (Exception error) {
            relationshipError = clean(error.getMessage(), "These optional mods cannot be enabled together.");
            openRelationshipError = true;
        }
    }

    private Set<String> effectiveOptional() {
        try {
            return new HashSet<>(ImpulseStandaloneBootstrap.effectiveOptionalIds(manifest, new ArrayList<>(selectedOptional)));
        } catch (Exception ignored) {
            return new HashSet<>(selectedOptional);
        }
    }

    private void deleteSelectedProfile() {
        if (deleteProfileId == null) return;
        try {
            ImpulseStandaloneBootstrap.deleteProfile(gameDirectory(), deleteProfileId);
            deleteProfileId = null;
            selectedProfile = null;
            manifest = null;
            reloadStore();
            if (!store.profiles.isEmpty()) selectProfile(store.profiles.get(0));
            else openAddServer();
            status = "Profile deleted.";
        } catch (Exception error) {
            status = clean(error.getMessage(), "Could not delete this profile.");
        }
    }

    private void finishSelected(String profileId) {
        if (profileId == null || modBusy) return;
        pendingLaunchProfileId = profileId;
        ImpulseStandaloneBootstrap.Profile profile = findProfile(profileId);
        if (profile == null) {
            status = "The selected profile could not be found.";
            pendingLaunchProfileId = null;
            return;
        }
        ImpulseStandaloneBootstrap.Manifest activeManifest = profile == null ? null
            : ImpulseStandaloneBootstrap.loadCachedManifest(gameDirectory(), profile);
        String minecraftVersion = activeManifest != null && activeManifest.minecraft != null
            ? clean(activeManifest.minecraft.version, request.minecraft_version) : request.minecraft_version;
        modrinth = new StandaloneModrinthManager(gameDirectory(), profile, minecraftVersion, "neoforge");
        status = "Checking global mods before launch...";
        runModTask(ModAction.PLAY_CHECK, "Checking global mods", () -> modrinth.globalMods());
    }

    private void completeSelection(String profileId) {
        completed = true;
        writeResult("selected", profileId, null);
        if (getWindow() instanceof WindowGlfw window) GLFW.glfwSetWindowShouldClose(window.getHandle(), true);
    }

    private void quitMinecraft() {
        completed = true;
        writeResult("quit", null, null);
        if (getWindow() instanceof WindowGlfw window) GLFW.glfwSetWindowShouldClose(window.getHandle(), true);
    }

    private void reloadStore() {
        store = ImpulseStandaloneBootstrap.loadStore(gameDirectory());
        if (store.profiles == null) store.profiles = new ArrayList<>();
        if (selectedProfile != null) selectedProfile = findProfile(selectedProfile.id);
        if (selectedProfile == null && store.active_profile_id != null) selectedProfile = findProfile(store.active_profile_id);
        if (selectedProfile == null && !store.profiles.isEmpty()) selectedProfile = store.profiles.get(0);
        if (selectedProfile != null && !editorOpen) selectProfile(selectedProfile);
    }

    private ImpulseStandaloneBootstrap.Profile findProfile(String id) {
        if (id == null) return null;
        for (ImpulseStandaloneBootstrap.Profile profile : store.profiles) if (profile != null && id.equals(profile.id)) return profile;
        return null;
    }

    private boolean knownCategory(String id) {
        if (id == null || id.isEmpty()) return false;
        for (ImpulseStandaloneBootstrap.OptionalCategory category : manifest.optional_mod_categories) {
            if (id.equals(normalize(category.id))) return true;
        }
        return false;
    }

    private void detailLine(String label, String value) {
        ImGui.textDisabled(label);
        ImGui.sameLine(150);
        ImGui.text(clean(value, "Unknown"));
    }

    private boolean primaryButton(String label, float width, float height) {
        ImGui.pushStyleColor(ImGuiCol.Button, 0.96F, 0.96F, 0.96F, 1.0F);
        ImGui.pushStyleColor(ImGuiCol.ButtonHovered, 1.0F, 1.0F, 1.0F, 1.0F);
        ImGui.pushStyleColor(ImGuiCol.ButtonActive, 0.82F, 0.82F, 0.82F, 1.0F);
        ImGui.pushStyleColor(ImGuiCol.Text, 0.04F, 0.04F, 0.04F, 1.0F);
        boolean clicked = ImGui.button(label, width, height);
        ImGui.popStyleColor(4);
        return clicked;
    }

    private boolean outlineButton(String label, float width, float height) {
        ImGui.pushStyleColor(ImGuiCol.Button, 0.09F, 0.09F, 0.09F, 0.92F);
        ImGui.pushStyleColor(ImGuiCol.ButtonHovered, 0.18F, 0.18F, 0.18F, 1.0F);
        ImGui.pushStyleColor(ImGuiCol.ButtonActive, 0.24F, 0.24F, 0.24F, 1.0F);
        boolean clicked = ImGui.button(label, width, height);
        ImGui.popStyleColor(3);
        return clicked;
    }

    private boolean updateChannelButton(String label, String channel, float width) {
        if (!channel.equals(updateChannel)) return outlineButton(label + "##updates-" + channel, width, 28);
        ImGui.pushStyleColor(ImGuiCol.Button, 0.82F, 0.82F, 0.82F, 1.0F);
        ImGui.pushStyleColor(ImGuiCol.ButtonHovered, 0.92F, 0.92F, 0.92F, 1.0F);
        ImGui.pushStyleColor(ImGuiCol.Text, 0.04F, 0.04F, 0.04F, 1.0F);
        boolean clicked = ImGui.button(label + "##updates-" + channel, width, 28);
        ImGui.popStyleColor(3);
        return clicked;
    }

    private static void applyStyle() {
        ImGui.styleColorsDark();
        ImGuiStyle style = ImGui.getStyle();
        style.setWindowRounding(0);
        style.setChildRounding(6);
        style.setPopupRounding(6);
        style.setFrameRounding(5);
        style.setScrollbarRounding(5);
        style.setWindowPadding(20, 18);
        style.setFramePadding(10, 7);
        style.setItemSpacing(10, 8);
        style.setChildBorderSize(1);
        style.setFrameBorderSize(1);
        style.setColor(ImGuiCol.Text, 0.95F, 0.95F, 0.95F, 1.0F);
        style.setColor(ImGuiCol.TextDisabled, 0.58F, 0.58F, 0.58F, 1.0F);
        style.setColor(ImGuiCol.WindowBg, 0.018F, 0.018F, 0.018F, 1.0F);
        style.setColor(ImGuiCol.PopupBg, 0.025F, 0.025F, 0.025F, 1.0F);
        style.setColor(ImGuiCol.TitleBg, 0.025F, 0.025F, 0.025F, 1.0F);
        style.setColor(ImGuiCol.TitleBgActive, 0.025F, 0.025F, 0.025F, 1.0F);
        style.setColor(ImGuiCol.TitleBgCollapsed, 0.025F, 0.025F, 0.025F, 1.0F);
        style.setColor(ImGuiCol.ModalWindowDimBg, 0.0F, 0.0F, 0.0F, 0.72F);
        style.setColor(ImGuiCol.Border, 0.28F, 0.28F, 0.28F, 0.75F);
        style.setColor(ImGuiCol.ChildBg, 0.025F, 0.025F, 0.025F, 0.82F);
        style.setColor(ImGuiCol.FrameBg, 0.08F, 0.08F, 0.08F, 0.96F);
        style.setColor(ImGuiCol.FrameBgHovered, 0.13F, 0.13F, 0.13F, 1.0F);
        style.setColor(ImGuiCol.Header, 0.16F, 0.16F, 0.16F, 1.0F);
        style.setColor(ImGuiCol.HeaderHovered, 0.22F, 0.22F, 0.22F, 1.0F);
        style.setColor(ImGuiCol.HeaderActive, 0.28F, 0.28F, 0.28F, 1.0F);
        style.setColor(ImGuiCol.CheckMark, 1.0F, 1.0F, 1.0F, 1.0F);
    }

    private static int loadTexture(File file) {
        if (file == null || !file.isFile()) return 0;
        try {
            BufferedImage image = ImageIO.read(file);
            if (image == null) return 0;
            int width = image.getWidth();
            int height = image.getHeight();
            ByteBuffer pixels = BufferUtils.createByteBuffer(width * height * 4);
            for (int y = height - 1; y >= 0; y--) {
                for (int x = 0; x < width; x++) {
                    int argb = image.getRGB(x, y);
                    pixels.put((byte) ((argb >> 16) & 0xFF));
                    pixels.put((byte) ((argb >> 8) & 0xFF));
                    pixels.put((byte) (argb & 0xFF));
                    pixels.put((byte) ((argb >> 24) & 0xFF));
                }
            }
            pixels.flip();
            int texture = GL11.glGenTextures();
            GL11.glBindTexture(GL11.GL_TEXTURE_2D, texture);
            GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_MIN_FILTER, GL11.GL_LINEAR);
            GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_MAG_FILTER, GL11.GL_LINEAR);
            GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_WRAP_S, GL12.GL_CLAMP_TO_EDGE);
            GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_WRAP_T, GL12.GL_CLAMP_TO_EDGE);
            GL11.glTexImage2D(GL11.GL_TEXTURE_2D, 0, GL11.GL_RGBA8, width, height, 0, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, pixels);
            GL11.glBindTexture(GL11.GL_TEXTURE_2D, 0);
            return texture;
        } catch (Throwable error) {
            System.out.println("[Impulse UI] Could not load " + file.getName() + ": " + error.getMessage());
            return 0;
        }
    }

    private void heartbeat() {
        long now = System.currentTimeMillis();
        if (now - lastHeartbeat < 500L) return;
        writeSignal("heartbeat");
        lastHeartbeat = now;
    }

    private void writeSignal(String name) {
        try {
            File file = new File(request.session_directory, name);
            Files.writeString(file.toPath(), String.valueOf(System.currentTimeMillis()), StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        } catch (Exception error) {
            System.out.println("[Impulse UI] Could not update " + name + ": " + error.getMessage());
        }
    }

    private void writeResult(String state, String profileId, Throwable error) {
        try {
            ImpulseStandaloneBootstrap.UiResult result = new ImpulseStandaloneBootstrap.UiResult();
            result.status = state;
            result.profile_id = profileId;
            result.error = error == null ? null : clean(error.getMessage(), error.getClass().getSimpleName());
            File target = new File(request.session_directory, "result.json");
            File temporary = new File(request.session_directory, "result.json.tmp");
            Files.writeString(temporary.toPath(), GSON.toJson(result), StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            try {
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (Exception ignored) {
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (Exception writeError) {
            System.out.println("[Impulse UI] Could not write selector result: " + writeError.getMessage());
        }
    }

    private static void writeEmergencyResult(File requestFile, Throwable error) {
        try {
            ImpulseStandaloneBootstrap.UiRequest parsed = request;
            if (parsed == null && requestFile.isFile()) {
                parsed = GSON.fromJson(Files.readString(requestFile.toPath(), StandardCharsets.UTF_8), ImpulseStandaloneBootstrap.UiRequest.class);
            }
            if (parsed == null || parsed.session_directory == null) return;
            ImpulseStandaloneBootstrap.UiResult result = new ImpulseStandaloneBootstrap.UiResult();
            result.status = "error";
            result.error = clean(error.getMessage(), error.getClass().getSimpleName());
            Files.writeString(new File(parsed.session_directory, "result.json").toPath(), GSON.toJson(result), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
        }
    }

    private File gameDirectory() {
        return new File(request.game_directory);
    }

    private static File systemFont() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        List<File> candidates = new ArrayList<>();
        if (os.contains("mac")) {
            candidates.add(new File("/System/Library/Fonts/SFNS.ttf"));
            candidates.add(new File("/System/Library/Fonts/Helvetica.ttc"));
        } else if (os.contains("win")) {
            candidates.add(new File(System.getenv().getOrDefault("WINDIR", "C:\\Windows"), "Fonts\\segoeui.ttf"));
            candidates.add(new File(System.getenv().getOrDefault("WINDIR", "C:\\Windows"), "Fonts\\arial.ttf"));
        } else {
            candidates.add(new File("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"));
            candidates.add(new File("/usr/share/fonts/TTF/DejaVuSans.ttf"));
        }
        for (File file : candidates) if (file.isFile()) return file;
        return null;
    }

    private static String loaderLabel(ImpulseStandaloneBootstrap.Manifest manifest) {
        if (manifest == null || manifest.minecraft == null) return "Unknown";
        String loader = clean(manifest.minecraft.loader, "NeoForge");
        if ("neoforge".equalsIgnoreCase(loader)) loader = "NeoForge";
        else if ("forge".equalsIgnoreCase(loader)) loader = "Forge";
        return loader + " " + clean(manifest.minecraft.loader_version, "");
    }

    private static String shortDescription(String value) {
        String clean = value == null ? "" : value.trim().replaceAll("\\s+", " ");
        return clean.length() <= 240 ? clean : clean.substring(0, 237) + "...";
    }

    private static String formatBytes(long bytes) {
        if (bytes < 1024) return bytes + " B";
        double value = bytes;
        String[] units = { "KB", "MB", "GB" };
        int unit = -1;
        do { value /= 1024.0; unit++; } while (value >= 1024.0 && unit < units.length - 1);
        return String.format(Locale.ROOT, value >= 100 ? "%.0f %s" : "%.1f %s", value, units[unit]);
    }

    private static String compactNumber(long value) {
        if (value >= 1_000_000) return String.format(Locale.ROOT, "%.1fM", value / 1_000_000.0);
        if (value >= 1_000) return String.format(Locale.ROOT, "%.1fK", value / 1_000.0);
        return String.valueOf(value);
    }

    private static String formatDate(String value) {
        if (value == null || value.isBlank()) return "Unknown date";
        return value.length() >= 10 ? value.substring(0, 10) : value;
    }

    private static String fitText(String value, float width) {
        if (value == null || ImGui.calcTextSizeX(value) <= width) return value;
        String suffix = "...";
        int end = value.length();
        while (end > 0 && ImGui.calcTextSizeX(value.substring(0, end) + suffix) > width) end--;
        return value.substring(0, end) + suffix;
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }

    private static String clean(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }

    private enum AsyncAction {
        EDIT,
        REFRESH,
        PLAY
    }

    private enum ModsView {
        INSTALLED,
        SEARCH,
        PROJECT,
        VERSIONS
    }

    private enum ModAction {
        SEARCH,
        PROJECT,
        PLAN,
        UPDATES,
        INSTALL,
        REPAIR,
        REMOVE,
        GLOBAL,
        CATALOG,
        PLAY_CHECK
    }

    private static final class ProjectPayload {
        final StandaloneModrinthManager.ProjectDetails details;
        final List<StandaloneModrinthManager.ProjectVersion> versions;

        ProjectPayload(StandaloneModrinthManager.ProjectDetails details, List<StandaloneModrinthManager.ProjectVersion> versions) {
            this.details = details;
            this.versions = versions;
        }
    }

    private static final class ModAsyncResult {
        final ModAction action;
        final Object value;
        final Throwable error;

        private ModAsyncResult(ModAction action, Object value, Throwable error) {
            this.action = action;
            this.value = value;
            this.error = error;
        }

        static ModAsyncResult success(ModAction action, Object value) { return new ModAsyncResult(action, value, null); }
        static ModAsyncResult failure(ModAction action, Throwable error) { return new ModAsyncResult(action, null, error); }
    }

    private static final class AsyncResult {
        final AsyncAction action;
        final ImpulseStandaloneBootstrap.Profile profile;
        final ImpulseStandaloneBootstrap.Discovery discovery;
        final Throwable error;

        private AsyncResult(AsyncAction action, ImpulseStandaloneBootstrap.Profile profile,
                            ImpulseStandaloneBootstrap.Discovery discovery, Throwable error) {
            this.action = action;
            this.profile = profile;
            this.discovery = discovery;
            this.error = error;
        }

        static AsyncResult success(AsyncAction action, ImpulseStandaloneBootstrap.Profile profile,
                                   ImpulseStandaloneBootstrap.Discovery discovery) {
            return new AsyncResult(action, profile, discovery, null);
        }

        static AsyncResult failure(Throwable error) {
            return new AsyncResult(null, null, null, error);
        }
    }
}
