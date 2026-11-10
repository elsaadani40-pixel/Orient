package com.orientone.companion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
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
    fun manifestRequestsContactsOnlyForTheUserInitiatedLookupAndNeverRequestsDirectCalling() {
        val context = RuntimeEnvironment.getApplication()
        val permissions = context.packageManager.getPackageInfo(
            context.packageName,
            PackageManager.GET_PERMISSIONS
        ).requestedPermissions?.toSet().orEmpty()

        assertTrue(Manifest.permission.READ_CONTACTS in permissions)
        assertFalse(Manifest.permission.CALL_PHONE in permissions)
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
