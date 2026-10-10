package com.orientone.companion

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneNumberToolsTest {
    @Test
    fun sanitizeNormalizesCommonPhoneFormatting() {
        assertEquals("+201001234567", PhoneNumberTools.sanitize(" +20 (100)-123.4567 "))
    }

    @Test
    fun sanitizeRejectsEmptyShortAndOverlongNumbers() {
        assertNull(PhoneNumberTools.sanitize(""))
        assertNull(PhoneNumberTools.sanitize("12"))
        assertNull(PhoneNumberTools.sanitize("123456789012345678901"))
    }

    @Test
    fun sanitizeRejectsUnsupportedCharactersAndMisplacedPlus() {
        assertNull(PhoneNumberTools.sanitize("123;DROP"))
        assertNull(PhoneNumberTools.sanitize("20+123"))
        assertNull(PhoneNumberTools.sanitize("++20100123"))
    }

    @Test
    fun createDialIntentOnlyOpensDialerForValidNumbers() {
        val intent = PhoneNumberTools.createDialIntent("+20 100 123 4567")
        assertEquals(Intent.ACTION_DIAL, intent?.action)
        assertEquals("tel", intent?.data?.scheme)
        assertEquals("+201001234567", intent?.data?.schemeSpecificPart)
        assertNull(PhoneNumberTools.createDialIntent("bad-number"))
    }
}
