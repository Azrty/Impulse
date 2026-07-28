package com.impulse.forge112;

import com.impulse.common.ImpulseRpcReporter;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiButton;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraft.client.gui.GuiMultiplayer;
import net.minecraft.client.gui.GuiOptions;
import net.minecraft.client.gui.GuiScreen;
import net.minecraft.client.gui.GuiWorldSelection;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.renderer.BufferBuilder;
import net.minecraft.client.renderer.GlStateManager;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.client.renderer.vertex.DefaultVertexFormats;
import net.minecraft.util.ResourceLocation;
import net.minecraftforge.client.event.GuiOpenEvent;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.fml.client.FMLClientHandler;
import net.minecraftforge.fml.common.FMLCommonHandler;
import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;
import net.minecraftforge.fml.common.gameevent.TickEvent;
import org.lwjgl.input.Keyboard;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;
import java.util.Properties;

public final class ImpulseClient112 {
    private static boolean autoConnectConsumed;

    private ImpulseClient112() {
    }

    public static void register() {
        ImpulseClient112 client = new ImpulseClient112();
        MinecraftForge.EVENT_BUS.register(client);
        FMLCommonHandler.instance().bus().register(client);
    }

    @SubscribeEvent
    public void onGuiOpen(GuiOpenEvent event) {
        if (!isImpulseLaunch() || !menuEnabled()) return;
        if ((event.getGui() instanceof GuiMultiplayer && !multiplayerEnabled()) || (event.getGui() instanceof GuiMainMenu && !(event.getGui() instanceof ClassicImpulseMenu))) {
            event.setGui(menuScreen());
        }
    }

    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent event) {
        if (!isImpulseLaunch() || event.phase != TickEvent.Phase.END) return;
        Minecraft minecraft = Minecraft.getMinecraft();
        reportRpc(minecraft);
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
        return singleplayerEnabled() && (Keyboard.isKeyDown(Keyboard.KEY_LSHIFT) || Keyboard.isKeyDown(Keyboard.KEY_RSHIFT));
    }

    private static boolean multiplayerEnabled() {
        return Boolean.parseBoolean(System.getProperty("impulse.menu.multiplayer_enabled",
            System.getProperty("impulse.menu.multiplayerEnabled", "false")));
    }

    private static boolean multiplayerRequested() {
        return multiplayerEnabled() && (Keyboard.isKeyDown(Keyboard.KEY_LCONTROL) || Keyboard.isKeyDown(Keyboard.KEY_RCONTROL));
    }

    private static String stringProperty(String key, String fallback) {
        String value = System.getProperty(key, "").trim();
        return value.length() == 0 ? fallback : value;
    }

    private static boolean shouldAutoConnect() {
        if (!Boolean.parseBoolean(System.getProperty("impulse.auto_connect", "false"))) return false;
        if (autoConnectConsumed) return false;
        autoConnectConsumed = true;
        return true;
    }

    private static GuiScreen menuScreen() {
        return classicMenu() ? new ClassicImpulseMenu() : new ImpulseMenu();
    }

    private static void quitGame() {
        Minecraft.getMinecraft().shutdown();
    }

    private static void openSingleplayer(GuiScreen parent) {
        Minecraft.getMinecraft().displayGuiScreen(new GuiWorldSelection(parent));
    }

    private static void openMultiplayer(GuiScreen parent) {
        Minecraft.getMinecraft().displayGuiScreen(new GuiMultiplayer(parent));
    }

    private static void reportRpc(Minecraft minecraft) {
        if (minecraft == null) return;
        if (minecraft.world != null && minecraft.player != null) {
            ImpulseRpcReporter.report("playing", "In Game", currentDimension(minecraft), !minecraft.isSingleplayer());
        } else if (minecraft.currentScreen != null) {
            String screen = minecraft.currentScreen instanceof ImpulseMenu || minecraft.currentScreen instanceof ClassicImpulseMenu ? "Main Menu" : minecraft.currentScreen.getClass().getSimpleName();
            ImpulseRpcReporter.report("menu", screen, "", false);
        } else {
            ImpulseRpcReporter.report("loading", "Loading", "", false);
        }
    }

    private static String currentDimension(Minecraft minecraft) {
        try {
            return minecraft.world.provider.getDimensionType().getName();
        } catch (Exception ignored) {
            try {
                return "Dimension " + minecraft.world.provider.getDimension();
            } catch (Exception ignoredAgain) {
                return "";
            }
        }
    }

    private static final class ClassicImpulseMenu extends GuiMainMenu {
        private static final int PLAY = 1;
        private static final int OPTIONS = 2;
        private static final int QUIT = 3;
        private static final int SINGLEPLAYER = 4;
        private static final int MULTIPLAYER = 5;
        private static final ResourceLocation LOGO = new ResourceLocation("impulse", "textures/gui/menu/logo.png");

        private String error;
        private int ticksOpen;
        private GuiButton playButton;

        public void initGui() {
            super.initGui();
            this.buttonList.clear();
            int buttonWidth = 200;
            int buttonHeight = 20;
            int buttonCount = 3 + (multiplayerEnabled() ? 1 : 0) + (singleplayerEnabled() ? 1 : 0);
            int startY = Math.max(72, Math.min(this.height / 4 + 72, this.height - buttonHeight - 24 * (buttonCount - 1) - 18));
            this.playButton = new GuiButton(PLAY, this.width / 2 - buttonWidth / 2, startY, buttonWidth, buttonHeight, playLabel());
            this.buttonList.add(this.playButton);
            int optionsY = startY + 24;
            if (multiplayerEnabled()) {
                this.buttonList.add(new GuiButton(MULTIPLAYER, this.width / 2 - buttonWidth / 2, optionsY, buttonWidth, buttonHeight, "Multiplayer"));
                optionsY += 24;
            }
            if (singleplayerEnabled()) {
                this.buttonList.add(new GuiButton(SINGLEPLAYER, this.width / 2 - buttonWidth / 2, optionsY, buttonWidth, buttonHeight, "Singleplayer"));
                optionsY += 24;
            }
            this.buttonList.add(new GuiButton(OPTIONS, this.width / 2 - buttonWidth / 2, optionsY, buttonWidth, buttonHeight, "Options"));
            this.buttonList.add(new GuiButton(QUIT, this.width / 2 - buttonWidth / 2, optionsY + 24, buttonWidth, buttonHeight, "Quit"));
        }

        protected void actionPerformed(GuiButton button) throws IOException {
            if (button.id == PLAY) {
                connect();
            } else if (button.id == MULTIPLAYER) {
                openMultiplayer(this);
            } else if (button.id == SINGLEPLAYER) {
                openSingleplayer(this);
            } else if (button.id == OPTIONS) {
                this.mc.displayGuiScreen(new GuiOptions(this, this.mc.gameSettings));
            } else if (button.id == QUIT) {
                quitGame();
            }
        }

        public void updateScreen() {
            super.updateScreen();
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
            String serverIp = host + ":" + port();
            ImpulseRpcReporter.report("connecting", "Connecting", "", false);
            FMLClientHandler.instance().connectToServer(this, new ServerData("Impulse", serverIp, false));
        }

        public void drawScreen(int mouseX, int mouseY, float partialTicks) {
            updatePlayButton();
            super.drawScreen(mouseX, mouseY, partialTicks);
            drawLogoSmall();
            if (this.error != null) {
                drawCenteredString(this.fontRenderer, this.error, this.width / 2, this.height / 4 + 124, 0xFFFFB8B8);
            }
        }

        public boolean doesGuiPauseGame() {
            return false;
        }

        private String playLabel() {
            if (hideServerNameFromPlayButton()) return "Play";
            return "Play \u00A7l" + serverName();
        }

        private void updatePlayButton() {
            if (this.playButton != null) {
                this.playButton.displayString = playLabel();
            }
        }

        private void drawLogoSmall() {
            this.mc.getTextureManager().bindTexture(LOGO);
            GlStateManager.color(1.0F, 1.0F, 1.0F, 1.0F);
            Tessellator tessellator = Tessellator.getInstance();
            BufferBuilder buffer = tessellator.getBuffer();
            int x = 8;
            int y = 8;
            int size = 24;
            buffer.begin(7, DefaultVertexFormats.POSITION_TEX);
            buffer.pos(x, y + size, 0).tex(0, 1).endVertex();
            buffer.pos(x + size, y + size, 0).tex(1, 1).endVertex();
            buffer.pos(x + size, y, 0).tex(1, 0).endVertex();
            buffer.pos(x, y, 0).tex(0, 0).endVertex();
            tessellator.draw();
        }
    }

    private static final class ImpulseMenu extends GuiScreen {
        private static final int PLAY = 1;
        private static final int OPTIONS = 2;
        private static final int QUIT = 3;
        private static final ResourceLocation LOGO = new ResourceLocation("impulse", "textures/gui/menu/logo.png");

        private int frames = 720;
        private int fps = 24;
        private long openedAt;
        private String error;
        private int ticksOpen;
        private GuiButton playButton;

        private ImpulseMenu() {
            this.openedAt = System.currentTimeMillis();
            loadMenuProperties();
        }

        public void initGui() {
            this.buttonList.clear();
            int buttonWidth = 220;
            int buttonHeight = 31;
            int buttonGap = 42;
            int startY = buttonStartY(buttonHeight, buttonGap);
            this.playButton = new ImpulseButton(PLAY, this.width / 2 - buttonWidth / 2, startY, buttonWidth, buttonHeight, playLabel(), true);
            this.buttonList.add(this.playButton);
            this.buttonList.add(new ImpulseButton(OPTIONS, this.width / 2 - buttonWidth / 2, startY + buttonGap, buttonWidth, buttonHeight, "Options", false));
            this.buttonList.add(new ImpulseButton(QUIT, this.width / 2 - buttonWidth / 2, startY + buttonGap * 2, buttonWidth, buttonHeight, "Quit", false));
        }

        protected void actionPerformed(GuiButton button) throws IOException {
            if (button.id == PLAY) {
                if (multiplayerRequested()) {
                    openMultiplayer(this);
                } else if (singleplayerRequested()) {
                    openSingleplayer(this);
                } else {
                    connect();
                }
            } else if (button.id == OPTIONS) {
                this.mc.displayGuiScreen(new GuiOptions(this, this.mc.gameSettings));
            } else if (button.id == QUIT) {
                quitGame();
            }
        }

        public void updateScreen() {
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
            String serverIp = host + ":" + port();
            ImpulseRpcReporter.report("connecting", "Connecting", "", false);
            FMLClientHandler.instance().connectToServer(this, new ServerData("Impulse", serverIp, false));
        }

        public void drawScreen(int mouseX, int mouseY, float partialTicks) {
            updatePlayButton();
            if (classicMenu()) {
                drawClassicScreen(mouseX, mouseY, partialTicks);
                return;
            }
            int startY = buttonStartY(31, 42);
            int sloganY = Math.min(Math.max(120, this.height / 2 - 36), startY - 32);
            sloganY = Math.max(62, sloganY);
            int titleY = Math.min(Math.max(72, this.height / 2 - 96), sloganY - 48);
            titleY = Math.max(34, titleY);
            drawAnimatedBackground();
            drawGradientRect(0, 0, this.width, this.height, 0x66000000, 0xDD000000);
            drawLogo(titleY);
            drawScaledCentered(menuTitle(), this.width / 2, titleY, titleScale(menuTitle()), 0xFFFFFFFF);
            drawCenteredString(this.fontRenderer, menuSubtitle(), this.width / 2, sloganY, 0xC8FFFFFF);
            if (this.error != null) {
                drawCenteredString(this.fontRenderer, this.error, this.width / 2, Math.min(startY - 14, sloganY + 20), 0xFFFFB8B8);
            }
            drawSingleplayerHint();
            super.drawScreen(mouseX, mouseY, partialTicks);
        }

        private void drawClassicScreen(int mouseX, int mouseY, float partialTicks) {
            int startY = buttonStartY(31, 42);
            drawClassicBackground();
            int logoSize = Math.min(42, Math.max(28, this.height / 14));
            int logoY = Math.max(12, this.height / 8 - 16);
            drawTexture(LOGO, this.width / 2 - logoSize / 2, logoY, logoSize, logoSize);
            int titleY = logoY + logoSize + 12;
            drawScaledCentered(menuTitle(), this.width / 2, titleY, Math.min(2.0F, titleScale(menuTitle())), 0xFFFFFFFF);
            drawCenteredString(this.fontRenderer, menuSubtitle(), this.width / 2, titleY + 30, 0xFFCFCFCF);
            if (this.error != null) {
                drawCenteredString(this.fontRenderer, this.error, this.width / 2, Math.max(titleY + 46, startY - 14), 0xFFFFB8B8);
            }
            super.drawScreen(mouseX, mouseY, partialTicks);
        }

        public boolean doesGuiPauseGame() {
            return false;
        }

        private void loadMenuProperties() {
            InputStream input = null;
            try {
                input = Minecraft.getMinecraft().getResourceManager().getResource(new ResourceLocation("impulse", "menu.properties")).getInputStream();
                Properties props = new Properties();
                props.load(input);
                this.frames = Math.max(1, Integer.parseInt(props.getProperty("frames", "720").trim()));
                this.fps = Math.max(1, Integer.parseInt(props.getProperty("fps", "24").trim()));
            } catch (Exception ignored) {
                this.frames = 720;
                this.fps = 24;
            } finally {
                if (input != null) {
                    try {
                        input.close();
                    } catch (Exception ignored) {
                    }
                }
            }
        }

        private void drawAnimatedBackground() {
            int frame = (int) (((System.currentTimeMillis() - this.openedAt) * this.fps / 1000L) % this.frames);
            drawCoverTexture(new ResourceLocation("impulse", String.format(Locale.US, "textures/gui/menu/bg_%03d.jpg", frame)));
        }

        private void drawClassicBackground() {
            drawGradientRect(0, 0, this.width, this.height, 0xFF2A2A2A, 0xFF0E0E0E);
            int tile = 32;
            for (int y = 0; y < this.height; y += tile) {
                for (int x = 0; x < this.width; x += tile) {
                    int color = (((x / tile) + (y / tile)) & 1) == 0 ? 0x18000000 : 0x08000000;
                    drawRect(x, y, Math.min(x + tile, this.width), Math.min(y + tile, this.height), color);
                }
            }
            drawGradientRect(0, 0, this.width, this.height, 0x22000000, 0xB8000000);
        }

        private void drawCoverTexture(ResourceLocation texture) {
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
            drawTexture(texture, x, y, drawWidth, drawHeight);
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

        private void drawLogo(int titleY) {
            if (titleY < 70) return;
            int size = Math.min(92, Math.max(48, this.height / 8));
            int y = Math.max(14, titleY - size - 24);
            drawTexture(LOGO, this.width / 2 - size / 2, y, size, size);
        }

        private void drawTexture(ResourceLocation texture, int x, int y, int drawWidth, int drawHeight) {
            this.mc.getTextureManager().bindTexture(texture);
            GlStateManager.color(1.0F, 1.0F, 1.0F, 1.0F);
            Tessellator tessellator = Tessellator.getInstance();
            BufferBuilder buffer = tessellator.getBuffer();
            buffer.begin(7, DefaultVertexFormats.POSITION_TEX);
            buffer.pos(x, y + drawHeight, 0).tex(0, 1).endVertex();
            buffer.pos(x + drawWidth, y + drawHeight, 0).tex(1, 1).endVertex();
            buffer.pos(x + drawWidth, y, 0).tex(1, 0).endVertex();
            buffer.pos(x, y, 0).tex(0, 0).endVertex();
            tessellator.draw();
        }

        private void drawScaledCentered(String text, int centerX, int y, float scale, int color) {
            GlStateManager.pushMatrix();
            GlStateManager.scale(scale, scale, 1.0F);
            int scaledX = (int) ((centerX - this.fontRenderer.getStringWidth(text) * scale / 2.0F) / scale);
            drawString(this.fontRenderer, text, scaledX, (int) (y / scale), color);
            GlStateManager.popMatrix();
        }

        private float titleScale(String text) {
            int available = Math.max(80, this.width - 48);
            float desired = 3.2F;
            int textWidth = Math.max(1, this.fontRenderer.getStringWidth(text));
            return Math.max(1.2F, Math.min(desired, (float) available / (float) textWidth));
        }

        private String playLabel() {
            if (multiplayerRequested()) return "Multiplayer";
            if (singleplayerRequested()) return "Singleplayer";
            if (hideServerNameFromPlayButton()) return "Play";
            return "Play \u00A7l" + serverName();
        }

        private void updatePlayButton() {
            if (this.playButton != null) {
                this.playButton.displayString = playLabel();
            }
        }

        private void drawSingleplayerHint() {
            if (!singleplayerEnabled()) return;
            int panelWidth = 86;
            int panelHeight = 18;
            int x = Math.max(8, this.width - panelWidth - 10);
            int y = 8;
            drawRect(x, y, x + panelWidth, y + panelHeight, 0x44000000);
            drawRect(x, y, x + panelWidth, y + 1, 0x55FFFFFF);
            drawRect(x, y + panelHeight - 1, x + panelWidth, y + panelHeight, 0x33FFFFFF);
            drawRect(x, y, x + 1, y + panelHeight, 0x33FFFFFF);
            drawRect(x + panelWidth - 1, y, x + panelWidth, y + panelHeight, 0x33FFFFFF);
            drawString(this.fontRenderer, "Shift", x + 8, y + 5, 0xCCFFFFFF);
            drawRect(x + 42, y + 4, x + 43, y + panelHeight - 4, 0x33FFFFFF);
            drawString(this.fontRenderer, "SP", x + 52, y + 5, 0xFFFFFFFF);
        }
    }

    private static final class ImpulseButton extends GuiButton {
        private final boolean primary;

        private ImpulseButton(int id, int x, int y, int width, int height, String text, boolean primary) {
            super(id, x, y, width, height, text);
            this.primary = primary;
        }

        public void drawButton(Minecraft minecraft, int mouseX, int mouseY, float partialTicks) {
            if (!this.visible) return;
            this.hovered = mouseX >= this.x && mouseY >= this.y && mouseX < this.x + this.width && mouseY < this.y + this.height;
            if (classicMenu()) {
                int top = this.hovered ? 0xFF9A9A9A : 0xFF6F6F6F;
                int bottom = this.hovered ? 0xFF777777 : 0xFF4C4C4C;
                int text = this.hovered ? 0xFFFFFFA0 : 0xFFFFFFFF;
                drawGradientRect(this.x, this.y, this.x + this.width, this.y + this.height, top, bottom);
                drawRect(this.x, this.y, this.x + this.width, this.y + 1, 0xFFFFFFFF);
                drawRect(this.x, this.y, this.x + 1, this.y + this.height, 0xFFFFFFFF);
                drawRect(this.x, this.y + this.height - 1, this.x + this.width, this.y + this.height, 0xFF202020);
                drawRect(this.x + this.width - 1, this.y, this.x + this.width, this.y + this.height, 0xFF202020);
                drawCenteredString(minecraft.fontRenderer, this.displayString, this.x + this.width / 2, this.y + (this.height - 8) / 2, text);
                return;
            }
            int background = this.primary ? (this.hovered ? 0x8A000000 : 0x66000000) : (this.hovered ? 0x5C000000 : 0x38000000);
            int border = this.primary ? (this.hovered ? 0xFFFFFFFF : 0xCCFFFFFF) : (this.hovered ? 0xAAFFFFFF : 0x66FFFFFF);
            int text = 0xFFFFFFFF;
            drawRect(this.x, this.y, this.x + this.width, this.y + this.height, background);
            drawRect(this.x, this.y, this.x + this.width, this.y + 1, border);
            drawRect(this.x, this.y + this.height - 1, this.x + this.width, this.y + this.height, border);
            drawRect(this.x, this.y, this.x + 1, this.y + this.height, border);
            drawRect(this.x + this.width - 1, this.y, this.x + this.width, this.y + this.height, border);
            drawCenteredString(minecraft.fontRenderer, this.displayString, this.x + this.width / 2, this.y + (this.height - 8) / 2, text);
        }
    }
}
