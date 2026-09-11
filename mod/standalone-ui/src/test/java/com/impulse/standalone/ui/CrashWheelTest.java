package com.impulse.standalone.ui;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.impulse.bootstrap.ImpulseStandaloneBootstrap;
import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Map;
import com.sun.net.httpserver.HttpServer;

public final class CrashWheelTest {
    public static void main(String[] args) throws Exception {
        Path installation = Files.createTempDirectory("impulse-wheel-test-");
        HttpServer api = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        api.createContext("/v1/standalone/crash-wheel", exchange -> {
            byte[] request = exchange.getRequestBody().readAllBytes();
            String requestBody = new String(request);
            if (requestBody.contains("ServerError")) {
                exchange.sendResponseHeaders(503, -1);
                exchange.close();
                return;
            }
            byte[] response = requestBody.contains("Malformed") ? "{\"eligible\":\"true\"}".getBytes()
                : ("{\"eligible\":" + requestBody.contains("SelectedPlayer") + "}").getBytes();
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        api.start();
        String previousApi = System.getProperty("impulse.presence.api");
        System.setProperty("impulse.presence.api", "http://127.0.0.1:" + api.getAddress().getPort());
        try {
            Path settings = installation.resolve("impulse/standalone/settings.json");
            Files.createDirectories(settings.getParent());
            Files.writeString(settings, "{\"update_channel\":\"beta\",\"onboarding_version\":1}");

            Object normalWin = round(installation, 1, false);
            call(normalWin, "completeCrashWheel");
            check(!read(settings).has("crash_wheel_losses"), "Wins must not count as losses");

            for (int losses = 1; losses <= 3; losses++) {
                Object ui = round(installation, 0, true);
                set(ui, "crashWheelStartedAt", System.currentTimeMillis());
                try {
                    call(ui, "completeCrashWheel");
                    throw new AssertionError("The animation delay was skipped");
                } catch (IOException expected) { }
                check((int) call(ui, "crashWheelLosses") == losses - 1, "Early completion changed the counter");
                set(ui, "crashWheelStartedAt", 0L);
                call(ui, "completeCrashWheel");
                call(ui, "completeCrashWheel");
                JsonObject saved = read(settings);
                check(saved.get("crash_wheel_losses").getAsInt() == losses, "A defeat must count exactly once");
                check("beta".equals(saved.get("update_channel").getAsString()), "Update settings were overwritten");
                check(saved.get("onboarding_version").getAsInt() == 1, "Onboarding settings were overwritten");
                check((boolean) field(ui, "completed"), "A loss did not close the session");
                Path session = ((java.io.File) field(ui, "sessionDirectory")).toPath();
                check("quit".equals(read(session.resolve("result.json")).get("status").getAsString()), "Loss did not request a clean quit");
            }

            // Each instance represents another launch. The mercy state is available only
            // after the API confirms that this username is still enrolled.
            for (int sector = 0; sector < 5; sector++) {
                Object ui = helper(installation, "SelectedPlayer");
                check((boolean) call(ui, "crashWheelParticipant"), "The cursor must activate before Play");
                check((int) field(ui, "crashWheelSector") == -1, "Checking cursor eligibility drew a sector");
                check((long) field(ui, "crashWheelStartedAt") == 0L, "Checking cursor eligibility started the wheel timer");
                Map<?, ?> result = (Map<?, ?>) call(ui, "crashWheel");
                check(Boolean.TRUE.equals(result.get("mercy")), "The exemption was lost on relaunch");
                check(Boolean.TRUE.equals(result.get("required")), "The all-Play wheel must still appear");
                check(Boolean.FALSE.equals(result.get("crash")), "The exempt installation can still lose");
                check(Long.valueOf(3000).equals(result.get("duration_ms")), "Mercy spin should last three seconds");
                check(Long.valueOf(2000).equals(result.get("start_delay_ms")), "The two-second delay changed");
                set(ui, "crashWheelSector", sector);
                set(ui, "crashWheelStartedAt", 0L);
                Map<?, ?> completed = (Map<?, ?>) call(ui, "completeCrashWheel");
                check(Boolean.FALSE.equals(completed.get("closed")), "A Play sector closed Minecraft");
                check((boolean) field(ui, "crashWheelPassed"), "Play did not unlock launching");
                check(read(settings).get("crash_wheel_losses").getAsInt() == 3, "The permanent counter changed");
            }

            Object separate = helper(installation.resolve("other-installation"));
            check((int) call(separate, "crashWheelLosses") == 0, "The counter leaked into another installation");

            Object notListed = helper(installation, "NotListed");
            check(!(boolean) call(notListed, "crashWheelParticipant"), "A username absent from the API received the prank");
            check(!(boolean) field(notListed, "crashWheelMercy"), "Local history bypassed the API list");

            Object removedBeforePlay = helper(installation, "SelectedPlayer");
            check((boolean) call(removedBeforePlay, "crashWheelParticipant"), "Initial eligibility was not detected");
            field(removedBeforePlay, "request");
            ((ImpulseStandaloneBootstrap.UiRequest) field(removedBeforePlay, "request")).username = "NotListed";
            Map<?, ?> removedResult = (Map<?, ?>) call(removedBeforePlay, "crashWheel");
            check(Boolean.FALSE.equals(removedResult.get("required")), "Play reused a cached positive eligibility result");
            check(Boolean.FALSE.equals(removedResult.get("mercy")), "A removed participant received the mercy wheel");

            Object malformed = helper(installation, "Malformed");
            check(!(boolean) call(malformed, "crashWheelParticipant"), "A malformed API response enabled the prank");

            Object serverError = helper(installation, "ServerError");
            check(!(boolean) call(serverError, "crashWheelParticipant"), "An API error enabled the prank");

            System.setProperty("impulse.presence.api", "http://127.0.0.1:1");
            Object offline = helper(installation, "SelectedPlayer");
            check(!(boolean) call(offline, "crashWheelParticipant"), "A network failure enabled the prank");
            check(!(boolean) field(offline, "crashWheelMercy"), "A network failure enabled the mercy wheel");
            System.setProperty("impulse.presence.api", "http://127.0.0.1:" + api.getAddress().getPort());

            Path unwritable = installation.resolve("unwritable");
            Object failedSave = round(unwritable, 2, true);
            Files.createDirectories(unwritable.resolve("impulse/standalone/settings.json"));
            Files.writeString(unwritable.resolve("impulse/standalone/settings.json/blocker"), "occupied");
            try {
                call(failedSave, "completeCrashWheel");
                throw new AssertionError("A loss closed the game without saving its counter");
            } catch (IOException expected) { }
            check(!(boolean) field(failedSave, "completed"), "Save failure must not close Minecraft");
            System.out.println("CrashWheelTest passed: API-only eligibility, offline fail-closed, persistence, duplicate completion, three-loss cap, timer, isolation, write failure");
        } finally {
            api.stop(0);
            if (previousApi == null) System.clearProperty("impulse.presence.api");
            else System.setProperty("impulse.presence.api", previousApi);
            try (var paths = Files.walk(installation)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    private static Object helper(Path installation) throws Exception {
        return helper(installation, "");
    }

    private static Object helper(Path installation, String username) throws Exception {
        Files.createDirectories(installation);
        ImpulseStandaloneBootstrap.UiRequest request = new ImpulseStandaloneBootstrap.UiRequest();
        request.game_directory = installation.toString();
        request.session_directory = Files.createTempDirectory(installation, "session-").toString();
        request.username = username;
        var constructor = ImpulseStandaloneUi.class.getDeclaredConstructor(ImpulseStandaloneBootstrap.UiRequest.class);
        constructor.setAccessible(true);
        return constructor.newInstance(request);
    }

    private static Object round(Path installation, int sector, boolean crash) throws Exception {
        Object ui = helper(installation);
        set(ui, "crashWheelChecked", true);
        set(ui, "crashWheelRequired", true);
        set(ui, "crashWheelSector", sector);
        set(ui, "crashWheelCrash", crash);
        return ui;
    }

    private static Object call(Object ui, String name) throws Exception {
        var method = ImpulseStandaloneUi.class.getDeclaredMethod(name);
        method.setAccessible(true);
        try { return method.invoke(ui); }
        catch (InvocationTargetException error) { throw (Exception) error.getCause(); }
    }

    private static Field declared(String name) throws Exception {
        Field field = ImpulseStandaloneUi.class.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    private static void set(Object ui, String name, Object value) throws Exception { declared(name).set(ui, value); }
    private static Object field(Object ui, String name) throws Exception { return declared(name).get(ui); }
    private static JsonObject read(Path path) throws Exception { return new JsonParser().parse(Files.readString(path)).getAsJsonObject(); }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
