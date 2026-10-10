package com.orientone.companion

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicInteger

class OwnerSessionClientTest {
    @Test
    fun sessionStartsUnauthenticatedAndRejectsInvalidPorts() {
        assertFalse(OwnerSessionClient(8080).isAuthenticated)
        assertThrows(IllegalArgumentException::class.java) { OwnerSessionClient(0) }
        assertThrows(IllegalArgumentException::class.java) { OwnerSessionClient(65536) }
    }

    @Test
    fun loginSendsSessionForTasksAndLogoutRevokesLocalCredentials() {
        val expiry = System.currentTimeMillis() + 60_000
        val executionRequests = AtomicInteger()
        val taskRequests = AtomicInteger()
        val logoutRequests = AtomicInteger()
        val server = startServer { exchange ->
            when (exchange.requestURI.path) {
                "/owner/login" -> {
                    assertEquals("POST", exchange.requestMethod)
                    assertTrue(exchange.requestHeaders.getFirst("Origin").startsWith("http://127.0.0.1:"))
                    respond(
                        exchange,
                        200,
                        """{"ok":true,"csrfToken":"csrf-test-token","expiresAt":$expiry}""",
                        "orient_owner_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; Path=/; HttpOnly; SameSite=Strict"
                    )
                }
                "/executions" -> {
                    assertTrue(exchange.requestHeaders.getFirst("Cookie").startsWith("orient_owner_session="))
                    executionRequests.incrementAndGet()
                    respond(exchange, 200, """{"executions":[]}""")
                }
                "/agent" -> {
                    assertEquals("POST", exchange.requestMethod)
                    assertTrue(exchange.requestHeaders.getFirst("Cookie").startsWith("orient_owner_session="))
                    assertTrue(exchange.requestBody.bufferedReader().readText().contains("test task"))
                    taskRequests.incrementAndGet()
                    respond(exchange, 200, """{"status":"completed"}""")
                }
                "/owner/logout" -> {
                    assertEquals("csrf-test-token", exchange.requestHeaders.getFirst("X-ORIENT-CSRF"))
                    assertTrue(exchange.requestHeaders.getFirst("Cookie").startsWith("orient_owner_session="))
                    logoutRequests.incrementAndGet()
                    respond(exchange, 200, """{"ok":true}""")
                }
                else -> respond(exchange, 404, """{"code":"NOT_FOUND"}""")
            }
        }

        try {
            val client = OwnerSessionClient(server.address.port)
            assertTrue(runBlocking { client.login("0123456789abcdef") }.contains("успешно"))
            assertTrue(client.isAuthenticated)
            assertTrue(runBlocking { client.fetchExecutions() }.contains("executions"))
            assertTrue(runBlocking { client.executeTask("test task") }.contains("completed"))
            runBlocking { client.logout() }

            assertEquals(1, executionRequests.get())
            assertEquals(1, taskRequests.get())
            assertEquals(1, logoutRequests.get())
            assertFalse(client.isAuthenticated)
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun expiredSessionIsClearedAndNoRequestIsSentWithIt() {
        var currentTime = 1_000L
        val requests = AtomicInteger()
        val server = startServer { exchange ->
            requests.incrementAndGet()
            respond(
                exchange,
                200,
                """{"ok":true,"csrfToken":"csrf-test-token","expiresAt":1001}""",
                "orient_owner_session=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; Path=/; HttpOnly"
            )
        }

        try {
            val client = OwnerSessionClient(server.address.port) { currentTime }
            runBlocking { client.login("0123456789abcdef") }
            assertTrue(client.isAuthenticated)

            currentTime = 1001L
            assertFalse(client.isAuthenticated)
            val error = assertThrows(OwnerApiException::class.java) {
                runBlocking { client.fetchExecutions() }
            }
            assertEquals(401, error.statusCode)
            assertEquals(1, requests.get())
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun expiredServerSessionResponseIsNotAcceptedAsAuthenticated() {
        val server = startServer { exchange ->
            respond(
                exchange,
                200,
                """{"ok":true,"csrfToken":"csrf-test-token","expiresAt":1}""",
                "orient_owner_session=cccccccccccccccccccccccccccccccccccccccccccccccc; Path=/; HttpOnly"
            )
        }

        try {
            val client = OwnerSessionClient(server.address.port) { 2L }
            assertThrows(IllegalStateException::class.java) {
                runBlocking { client.login("0123456789abcdef") }
            }
            assertFalse(client.isAuthenticated)
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun disconnectedServiceRaisesFailureInsteadOfReturningSuccess() {
        val server = startServer { exchange -> respond(exchange, 200, """{"ok":true}""") }
        val port = server.address.port
        server.stop(0)

        val client = OwnerSessionClient(port)
        assertThrows(IOException::class.java) {
            runBlocking { client.login("0123456789abcdef") }
        }
        assertFalse(client.isAuthenticated)
    }

    private fun startServer(handler: (HttpExchange) -> Unit): HttpServer {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            try {
                handler(exchange)
            } catch (error: Throwable) {
                try { respond(exchange, 500, """{"code":"TEST_SERVER_ERROR"}""") } catch (_: Exception) {}
                throw error
            }
        }
        server.start()
        return server
    }

    private fun respond(
        exchange: HttpExchange,
        status: Int,
        body: String,
        setCookie: String? = null
    ) {
        exchange.responseHeaders.set("Content-Type", "application/json; charset=utf-8")
        if (setCookie != null) exchange.responseHeaders.set("Set-Cookie", setCookie)
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }
}
