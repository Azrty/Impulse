package com.impulse.forge121;

import com.impulse.common.ImpulseRpcReporter;
import com.mojang.blaze3d.platform.NativeImage;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Renderable;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen;
import net.minecraft.client.gui.screens.options.OptionsScreen;
import net.minecraft.client.gui.screens.worldselection.SelectWorldScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraftforge.client.event.ScreenEvent;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.InputStream;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;

public final class ImpulseClient121 {
    private static boolean autoConnectConsumed;

    private ImpulseClient121() {
    }

    public static void register() {
        MinecraftForge.EVENT_BUS.register(new ImpulseClient121());
    }

    @SubscribeEvent
    public void onScreenOpening(ScreenEvent.Opening event) {
        if (!isImpulseLaunch() || !menuEnabled()) return;
        if (event.getNewScreen() instanceof TitleScreen || (event.getNewScreen() instanceof JoinMultiplayerScreen && !multiplayerEnabled())) {
            if (!(event.getNewScreen() instanceof ClassicImpulseScreen)) {
                event.setNewScreen(menuScreen());
            }
        }
    }

    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent.Post event) {
        if (!isImpulseLaunch()) return;
        Minecraft minecraft = Minecraft.getInstance();
        reportRpc(minecraft);
        if (!menuEnabled()) return;
        if ((minecraft.screen instanceof JoinMultiplayerScreen && !multiplayerEnabled()) || (minecraft.screen instanceof TitleScreen && !(minecraft.screen instanceof ClassicImpulseScreen))) {
            minecraft.setScreen(menuScreen());
        }
    }

    private static boolean isImpulseLaunch() {
        return Boolean.parseBoolean(System.getProperty("impulse.client", "false"));
    }

    private static String address() {
        return System.getProperty("impulse.server.address", "").trim();
    }

    private static int port() {
        try {
            return Integer.parseInt(System.getProperty("impulse.server.port", "25565").trim());
        } catch (Exception ignored) {
            return 25565;
        }
    }

    private static boolean autoConnect() {
        return Boolean.parseBoolean(System.getProperty("impulse.auto_connect", "false"));
    }

    private static boolean menuEnabled() {
        return Boolean.parseBoolean(System.getProperty("impulse.menu.enabled", "true"));
    }

    private static boolean classicMenu() {
        return "classic".equalsIgnoreCase(System.getProperty("impulse.menu.skin", "default").trim());
    }

    private static String menuTitle() {
        return stringProperty("impulse.menu.title", "IMPULSE");
    }

    private static String menuSubtitle() {
        return stringProperty("impulse.menu.subtitle", "A focused way into your server");
    }

    private static String serverName() {
        return stringProperty("impulse.server.name", "Impulse Server");
    }

    private static boolean hideServerNameFromPlayButton() {
        return Boolean.parseBoolean(System.getProperty("impulse.menu.hide_server_name_from_play_button",
            System.getProperty("impulse.menu.hideServerNameFromPlayButton", "false")));
    }

    private static boolean singleplayerEnabled() {
        return Boolean.parseBoolean(System.getProperty("impulse.menu.singleplayer_enabled",
            System.getProperty("impulse.menu.singleplayerEnabled", "false")));
    }

    private static boolean singleplayerRequested() {
        return singleplayerEnabled() && Screen.hasShiftDown();
    }

    private static boolean multiplayerEnabled() {
        return Boolean.parseBoolean(System.getProperty("impulse.menu.multiplayer_enabled",
            System.getProperty("impulse.menu.multiplayerEnabled", "false")));
    }

    private static boolean multiplayerRequested() {
        return multiplayerEnabled() && Screen.hasControlDown();
    }

    private static String stringProperty(String key, String fallback) {
        String value = System.getProperty(key, "").trim();
        return value.length() == 0 ? fallback : value;
    }

    private static boolean shouldAutoConnect() {
        if (!autoConnect()) return false;
        if (autoConnectConsumed) return false;
        autoConnectConsumed = true;
        return true;
    }

    private static Screen menuScreen() {
        return classicMenu() ? new ClassicImpulseScreen() : new ImpulseScreen();
    }

    private static void quitGame() {
        Minecraft.getInstance().stop();
    }

    private static void openSingleplayer(Screen parent) {
        Minecraft.getInstance().setScreen(new SelectWorldScreen(parent));
    }

    private static void openMultiplayer(Screen parent) {
        Minecraft.getInstance().setScreen(new JoinMultiplayerScreen(parent));
    }

    private static void reportRpc(Minecraft minecraft) {
        if (minecraft == null) return;
        if (minecraft.level != null && minecraft.player != null) {
            ImpulseRpcReporter.report("playing", "In Game", currentDimension(minecraft), !minecraft.hasSingleplayerServer());
        } else if (minecraft.screen != null) {
            String screen = minecraft.screen instanceof ImpulseScreen || minecraft.screen instanceof ClassicImpulseScreen ? "Main Menu" : minecraft.screen.getClass().getSimpleName();
            ImpulseRpcReporter.report("menu", screen, "", false);
        } else {
            ImpulseRpcReporter.report("loading", "Loading", "", false);
        }
    }

    private static String currentDimension(Minecraft minecraft) {
        try {
            return minecraft.level.dimension().location().toString();
        } catch (Exception ignored) {
            return "";
        }
    }

    private static ResourceLocation location(String path) {
        return ResourceLocation.fromNamespaceAndPath("impulse", path);
    }

    private static final class ImpulseScreen extends Screen {
        private static final ResourceLocation LOGO = location("textures/gui/menu/logo.png");
        private static final int MAX_DYNAMIC_FRAMES = 36;

        private int frames = 720;
        private int fps = 24;
        private String frameExt = "jpg";
        private long openedAt;
        private String error;
        private int ticksOpen;
        private Button playButton;
        private final Map<Integer, ResourceLocation> dynamicFrames = new LinkedHashMap<Integer, ResourceLocation>(MAX_DYNAMIC_FRAMES, 0.75F, true);

        private ImpulseScreen() {
            super(Component.literal("Impulse"));
            this.openedAt = System.currentTimeMillis();
            loadMenuProperties();
        }

        protected void init() {
            int buttonWidth = 220;
            int buttonHeight = 32;
            int buttonGap = 42;
            int startY = buttonStartY(buttonHeight, buttonGap);
            this.playButton = new ImpulseButton(this.width / 2 - buttonWidth / 2, startY, buttonWidth, buttonHeight, playComponent(), true, new Button.OnPress() {
                public void onPress(Button button) {
                    if (multiplayerRequested()) {
                        openMultiplayer(ImpulseScreen.this);
                    } else if (singleplayerRequested()) {
                        openSingleplayer(ImpulseScreen.this);
                    } else {
                        connect();
                    }
                }
            });
            this.addRenderableWidget(this.playButton);
            this.addRenderableWidget(new ImpulseButton(this.width / 2 - buttonWidth / 2, startY + buttonGap, buttonWidth, buttonHeight, Component.literal("Options"), false, new Button.OnPress() {
                public void onPress(Button button) {
                    Minecraft minecraft = Minecraft.getInstance();
                    minecraft.setScreen(new OptionsScreen(ImpulseScreen.this, minecraft.options));
                }
            }));
            this.addRenderableWidget(new ImpulseButton(this.width / 2 - buttonWidth / 2, startY + buttonGap * 2, buttonWidth, buttonHeight, Component.literal("Quit"), false, new Button.OnPress() {
                public void onPress(Button button) {
                    quitGame();
                }
            }));
        }

        private void connect() {
            String host = address();
            if (host.length() == 0) {
                this.error = "No Impulse server address was provided by the launcher.";
                return;
            }
            this.error = null;
            int serverPort = port();
            String serverIp = host + ":" + serverPort;
            Minecraft minecraft = Minecraft.getInstance();
            ServerData serverData = new ServerData("Impulse", serverIp, ServerData.Type.OTHER);
            ImpulseRpcReporter.report("connecting", "Connecting", "", false);
            ConnectScreen.startConnecting(this, minecraft, ServerAddress.parseString(serverIp), serverData, false, null);
        }

        public void tick() {
            this.ticksOpen++;
            updatePlayButton();
            if (this.ticksOpen > 2 && shouldAutoConnect()) {
                connect();
            }
        }

        public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
            updatePlayButton();
            if (classicMenu()) {
                renderClassic(graphics, mouseX, mouseY, partialTick);
                return;
            }
            int startY = buttonStartY(32, 42);
            int sloganY = Math.min(Math.max(120, this.height / 2 - 36), startY - 32);
            sloganY = Math.max(62, sloganY);
            int titleY = Math.min(Math.max(72, this.height / 2 - 96), sloganY - 48);
            titleY = Math.max(34, titleY);
            drawAnimatedBackground(graphics);
            graphics.fillGradient(0, 0, this.width, this.height, 0x66000000, 0xDD000000);
            drawLogo(graphics, titleY);
            drawScaledCentered(graphics, menuTitle(), this.width / 2, titleY, titleScale(menuTitle()), 0xFFFFFFFF);
            graphics.drawCenteredString(this.font, menuSubtitle(), this.width / 2, sloganY, 0xC8FFFFFF);
            if (this.error != null) {
                graphics.drawCenteredString(this.font, this.error, this.width / 2, Math.min(startY - 14, sloganY + 20), 0xFFFFB8B8);
            }
            drawSingleplayerHint(graphics);
            for (Renderable renderable : this.renderables) {
                renderable.render(graphics, mouseX, mouseY, partialTick);
            }
        }

        private void renderClassic(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
            int startY = buttonStartY(32, 42);
            drawClassicBackground(graphics);
            int logoSize = Math.min(42, Math.max(28, this.height / 14));
            int logoY = Math.max(12, this.height / 8 - 16);
            graphics.blit(LOGO, this.width / 2 - logoSize / 2, logoY, logoSize, logoSize, 0.0F, 0.0F, 256, 256, 256, 256);
            int titleY = logoY + logoSize + 12;
            drawScaledCentered(graphics, menuTitle(), this.width / 2, titleY, Math.min(2.0F, titleScale(menuTitle())), 0xFFFFFFFF);
            graphics.drawCenteredString(this.font, menuSubtitle(), this.width / 2, titleY + 30, 0xFFCFCFCF);
            if (this.error != null) {
                graphics.drawCenteredString(this.font, this.error, this.width / 2, Math.max(titleY + 46, startY - 14), 0xFFFFB8B8);
            }
            for (Renderable renderable : this.renderables) {
                renderable.render(graphics, mouseX, mouseY, partialTick);
            }
        }

        private void updatePlayButton() {
            if (this.playButton != null) {
                this.playButton.setMessage(playComponent());
            }
        }

        private void drawSingleplayerHint(GuiGraphics graphics) {
            if (!singleplayerEnabled()) return;
            int panelWidth = 86;
            int panelHeight = 18;
            int x = Math.max(8, this.width - panelWidth - 10);
            int y = 8;
            graphics.fill(x, y, x + panelWidth, y + panelHeight, 0x44000000);
            graphics.fill(x, y, x + panelWidth, y + 1, 0x55FFFFFF);
            graphics.fill(x, y + panelHeight - 1, x + panelWidth, y + panelHeight, 0x33FFFFFF);
            graphics.fill(x, y, x + 1, y + panelHeight, 0x33FFFFFF);
            graphics.fill(x + panelWidth - 1, y, x + panelWidth, y + panelHeight, 0x33FFFFFF);
            graphics.drawString(this.font, "Shift", x + 8, y + 5, 0xCCFFFFFF, false);
            graphics.fill(x + 42, y + 4, x + 43, y + panelHeight - 4, 0x33FFFFFF);
            graphics.drawString(this.font, "SP", x + 52, y + 5, 0xFFFFFFFF, false);
        }

        public boolean isPauseScreen() {
            return false;
        }

        private void loadMenuProperties() {
            InputStream input = null;
            try {
                input = Minecraft.getInstance().getResourceManager().open(location("menu.properties"));
                Properties props = new Properties();
                props.load(input);
                this.frames = Math.max(1, Integer.parseInt(props.getProperty("frames", "720").trim()));
                this.fps = Math.max(1, Integer.parseInt(props.getProperty("fps", "24").trim()));
                String ext = props.getProperty("ext", "jpg").trim().toLowerCase(Locale.US);
                this.frameExt = "png".equals(ext) ? "png" : "jpg";
            } catch (Exception ignored) {
                this.frames = 720;
                this.fps = 24;
                this.frameExt = "jpg";
            } finally {
                if (input != null) {
                    try {
                        input.close();
                    } catch (Exception ignored) {
                    }
                }
            }
        }

        private void drawAnimatedBackground(GuiGraphics graphics) {
            int frame = (int) (((System.currentTimeMillis() - this.openedAt) * this.fps / 1000L) % this.frames);
            ResourceLocation texture = "jpg".equals(this.frameExt)
                ? dynamicFrame(frame)
                : location(String.format(Locale.US, "textures/gui/menu/bg_%03d.png", frame));
            if (texture == null) {
                graphics.fill(0, 0, this.width, this.height, 0xFF050505);
                return;
            }
            drawCoverTexture(graphics, texture);
        }

        private void drawClassicBackground(GuiGraphics graphics) {
            graphics.fillGradient(0, 0, this.width, this.height, 0xFF2A2A2A, 0xFF0E0E0E);
            int tile = 32;
            for (int y = 0; y < this.height; y += tile) {
                for (int x = 0; x < this.width; x += tile) {
                    int color = (((x / tile) + (y / tile)) & 1) == 0 ? 0x18000000 : 0x08000000;
                    graphics.fill(x, y, Math.min(x + tile, this.width), Math.min(y + tile, this.height), color);
                }
            }
            graphics.fillGradient(0, 0, this.width, this.height, 0x22000000, 0xB8000000);
        }

        private ResourceLocation dynamicFrame(int frame) {
            ResourceLocation existing = this.dynamicFrames.get(Integer.valueOf(frame));
            if (existing != null) return existing;
            try {
                ResourceLocation source = location(String.format(Locale.US, "textures/gui/menu/bg_%03d.jpg", frame));
                InputStream input = Minecraft.getInstance().getResourceManager().open(source);
                BufferedImage buffered;
                try {
                    buffered = ImageIO.read(input);
                } finally {
                    input.close();
                }
                if (buffered == null) return null;

                NativeImage image = new NativeImage(buffered.getWidth(), buffered.getHeight(), false);
                for (int y = 0; y < buffered.getHeight(); y++) {
                    for (int x = 0; x < buffered.getWidth(); x++) {
                        int argb = buffered.getRGB(x, y);
                        int a = (argb >> 24) & 255;
                        int r = (argb >> 16) & 255;
                        int g = (argb >> 8) & 255;
                        int b = argb & 255;
                        image.setPixelRGBA(x, y, (a << 24) | (b << 16) | (g << 8) | r);
                    }
                }
                ResourceLocation texture = location(String.format(Locale.US, "dynamic/menu/bg_%03d", frame));
                Minecraft.getInstance().getTextureManager().register(texture, new DynamicTexture(image));
                this.dynamicFrames.put(Integer.valueOf(frame), texture);
                trimDynamicFrames();
                return texture;
            } catch (Exception ignored) {
                return null;
            }
        }

        private void trimDynamicFrames() {
            while (this.dynamicFrames.size() > MAX_DYNAMIC_FRAMES) {
                Iterator<Map.Entry<Integer, ResourceLocation>> iterator = this.dynamicFrames.entrySet().iterator();
                if (!iterator.hasNext()) return;
                ResourceLocation texture = iterator.next().getValue();
                iterator.remove();
                Minecraft.getInstance().getTextureManager().release(texture);
            }
        }

        public void removed() {
            for (ResourceLocation texture : this.dynamicFrames.values()) {
                Minecraft.getInstance().getTextureManager().release(texture);
            }
            this.dynamicFrames.clear();
        }

        private void drawCoverTexture(GuiGraphics graphics, ResourceLocation texture) {
            double textureRatio = 16.0D / 9.0D;
            double screenRatio = (double) this.width / (double) this.height;
            int drawWidth = this.width;
            int drawHeight = this.height;
            int x = 0;
            int y = 0;
            if (screenRatio > textureRatio) {
                drawHeight = (int) Math.ceil(this.width / textureRatio);
                y = (this.height - drawHeight) / 2;
            } else {
                drawWidth = (int) Math.ceil(this.height * textureRatio);
                x = (this.width - drawWidth) / 2;
            }
            graphics.blit(texture, x, y, drawWidth, drawHeight, 0.0F, 0.0F, 960, 540, 960, 540);
        }

        private int buttonStartY(int buttonHeight, int buttonGap) {
            if (classicMenu()) {
                int desired = this.height / 4 + 96;
                int maxStart = this.height - buttonGap * 2 - buttonHeight - 18;
                return Math.max(104, Math.min(desired, maxStart));
            }
            int desired = Math.max(176, this.height / 2 + 48);
            int maxStart = this.height - buttonGap * 2 - buttonHeight - 14;
            return Math.max(88, Math.min(desired, maxStart));
        }

        private void drawLogo(GuiGraphics graphics, int titleY) {
            if (titleY < 70) return;
            int size = Math.min(92, Math.max(48, this.height / 8));
            int y = Math.max(14, titleY - size - 24);
            graphics.blit(LOGO, this.width / 2 - size / 2, y, size, size, 0.0F, 0.0F, 256, 256, 256, 256);
        }

        private void drawScaledCentered(GuiGraphics graphics, String text, int centerX, int y, float scale, int color) {
            graphics.pose().pushPose();
            graphics.pose().scale(scale, scale, 1.0F);
            int scaledX = (int) ((centerX - this.font.width(text) * scale / 2.0F) / scale);
            graphics.drawString(this.font, text, scaledX, (int) (y / scale), color, false);
            graphics.pose().popPose();
        }

        private float titleScale(String text) {
            int available = Math.max(80, this.width - 48);
            float desired = 3.2F;
            int textWidth = Math.max(1, this.font.width(text));
            return Math.max(1.2F, Math.min(desired, (float) available / (float) textWidth));
        }

        private Component playComponent() {
            if (multiplayerRequested()) return Component.literal("Multiplayer");
            if (singleplayerRequested()) return Component.literal("Singleplayer");
            if (hideServerNameFromPlayButton()) return Component.literal("Play");
            return Component.literal("Play ").append(Component.literal(serverName()).withStyle(ChatFormatting.BOLD));
        }
    }

    private static final class ClassicImpulseScreen extends TitleScreen {
        private static final ResourceLocation LOGO = location("textures/gui/menu/logo.png");
        private String error;
        private int ticksOpen;
        private Button playButton;

        protected void init() {
            super.init();
            this.clearWidgets();
            int buttonWidth = 200;
            int buttonHeight = 20;
            int buttonCount = 3 + (multiplayerEnabled() ? 1 : 0) + (singleplayerEnabled() ? 1 : 0);
            int startY = Math.max(72, Math.min(this.height / 4 + 72, this.height - buttonHeight - 24 * (buttonCount - 1) - 18));
            this.playButton = new ClassicButton(this.width / 2 - buttonWidth / 2, startY, buttonWidth, buttonHeight, playComponent(), new Button.OnPress() {
                public void onPress(Button button) {
                    connect();
                }
            });
            this.addRenderableWidget(this.playButton);
            int optionsY = startY + 24;
            if (multiplayerEnabled()) {
                this.addRenderableWidget(new ClassicButton(this.width / 2 - buttonWidth / 2, optionsY, buttonWidth, buttonHeight, Component.literal("Multiplayer"), new Button.OnPress() {
                    public void onPress(Button button) {
                        openMultiplayer(ClassicImpulseScreen.this);
                    }
                }));
                optionsY += 24;
            }
            if (singleplayerEnabled()) {
                this.addRenderableWidget(new ClassicButton(this.width / 2 - buttonWidth / 2, optionsY, buttonWidth, buttonHeight, Component.literal("Singleplayer"), new Button.OnPress() {
                    public void onPress(Button button) {
                        openSingleplayer(ClassicImpulseScreen.this);
                    }
                }));
                optionsY += 24;
            }
            this.addRenderableWidget(new ClassicButton(this.width / 2 - buttonWidth / 2, optionsY, buttonWidth, buttonHeight, Component.literal("Options"), new Button.OnPress() {
                public void onPress(Button button) {
                    Minecraft minecraft = Minecraft.getInstance();
                    minecraft.setScreen(new OptionsScreen(ClassicImpulseScreen.this, minecraft.options));
                }
            }));
            this.addRenderableWidget(new ClassicButton(this.width / 2 - buttonWidth / 2, optionsY + 24, buttonWidth, buttonHeight, Component.literal("Quit"), new Button.OnPress() {
                public void onPress(Button button) {
                    quitGame();
                }
            }));
        }

        public void tick() {
            super.tick();
            this.ticksOpen++;
            updatePlayButton();
            if (this.ticksOpen > 2 && shouldAutoConnect()) {
                connect();
            }
        }

        private void connect() {
            String host = address();
            if (host.length() == 0) {
                this.error = "No Impulse server address was provided by the launcher.";
                return;
            }
            this.error = null;
            int serverPort = port();
            String serverIp = host + ":" + serverPort;
            Minecraft minecraft = Minecraft.getInstance();
            ServerData serverData = new ServerData("Impulse", serverIp, ServerData.Type.OTHER);
            ImpulseRpcReporter.report("connecting", "Connecting", "", false);
            ConnectScreen.startConnecting(this, minecraft, ServerAddress.parseString(serverIp), serverData, false, null);
        }

        public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
            updatePlayButton();
            super.render(graphics, mouseX, mouseY, partialTick);
            graphics.blit(LOGO, 8, 8, 24, 24, 0.0F, 0.0F, 256, 256, 256, 256);
            if (this.error != null) {
                graphics.drawCenteredString(this.font, this.error, this.width / 2, this.height / 4 + 124, 0xFFFFB8B8);
            }
        }

        public boolean isPauseScreen() {
            return false;
        }

        private void updatePlayButton() {
            if (this.playButton != null) {
                this.playButton.setMessage(playComponent());
            }
        }

        private Component playComponent() {
            if (hideServerNameFromPlayButton()) return Component.literal("Play");
            return Component.literal("Play ").append(Component.literal(serverName()).withStyle(ChatFormatting.BOLD));
        }
    }

    private static final class ClassicButton extends Button {
        private ClassicButton(int x, int y, int width, int height, Component message, OnPress onPress) {
            super(x, y, width, height, message, onPress, DEFAULT_NARRATION);
        }
    }

    private static final class ImpulseButton extends Button {
        private final boolean primary;

        private ImpulseButton(int x, int y, int width, int height, Component message, boolean primary, OnPress onPress) {
            super(x, y, width, height, message, onPress, DEFAULT_NARRATION);
            this.primary = primary;
        }

        protected void renderWidget(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
            if (classicMenu()) {
                int top = this.isHoveredOrFocused() ? 0xFF9A9A9A : 0xFF6F6F6F;
                int bottom = this.isHoveredOrFocused() ? 0xFF777777 : 0xFF4C4C4C;
                int text = this.isHoveredOrFocused() ? 0xFFFFFFA0 : 0xFFFFFFFF;
                graphics.fillGradient(this.getX(), this.getY(), this.getX() + this.width, this.getY() + this.height, top, bottom);
                graphics.fill(this.getX(), this.getY(), this.getX() + this.width, this.getY() + 1, 0xFFFFFFFF);
                graphics.fill(this.getX(), this.getY(), this.getX() + 1, this.getY() + this.height, 0xFFFFFFFF);
                graphics.fill(this.getX(), this.getY() + this.height - 1, this.getX() + this.width, this.getY() + this.height, 0xFF202020);
                graphics.fill(this.getX() + this.width - 1, this.getY(), this.getX() + this.width, this.getY() + this.height, 0xFF202020);
                graphics.drawCenteredString(Minecraft.getInstance().font, this.getMessage(), this.getX() + this.width / 2, this.getY() + (this.height - 8) / 2, text);
                return;
            }
            int background = this.primary ? (this.isHoveredOrFocused() ? 0x8A000000 : 0x66000000) : (this.isHoveredOrFocused() ? 0x5C000000 : 0x38000000);
            int border = this.primary ? (this.isHoveredOrFocused() ? 0xFFFFFFFF : 0xCCFFFFFF) : (this.isHoveredOrFocused() ? 0xAAFFFFFF : 0x66FFFFFF);
            int text = 0xFFFFFFFF;
            graphics.fill(this.getX(), this.getY(), this.getX() + this.width, this.getY() + this.height, background);
            graphics.fill(this.getX(), this.getY(), this.getX() + this.width, this.getY() + 1, border);
            graphics.fill(this.getX(), this.getY() + this.height - 1, this.getX() + this.width, this.getY() + this.height, border);
            graphics.fill(this.getX(), this.getY(), this.getX() + 1, this.getY() + this.height, border);
            graphics.fill(this.getX() + this.width - 1, this.getY(), this.getX() + this.width, this.getY() + this.height, border);
            graphics.drawCenteredString(Minecraft.getInstance().font, this.getMessage(), this.getX() + this.width / 2, this.getY() + (this.height - 8) / 2, text);
        }
    }
}
