package com.orientone.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class OwnerSessionClientTest {
    @Test
    fun sessionStartsUnauthenticatedAndKeepsNoPersistedCredentials() {
        val client = OwnerSessionClient(8080)
        assertFalse(client.isAuthenticated)
        client.clearSession()
        assertFalse(client.isAuthenticated)
    }

    @Test
    fun rejectsInvalidPorts() {
        assertThrows(IllegalArgumentException::class.java) { OwnerSessionClient(0) }
        assertThrows(IllegalArgumentException::class.java) { OwnerSessionClient(65536) }
    }
}
