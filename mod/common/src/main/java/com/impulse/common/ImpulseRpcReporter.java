package com.impulse.common;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public final class ImpulseRpcReporter {
    private static final long MIN_INTERVAL_MS = 5000L;
    private static volatile String lastPayload = "";
    private static volatile long lastSentAt = 0L;
    private static volatile boolean sending = false;
    private static volatile boolean loggedConnected = false;
    private static volatile boolean loggedFailure = false;

    private ImpulseRpcReporter() {
    }

    public static void report(String state, String screen, String dimension, boolean onServer) {
        if (!enabled()) return;
        final String payload = buildPayload(state, screen, dimension, onServer);
        long now = System.currentTimeMillis();
        if (payload.equals(lastPayload) && now - lastSentAt < MIN_INTERVAL_MS) return;
        if (sending && now - lastSentAt < 1000L) return;
        lastPayload = payload;
        lastSentAt = now;
        sending = true;
        Thread thread = new Thread(new Runnable() {
            public void run() {
                try {
                    send(payload);
                    if (!loggedConnected) {
                        loggedConnected = true;
                        System.out.println("[Impulse] Discord RPC bridge connected.");
                    }
                    loggedFailure = false;
                } catch (Exception error) {
                    if (!loggedFailure) {
                        loggedFailure = true;
                        System.out.println("[Impulse] Discord RPC bridge update failed: " + error.getMessage());
                    }
                } finally {
                    sending = false;
                }
            }
        }, "Impulse RPC Reporter");
        thread.setDaemon(true);
        thread.start();
    }

    private static boolean enabled() {
        if (!Boolean.parseBoolean(System.getProperty("impulse.rpc.enabled", "false"))) return false;
        return port() > 0 && token().length() > 0;
    }

    private static int port() {
        try {
            return Integer.parseInt(System.getProperty("impulse.rpc.bridge_port", "0").trim());
        } catch (Exception ignored) {
            return 0;
        }
    }

    private static String token() {
        return System.getProperty("impulse.rpc.bridge_token", "").trim();
    }

    private static void send(String payload) throws Exception {
        URL url = new URL("http://127.0.0.1:" + port() + "/rpc");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(1000);
        connection.setReadTimeout(1000);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Authorization", "Bearer " + token());
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setDoOutput(true);
        byte[] bytes = payload.getBytes("UTF-8");
        connection.setFixedLengthStreamingMode(bytes.length);
        OutputStream output = connection.getOutputStream();
        try {
            output.write(bytes);
        } finally {
            output.close();
        }
        try {
            connection.getInputStream().close();
        } catch (Exception ignored) {
        } finally {
            connection.disconnect();
        }
    }

    private static String buildPayload(String state, String screen, String dimension, boolean onServer) {
        long startedAt = parseLong(System.getProperty("impulse.rpc.started_at", "0"), 0L);
        if (startedAt <= 0L) startedAt = parseLong(System.getProperty("impulse.session.started_at", "0"), 0L);
        if (startedAt <= 0L) startedAt = System.currentTimeMillis();
        return "{"
            + "\"state\":\"" + escape(value(state, "playing")) + "\","
            + "\"screen\":\"" + escape(value(screen, "")) + "\","
            + "\"dimension\":\"" + escape(value(dimension, "")) + "\","
            + "\"serverName\":\"" + escape(System.getProperty("impulse.server.name", "Impulse Server")) + "\","
            + "\"serverAddress\":\"" + escape(serverAddress()) + "\","
            + "\"minecraft\":\"" + escape(System.getProperty("impulse.minecraft.version", "")) + "\","
            + "\"loader\":\"" + escape(System.getProperty("impulse.minecraft.loader", "")) + "\","
            + "\"startedAt\":" + startedAt + ","
            + "\"onServer\":" + onServer
            + "}";
    }

    private static String serverAddress() {
        String host = System.getProperty("impulse.server.address", "").trim();
        if (host.length() == 0) return "";
        String port = System.getProperty("impulse.server.port", "25565").trim();
        return host + ":" + port;
    }

    private static String value(String value, String fallback) {
        return value == null || value.trim().length() == 0 ? fallback : value.trim();
    }

    private static long parseLong(String value, long fallback) {
        try {
            return Long.parseLong(value.trim());
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private static String escape(String value) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"':
                    builder.append("\\\"");
                    break;
                case '\\':
                    builder.append("\\\\");
                    break;
                case '\b':
                    builder.append("\\b");
                    break;
                case '\f':
                    builder.append("\\f");
                    break;
                case '\n':
                    builder.append("\\n");
                    break;
                case '\r':
                    builder.append("\\r");
                    break;
                case '\t':
                    builder.append("\\t");
                    break;
                default:
                    if (c < 32) {
                        String hex = Integer.toHexString(c);
                        builder.append("\\u");
                        for (int pad = hex.length(); pad < 4; pad++) builder.append('0');
                        builder.append(hex);
                    } else {
                        builder.append(c);
                    }
            }
        }
        return builder.toString();
    }
}
