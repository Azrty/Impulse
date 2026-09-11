package com.impulse.bootstrap;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Bounded metadata requests, including DNS, TLS, upload and slow response bodies. */
final class StandaloneHttp {
    private static final ThreadPoolExecutor REQUESTS = new ThreadPoolExecutor(2, 2, 0L,
        TimeUnit.MILLISECONDS, new ArrayBlockingQueue<Runnable>(4), runnable -> {
            Thread thread = new Thread(runnable, "impulse-metadata-http");
            thread.setDaemon(true);
            return thread;
        });

    static final class Response {
        byte[] body;
        String algorithm, publicKey, keyId, signature;
    }

    static Response request(URL url, byte[] body, int limit, int connectTimeout, int readTimeout,
                            long timeoutMillis) throws IOException {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Launch cancelled.");
        final long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
        Future<Response> future;
        try {
            future = REQUESTS.submit(() -> fetch(url, body, limit, connectTimeout, readTimeout));
        } catch (RejectedExecutionException error) {
            throw new IOException("Metadata requests are still busy. Please try again shortly.", error);
        }
        try {
            while (true) {
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) throw new SocketTimeoutException("Timed out contacting " + url.getHost() + ".");
                try { return future.get(Math.min(remaining, TimeUnit.MILLISECONDS.toNanos(100)), TimeUnit.NANOSECONDS); }
                catch (TimeoutException ignored) { }
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new InterruptedIOException("Launch cancelled.");
        } catch (ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof IOException) throw (IOException) cause;
            throw new IOException("Metadata request failed for " + url.getHost() + ".", cause);
        } finally {
            future.cancel(true);
            REQUESTS.purge();
        }
    }

    private static Response fetch(URL url, byte[] body, int limit, int connectTimeout, int readTimeout) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setConnectTimeout(connectTimeout);
            connection.setReadTimeout(readTimeout);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "ImpulseStandalone/1.3 (https://impulsemc.com)");
            if (body != null) {
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(body.length);
                connection.setRequestProperty("Content-Type", "application/json");
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
            }
            int status = connection.getResponseCode();
            if (status != 200) throw new IOException("HTTP " + status + " from " + url.getHost() + ".");
            if (connection.getContentLengthLong() > limit) throw new IOException("Metadata response exceeds the size limit.");
            Response response = new Response();
            try (InputStream input = connection.getInputStream()) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Metadata request cancelled.");
                    if (output.size() + read > limit) throw new IOException("Metadata response exceeds the size limit.");
                    output.write(buffer, 0, read);
                }
                response.body = output.toByteArray();
            }
            response.algorithm = connection.getHeaderField("X-Impulse-Signature-Algorithm");
            response.publicKey = connection.getHeaderField("X-Impulse-Public-Key");
            response.keyId = connection.getHeaderField("X-Impulse-Key-Id");
            response.signature = connection.getHeaderField("X-Impulse-Signature");
            return response;
        } finally { connection.disconnect(); }
    }
}
