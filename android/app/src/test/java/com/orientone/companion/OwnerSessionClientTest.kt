package com.orientone.companion

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
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
        val unifiedTaskRequests = AtomicInteger()
        val taskDetailRequests = AtomicInteger()
        val logoutRequests = AtomicInteger()
        val loginMethod = AtomicReference<String?>()
        val loginOrigin = AtomicReference<String?>()
        val executionCookie = AtomicReference<String?>()
        val taskMethod = AtomicReference<String?>()
        val taskCookie = AtomicReference<String?>()
        val taskBody = AtomicReference<String?>()
        val logoutCsrf = AtomicReference<String?>()
        val logoutCookie = AtomicReference<String?>()
        val server = startServer { exchange ->
            when (exchange.requestURI.path) {
                "/owner/login" -> {
                    loginMethod.set(exchange.requestMethod)
                    loginOrigin.set(exchange.requestHeaders.getFirst("Origin"))
                    respond(
                        exchange,
                        200,
                        """{"ok":true,"csrfToken":"csrf-test-token","expiresAt":$expiry}""",
                        "orient_owner_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; Path=/; HttpOnly; SameSite=Strict"
                    )
                }
                "/api/v1/tasks" -> {
                    assertEquals("GET", exchange.requestMethod)
                    assertTrue(exchange.requestURI.rawQuery?.contains("limit=20") == true)
                    assertTrue(exchange.requestHeaders.getFirst("Cookie")?.startsWith("orient_owner_session=") == true)
                    unifiedTaskRequests.incrementAndGet()
                    respond(exchange, 200, """{"apiVersion":"v1","items":[{"id":"exec-1","status":"completed"}],"page":{"limit":20,"offset":0,"total":1}}""")
                }
                "/api/v1/tasks/exec-1" -> {
                    assertEquals("GET", exchange.requestMethod)
                    assertTrue(exchange.requestHeaders.getFirst("Cookie")?.startsWith("orient_owner_session=") == true)
                    taskDetailRequests.incrementAndGet()
                    respond(exchange, 200, """{"apiVersion":"v1","task":{"id":"exec-1","status":"completed"}}""")
                }
                "/executions" -> {
                    executionCookie.set(exchange.requestHeaders.getFirst("Cookie"))
                    executionRequests.incrementAndGet()
                    respond(exchange, 200, """{"executions":[]}""")
                }
                "/agent" -> {
                    taskMethod.set(exchange.requestMethod)
                    taskCookie.set(exchange.requestHeaders.getFirst("Cookie"))
                    taskBody.set(exchange.requestBody.bufferedReader().readText())
                    taskRequests.incrementAndGet()
                    respond(exchange, 200, """{"status":"completed"}""")
                }
                "/owner/logout" -> {
                    logoutCsrf.set(exchange.requestHeaders.getFirst("X-ORIENT-CSRF"))
                    logoutCookie.set(exchange.requestHeaders.getFirst("Cookie"))
                    logoutRequests.incrementAndGet()
                    respond(exchange, 200, """{"ok":true}""")
                }
                else -> respond(exchange, 404, """{"code":"NOT_FOUND"}""")
            }
        }

        try {
            val client = OwnerSessionClient(server.address.port)
            assertTrue(withApiDiagnostics("login") { runBlocking { client.login("0123456789abcdef") } }.contains("بنجاح"))
            assertTrue(client.isAuthenticated)
            assertTrue(withApiDiagnostics("fetchExecutions") { runBlocking { client.fetchExecutions() } }.contains("executions"))
            assertTrue(withApiDiagnostics("fetchTasks") { runBlocking { client.fetchTasks() } }.contains("\\\"apiVersion\\\": \\\"v1\\\""))
            assertTrue(withApiDiagnostics("fetchTask") { runBlocking { client.fetchTask("exec-1") } }.contains("exec-1"))
            assertThrows(IllegalArgumentException::class.java) { runBlocking { client.fetchTask("../private") } }
            assertTrue(withApiDiagnostics("executeTask") { runBlocking { client.executeTask("test task") } }.contains("completed"))
            withApiDiagnostics("logout") { runBlocking { client.logout() } }

            assertEquals("POST", loginMethod.get())
            assertTrue(loginOrigin.get()?.startsWith("http://127.0.0.1:") == true)
            assertTrue(executionCookie.get()?.startsWith("orient_owner_session=") == true)
            assertEquals("POST", taskMethod.get())
            assertTrue(taskCookie.get()?.startsWith("orient_owner_session=") == true)
            assertTrue(taskBody.get()?.contains("test task") == true)
            assertEquals("csrf-test-token", logoutCsrf.get())
            assertTrue(logoutCookie.get()?.startsWith("orient_owner_session=") == true)
            assertEquals(1, unifiedTaskRequests.get())
            assertEquals(1, taskDetailRequests.get())
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

    private fun <T> withApiDiagnostics(operation: String, block: () -> T): T = try {
        block()
    } catch (error: OwnerApiException) {
        throw AssertionError("$operation failed: HTTP ${error.statusCode} ${error.errorCode}: ${error.message}", error)
    }

    private fun startServer(handler: (HttpExchange) -> Unit): HttpServer {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            try {
                handler(exchange)
            } catch (error: Throwable) {
                val diagnostic = JSONObject()
                    .put("code", "TEST_SERVER_ERROR")
                    .put("message", "${error.javaClass.simpleName}: ${error.message ?: "no message"} at ${exchange.requestMethod} ${exchange.requestURI.path}")
                    .toString()
                try { respond(exchange, 500, diagnostic) } catch (_: Exception) {}
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
