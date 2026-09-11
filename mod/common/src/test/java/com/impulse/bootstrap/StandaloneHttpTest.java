package com.impulse.bootstrap;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class StandaloneHttpTest {
    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        ExecutorService executor = Executors.newCachedThreadPool();
        server.setExecutor(executor);
        CountDownLatch pending = new CountDownLatch(1);
        server.createContext("/ok", exchange -> {
            byte[] body = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("X-Impulse-Signature", "test-signature");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.createContext("/post", exchange -> {
            while (exchange.getRequestBody().read() != -1) { }
            exchange.sendResponseHeaders("POST".equals(exchange.getRequestMethod()) ? 200 : 405, 2);
            exchange.getResponseBody().write("{}".getBytes(StandardCharsets.UTF_8));
            exchange.close();
        });
        server.createContext("/error", exchange -> { exchange.sendResponseHeaders(503, -1); exchange.close(); });
        server.createContext("/slow", exchange -> {
            try {
                exchange.sendResponseHeaders(200, 0);
                for (int i = 0; i < 100; i++) {
                    exchange.getResponseBody().write(' ');
                    exchange.getResponseBody().flush();
                    Thread.sleep(40);
                }
            } catch (IOException ignored) { }
            catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            finally { exchange.close(); }
        });
        server.createContext("/pending", exchange -> {
            pending.countDown();
            try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            exchange.close();
        });
        server.start();
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        try {
            StandaloneHttp.Response ok = get(base + "/ok", 100, 1000);
            require(new String(ok.body, StandardCharsets.UTF_8).equals("{\"ok\":true}"), "Exact response bytes");
            require("test-signature".equals(ok.signature), "Preserve signature headers");
            StandaloneHttp.request(new URL(base + "/post"), "{}".getBytes(StandardCharsets.UTF_8), 100, 500, 500, 1000);
            expectFailure(() -> get(base + "/ok", 2, 1000), "size limit");
            expectFailure(() -> get(base + "/error", 100, 1000), "HTTP 503");
            long started = System.nanoTime();
            try { get(base + "/slow", 10000, 250); throw new AssertionError("Slow-drip body must time out"); }
            catch (SocketTimeoutException expected) { }
            require(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 1500, "Total deadline must not reset per byte");
            AtomicReference<Throwable> failure = new AtomicReference<Throwable>();
            Thread caller = new Thread(() -> {
                try { get(base + "/pending", 100, 5000); failure.set(new AssertionError("Cancellation was ignored")); }
                catch (InterruptedIOException expected) {
                    if (!Thread.currentThread().isInterrupted()) failure.set(new AssertionError("Interrupt flag lost"));
                } catch (Throwable error) { failure.set(error); }
            });
            caller.start();
            require(pending.await(2, TimeUnit.SECONDS), "Pending request started");
            caller.interrupt();
            caller.join(1000);
            require(!caller.isAlive(), "Cancellation must release the launch thread promptly");
            if (failure.get() != null) throw new AssertionError(failure.get());
            get(base + "/ok", 100, 2000);
            System.out.println("Standalone HTTP: success, POST, headers, size, status, slow-drip timeout, cancellation and recovery passed.");
        } finally { server.stop(0); executor.shutdownNow(); }
    }

    private static StandaloneHttp.Response get(String url, int limit, long deadline) throws IOException {
        return StandaloneHttp.request(new URL(url), null, limit, 500, 500, deadline);
    }
    private interface Request { void run() throws Exception; }
    private static void expectFailure(Request request, String text) throws Exception {
        try { request.run(); throw new AssertionError("Expected " + text); }
        catch (IOException expected) { require(expected.getMessage().contains(text), expected.getMessage()); }
    }
    private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
