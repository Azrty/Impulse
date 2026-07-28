package com.impulse.common;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
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
            expectedHashes.add(sha1(readFile(metadataJar)));

            Properties props = new Properties();
            props.setProperty("manifest.port", String.valueOf(port));
            props.setProperty("public.host", "localhost");
            props.setProperty("minecraft.version", "1.21.1");
            props.setProperty("minecraft.loader", "neoforge");
            props.setProperty("loader.version", "21.1.243");
            props.setProperty("mods.directory", "impulse-client-mods");
            props.setProperty("optionalmods.directory", "impulse-optional-mods");
            FileOutputStream output = new FileOutputStream(new File(configDir, "impulse-server.properties"));
            try {
                props.store(output, "encoding test");
            } finally {
                output.close();
            }

            ImpulseManifestServer.start(root);
            String manifest = new String(fetch(new URL("http://localhost:" + port + "/impulse/server.json")), StandardCharsets.UTF_8);
            if (!manifest.contains("\"optional_mods\"")) {
                throw new AssertionError("Manifest is missing optional_mods: " + manifest);
            }
            if (!manifest.contains("\"name\":\"Metadata Mod\"") || !manifest.contains("\"description\":\"A real metadata description.\"")) {
                throw new AssertionError("Manifest did not expose mod metadata: " + manifest);
            }
            Matcher matcher = Pattern.compile("\"download_url\":\"([^\"]+)\"").matcher(manifest);
            int downloads = 0;
            while (matcher.find()) {
                String url = matcher.group(1);
                byte[] body = fetch(new URL(url));
                String hash = sha1(body);
                if (!expectedHashes.contains(hash)) {
                    throw new AssertionError("Unexpected downloaded hash for " + url + ": " + hash);
                }
                downloads++;
            }
            int expectedDownloads = names.length + optionalNames.length + 1;
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
