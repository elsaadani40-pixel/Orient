package com.orientone.companion

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

internal class OwnerApiException(
    val statusCode: Int,
    val errorCode: String,
    override val message: String
) : Exception(message)

/**
 * Same-device client for the loopback-only ORIENT ONE service.
 * Credentials and session material are intentionally held in memory only.
 */
internal class OwnerSessionClient(port: Int) {
    private val origin: String
    private val baseUrl: String
    private var sessionCookie: String? = null
    private var csrfToken: String? = null

    init {
        require(port in 1..65535) { "Port must be between 1 and 65535" }
        origin = "http://127.0.0.1:$port"
        baseUrl = origin
    }

    val isAuthenticated: Boolean
        get() = !sessionCookie.isNullOrBlank() && !csrfToken.isNullOrBlank()

    suspend fun login(password: String): String = withContext(Dispatchers.IO) {
        require(password.length in 16..1024) { "كلمة المرور يجب أن تكون 16 حرفًا على الأقل." }
        val response = request(
            method = "POST",
            path = "/owner/login",
            body = JSONObject().put("password", password).toString(),
            requiresSession = false
        )
        val json = JSONObject(response.body)
        val cookie = response.setCookie
            ?.substringBefore(';')
            ?.takeIf { it.startsWith("orient_owner_session=") && it.length > "orient_owner_session=".length }
            ?: throw IllegalStateException("الخادم لم يُصدر جلسة مالك صالحة.")
        val token = json.optString("csrfToken").takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("الخادم لم يُصدر رمز حماية الجلسة.")
        sessionCookie = cookie
        csrfToken = token
        "تم تسجيل الدخول إلى ORIENT ONE بنجاح."
    }

    suspend fun fetchExecutions(): String = withContext(Dispatchers.IO) {
        val response = request("GET", "/executions?limit=20")
        prettyJson(response.body)
    }

    suspend fun executeTask(input: String): String = withContext(Dispatchers.IO) {
        val clean = input.trim()
        require(clean.isNotEmpty()) { "اكتب المهمة أولًا." }
        require(clean.length <= 5000) { "المهمة أطول من الحد المسموح." }
        val response = request(
            method = "POST",
            path = "/agent",
            body = JSONObject().put("input", clean).toString()
        )
        prettyJson(response.body)
    }

    suspend fun logout() = withContext(Dispatchers.IO) {
        try {
            if (isAuthenticated) {
                request(
                    method = "POST",
                    path = "/owner/logout",
                    body = "{}",
                    includeCsrf = true
                )
            }
        } finally {
            clearSession()
        }
    }

    fun clearSession() {
        sessionCookie = null
        csrfToken = null
    }

    private fun request(
        method: String,
        path: String,
        body: String? = null,
        requiresSession: Boolean = true,
        includeCsrf: Boolean = false
    ): ApiResponse {
        if (requiresSession && !isAuthenticated) {
            throw OwnerApiException(401, "OWNER_AUTH_REQUIRED", "سجّل الدخول أولًا.")
        }

        val connection = (URL(baseUrl + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 3000
            readTimeout = 120000
            useCaches = false
            doInput = true
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Origin", origin)
            setRequestProperty("Cache-Control", "no-store")
            if (requiresSession) {
                sessionCookie?.let { setRequestProperty("Cookie", it) }
            }
            if (includeCsrf) {
                csrfToken?.let { setRequestProperty("X-ORIENT-CSRF", it) }
            }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }

        try {
            if (body != null) {
                connection.outputStream.use { output ->
                    output.write(body.toByteArray(StandardCharsets.UTF_8))
                }
            }

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseBody = stream?.use { readBounded(it) } ?: ""
            val response = ApiResponse(
                statusCode = status,
                body = responseBody,
                setCookie = connection.getHeaderField("Set-Cookie")
            )

            if (status == 401) clearSession()
            if (status !in 200..299) {
                val error = try {
                    JSONObject(responseBody)
                } catch (_: JSONException) {
                    JSONObject()
                }
                throw OwnerApiException(
                    statusCode = status,
                    errorCode = error.optString("code", "HTTP_$status"),
                    message = error.optString("message").ifBlank { "تعذر الاتصال بخدمة ORIENT ONE (HTTP $status)." }
                )
            }
            return response
        } finally {
            connection.disconnect()
        }
    }

    private fun readBounded(input: java.io.InputStream): String {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        var total = 0
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > MAX_RESPONSE_BYTES) {
                throw IllegalStateException("استجابة الخادم تجاوزت الحد الآمن.")
            }
            output.write(buffer, 0, count)
        }
        return output.toString(StandardCharsets.UTF_8.name())
    }

    private fun prettyJson(raw: String): String = try {
        when (raw.trimStart().firstOrNull()) {
            '[' -> JSONArray(raw).toString(2)
            '{' -> JSONObject(raw).toString(2)
            else -> raw
        }
    } catch (_: JSONException) {
        raw
    }

    private data class ApiResponse(
        val statusCode: Int,
        val body: String,
        val setCookie: String?
    )

    private companion object {
        const val MAX_RESPONSE_BYTES = 1024 * 1024
    }
}
