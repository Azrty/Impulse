package com.impulse.common;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

public final class ImpulseManifestServer {
    private static HttpServer server;

    private ImpulseManifestServer() {
    }

    public static synchronized void start(File serverRoot) {
        start(serverRoot, ImpulseRuntimeDefaults.empty());
    }

    public static synchronized void start(File serverRoot, ImpulseRuntimeDefaults runtimeDefaults) {
        if (server != null) return;
        try {
            final ImpulseConfig config = ImpulseConfig.load(serverRoot, runtimeDefaults);
            server = HttpServer.create(new InetSocketAddress(config.manifestPort), 0);
            server.createContext("/impulse/server.json", new HttpHandler() {
                public void handle(HttpExchange exchange) throws IOException {
                    byte[] body = buildManifest(config).getBytes(StandardCharsets.UTF_8);
                    respond(exchange, 200, "application/json; charset=utf-8", body);
                }
            });
            server.createContext("/impulse/mods", new HttpHandler() {
                public void handle(HttpExchange exchange) throws IOException {
                    serveMod(config, exchange);
                }
            });
            server.createContext("/impulse/media", new HttpHandler() {
                public void handle(HttpExchange exchange) throws IOException {
                    serveMedia(config, exchange);
                }
            });
            server.setExecutor(null);
            server.start();
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

    public static synchronized void stop() {
        if (server != null) {
            server.stop(0);
            server = null;
        }
    }

    private static String buildManifest(ImpulseConfig config) throws IOException {
        List<ModFile> mods = scanMods(config);
        Json json = new Json();
        json.object();
        json.prop("manifest_version", config.manifestVersion).comma();
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
        json.prop("hide_server_name_from_play_button", config.menuHideServerNameFromPlayButton);
        json.endObject().comma();
        json.key("mods").array();
        for (int i = 0; i < mods.size(); i++) {
            ModFile mod = mods.get(i);
            json.object();
            json.prop("name", stripJar(mod.file.getName())).comma();
            json.prop("file_name", mod.file.getName()).comma();
            json.prop("download_url", publicUrl(config, "/impulse/mods/" + urlName(mod.file.getName()))).comma();
            json.prop("sha1", mod.sha1).comma();
            json.prop("size", mod.file.length()).comma();
            json.prop("required", true);
            json.endObject();
            if (i < mods.size() - 1) json.comma();
        }
        json.endArray();
        json.endObject();
        return json.toString();
    }

    private static List<ModFile> scanMods(ImpulseConfig config) throws IOException {
        List<ModFile> out = new ArrayList<ModFile>();
        File[] files = config.modsDirectory.listFiles();
        if (files == null) return out;
        for (File file : files) {
            String name = file.getName().toLowerCase();
            if (!file.isFile() || !name.endsWith(".jar")) continue;
            if (isExcluded(config, name)) continue;
            out.add(new ModFile(file, sha1(file)));
        }
        return out;
    }

    private static boolean isExcluded(ImpulseConfig config, String lowerName) {
        for (String excluded : config.excludedNames) {
            if (lowerName.contains(excluded)) return true;
        }
        return false;
    }

    private static void serveMod(ImpulseConfig config, HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        String prefix = "/impulse/mods/";
        if (!path.startsWith(prefix)) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        String name = URLDecoder.decode(path.substring(prefix.length()), "UTF-8");
        File target = new File(config.modsDirectory, name).getCanonicalFile();
        File root = config.modsDirectory.getCanonicalFile();
        if (!isInside(root, target) || !target.isFile() || isExcluded(config, target.getName().toLowerCase())) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        serveFile(exchange, target, "application/java-archive", true);
    }

    private static void serveMedia(ImpulseConfig config, HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        String prefix = "/impulse/media/";
        if (!path.startsWith(prefix)) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        String name = URLDecoder.decode(path.substring(prefix.length()), "UTF-8");
        File target = new File(config.mediaDirectory, name).getCanonicalFile();
        File root = config.mediaDirectory.getCanonicalFile();
        if (!isInside(root, target) || !target.isFile()) {
            respond(exchange, 404, "text/plain", bytes("Not found"));
            return;
        }
        serveFile(exchange, target, contentType(target.getName()), false);
    }

    private static void serveFile(HttpExchange exchange, File target, String contentType, boolean attachment) throws IOException {
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
        try {
            return URLEncoder.encode(name, "UTF-8").replace("+", "%20");
        } catch (Exception ignored) {
            return name.replace(" ", "%20");
        }
    }

    private static final class ModFile {
        final File file;
        final String sha1;

        ModFile(File file, String sha1) {
            this.file = file;
            this.sha1 = sha1;
        }
    }
}
