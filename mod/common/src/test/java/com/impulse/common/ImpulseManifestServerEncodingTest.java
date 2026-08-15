package com.impulse.common;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Properties;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class ImpulseManifestServerEncodingTest {
    private ImpulseManifestServerEncodingTest() {
    }

    public static void main(String[] args) throws Exception {
        File root = createTempDir();
        int port = freePort();
        String[] names = new String[] {
            "SecurityCraft+v1.jar",
            "mod [client].jar",
            "foo%bar.jar",
            "a#b.jar",
            "apostrophe's.jar"
        };
        String[] optionalNames = new String[] {
            "optional+shader.jar",
            "optional [client].jar"
        };
        Set<String> expectedHashes = new HashSet<String>();
        try {
            File modsDir = new File(root, "impulse-client-mods");
            if (!modsDir.mkdirs()) throw new IllegalStateException("Unable to create " + modsDir);
            File optionalDir = new File(root, "impulse-optional-mods");
            if (!optionalDir.mkdirs()) throw new IllegalStateException("Unable to create " + optionalDir);
            File optimizationDir = new File(optionalDir, "Optimization");
            if (!optimizationDir.mkdirs()) throw new IllegalStateException("Unable to create " + optimizationDir);
            File configDir = new File(root, "config");
            if (!configDir.mkdirs()) throw new IllegalStateException("Unable to create " + configDir);

            for (String name : names) {
                byte[] body = ("content:" + name).getBytes(StandardCharsets.UTF_8);
                write(new File(modsDir, name), body);
                expectedHashes.add(sha1(body));
            }
            for (String name : optionalNames) {
                byte[] body = ("optional:" + name).getBytes(StandardCharsets.UTF_8);
                write(new File(optionalDir, name), body);
                expectedHashes.add(sha1(body));
            }
            File metadataJar = new File(optionalDir, "metadata-mod.jar");
            writeJar(metadataJar, "META-INF/neoforge.mods.toml",
                "[[mods]]\nmodId=\"metadata_mod\"\ndisplayName=\"Metadata Mod\"\ndescription=\"A real metadata description.\"\n");
            String metadataHash = sha1(readFile(metadataJar));
            expectedHashes.add(metadataHash);
            write(new File(optimizationDir, "config.json"), (
                "{\n" +
                "  \"id\": \"optimization\",\n" +
                "  \"name\": \"Optimization\",\n" +
                "  \"description\": \"Client performance improvements.\",\n" +
                "  \"default_enabled\": true,\n" +
                "  \"order\": 10\n" +
                "}\n").getBytes(StandardCharsets.UTF_8));
            File categoryJar = new File(optimizationDir, "sodium+client.jar");
            write(categoryJar, "category mod".getBytes(StandardCharsets.UTF_8));
            expectedHashes.add(sha1(readFile(categoryJar)));

            File managerDir = new File(root, "impulse/.manager");
            if (!managerDir.mkdirs()) throw new IllegalStateException("Unable to create " + managerDir);
            write(new File(managerDir, "public-index.json"), (
                "{\"version\":1,\"mods\":{\"" + metadataHash + "\":{" +
                "\"id\":\"metadata-project\",\"dependencies\":[\"library-project\"],\"conflicts\":[\"other-project\"]}}}\n"
            ).getBytes(StandardCharsets.UTF_8));
            write(new File(root, "impulse/content.json"), (
                "{\"announcements\":[{\"id\":\"hello\",\"title\":\"Hello\",\"body\":\"Welcome\"}]," +
                "\"changelog\":[{\"id\":\"v1\",\"version\":\"1.0\",\"title\":\"First\",\"body\":\"Ready\"}]," +
                "\"events\":[{\"id\":\"event\",\"title\":\"Launch\",\"description\":\"Soon\"}]}\n"
            ).getBytes(StandardCharsets.UTF_8));

            Properties props = new Properties();
            props.setProperty("manifest.port", String.valueOf(port));
            props.setProperty("public.host", "localhost");
            props.setProperty("minecraft.version", "1.21.1");
            props.setProperty("minecraft.loader", "neoforge");
            props.setProperty("loader.version", "21.1.243");
            props.setProperty("mods.directory", "impulse-client-mods");
            props.setProperty("optionalmods.directory", "impulse-optional-mods");
            props.setProperty("crashreports.maxFiles", "2");
            FileOutputStream output = new FileOutputStream(new File(configDir, "impulse-server.properties"));
            try {
                props.store(output, "encoding test");
            } finally {
                output.close();
            }

            ImpulseManifestServer.start(root, new ImpulseRuntimeDefaults("1.21.1", "neoforge", "21.1.243", "localhost", Integer.valueOf(25565), "1.0.5"));
            URL manifestUrl = new URL("http://localhost:" + port + "/impulse/server.json");
            String manifest = new String(fetch(manifestUrl), StandardCharsets.UTF_8);
            assertHead(manifestUrl, manifest.getBytes(StandardCharsets.UTF_8).length);
            if (!manifest.contains("\"impulse_version\":\"1.0.5\"")) {
                throw new AssertionError("Manifest is missing the Impulse runtime version: " + manifest);
            }
            if (!manifest.contains("\"optional_mods\"")) {
                throw new AssertionError("Manifest is missing optional_mods: " + manifest);
            }
            if (!manifest.contains("\"name\":\"Metadata Mod\"") || !manifest.contains("\"description\":\"A real metadata description.\"")) {
                throw new AssertionError("Manifest did not expose mod metadata: " + manifest);
            }
            if (!manifest.contains("\"optional_mod_categories\"") || !manifest.contains("\"id\":\"optimization\"") || !manifest.contains("\"category_id\":\"optimization\"")) {
                throw new AssertionError("Manifest did not expose optional mod categories: " + manifest);
            }
            if (!manifest.contains("\"id\":\"metadata-project\"") || !manifest.contains("\"dependencies\":[\"library-project\"]") || !manifest.contains("\"conflicts\":[\"other-project\"]")) {
                throw new AssertionError("Manifest did not merge the manager relationship index: " + manifest);
            }
            if (!manifest.contains("\"announcements\":[{\"id\":\"hello\"") || !manifest.contains("\"events\":[{\"id\":\"event\"")) {
                throw new AssertionError("Manifest did not expose launcher content: " + manifest);
            }
            if (!manifest.contains("\"crash_reports\":{\"enabled\":true,\"max_upload_bytes\":2097152}")) {
                throw new AssertionError("Manifest did not expose crash report capability: " + manifest);
            }
            String crashEndpoint = "http://localhost:" + port + "/impulse/crash-reports";
            for (int reportIndex = 0; reportIndex < 3; reportIndex++) {
                String report = "{\"report_id\":\"report-" + reportIndex + "\",\"created_at\":\"2026-08-06T12:00:00Z\",\"player\":{\"username\":\"Test Player\"},\"crash\":{\"exit_code\":1}}";
                String response = new String(postJson(new URL(crashEndpoint), report.getBytes(StandardCharsets.UTF_8)), StandardCharsets.UTF_8);
                if (!response.contains("\"success\":true")) throw new AssertionError("Crash report upload failed: " + response);
            }
            File[] crashFiles = new File(root, "impulse/crash_reports").listFiles();
            int storedCrashReports = 0;
            if (crashFiles != null) {
                for (File crashFile : crashFiles) if (crashFile.getName().endsWith(".json")) storedCrashReports++;
            }
            if (storedCrashReports != 2) throw new AssertionError("Expected crash report retention to keep 2 files, got " + storedCrashReports);
            ImpulseManifestServer.ReloadResult maintenance = ImpulseManifestServer.setMaintenance(true, "Updating the server");
            if (!maintenance.success) throw new AssertionError(maintenance.message);
            manifest = new String(fetch(new URL("http://localhost:" + port + "/impulse/server.json")), StandardCharsets.UTF_8);
            if (!manifest.contains("\"maintenance\":{\"enabled\":true") || !manifest.contains("\"message\":\"Updating the server\"")) {
                throw new AssertionError("Maintenance command state was not persisted and reloaded: " + manifest);
            }
            Matcher matcher = Pattern.compile("\"download_url\":\"([^\"]+)\"").matcher(manifest);
            int downloads = 0;
            while (matcher.find()) {
                String url = matcher.group(1);
                URL downloadUrl = new URL(url);
                byte[] body = fetch(downloadUrl);
                assertHead(downloadUrl, body.length);
                String hash = sha1(body);
                if (!expectedHashes.contains(hash)) {
                    throw new AssertionError("Unexpected downloaded hash for " + url + ": " + hash);
                }
                downloads++;
            }
            int expectedDownloads = names.length + optionalNames.length + 2;
            if (downloads != expectedDownloads) {
                throw new AssertionError("Expected " + expectedDownloads + " download URLs, got " + downloads + "\n" + manifest);
            }
        } finally {
            ImpulseManifestServer.stop();
            delete(root);
        }
    }

    private static int freePort() throws Exception {
        ServerSocket socket = new ServerSocket(0);
        try {
            return socket.getLocalPort();
        } finally {
            socket.close();
        }
    }

    private static File createTempDir() throws Exception {
        File file = File.createTempFile("impulse-manifest-", "");
        if (!file.delete() || !file.mkdirs()) {
            throw new IllegalStateException("Unable to create temp dir " + file);
        }
        return file;
    }

    private static void write(File file, byte[] body) throws Exception {
        FileOutputStream output = new FileOutputStream(file);
        try {
            output.write(body);
        } finally {
            output.close();
        }
    }

    private static void writeJar(File file, String entryName, String body) throws Exception {
        JarOutputStream output = new JarOutputStream(new FileOutputStream(file));
        try {
            output.putNextEntry(new JarEntry(entryName));
            output.write(body.getBytes(StandardCharsets.UTF_8));
            output.closeEntry();
        } finally {
            output.close();
        }
    }

    private static byte[] readFile(File file) throws Exception {
        return readFully(file.toURI().toURL().openStream());
    }

    private static byte[] fetch(URL url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        int status = connection.getResponseCode();
        InputStream input = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        byte[] body = readFully(input);
        if (status < 200 || status >= 300) {
            throw new AssertionError("HTTP " + status + " for " + url + ": " + new String(body, StandardCharsets.UTF_8));
        }
        return body;
    }

    private static byte[] postJson(URL url, byte[] body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setDoOutput(true);
        OutputStream output = connection.getOutputStream();
        output.write(body);
        output.close();
        int status = connection.getResponseCode();
        InputStream input = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        byte[] response = readFully(input);
        if (status < 200 || status >= 300) {
            throw new AssertionError("HTTP " + status + " for " + url + ": " + new String(response, StandardCharsets.UTF_8));
        }
        return response;
    }

    private static void assertHead(URL url, long expectedLength) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        connection.setRequestMethod("HEAD");
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) throw new AssertionError("HEAD returned HTTP " + status + " for " + url);
        if (connection.getContentLengthLong() != expectedLength) {
            throw new AssertionError("HEAD returned length " + connection.getContentLengthLong() + " for " + url + ", expected " + expectedLength);
        }
        if (connection.getInputStream().read() != -1) throw new AssertionError("HEAD returned a body for " + url);
        connection.disconnect();
    }

    private static byte[] readFully(InputStream input) throws Exception {
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            return output.toByteArray();
        } finally {
            if (input != null) input.close();
        }
    }

    private static String sha1(byte[] body) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-1");
        byte[] hash = digest.digest(body);
        StringBuilder out = new StringBuilder();
        for (byte b : hash) out.append(String.format("%02x", b));
        return out.toString();
    }

    private static void delete(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) delete(child);
        }
        file.delete();
    }
}
