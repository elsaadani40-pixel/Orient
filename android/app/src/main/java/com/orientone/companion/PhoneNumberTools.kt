package com.orientone.companion

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.ContactsContract

/**
 * Device-local phone helpers. Numbers are not sent to the ORIENT server or persisted.
 */
object PhoneNumberTools {
    fun sanitize(raw: String): String? {
        val value = raw.trim()
        if (value.isEmpty() || value.any { !(it.isDigit() || it in "+ ().-\t") }) return null

        val compact = value.filter { it.isDigit() || it == '+' }
        if (compact.count { it == '+' } > 1 || (compact.length > 1 && compact.drop(1).contains('+'))) return null
        val digitCount = compact.count { it.isDigit() }
        if (digitCount !in 3..20) return null
        return compact
    }

    fun lookupContactName(context: Context, raw: String): String? {
        val number = sanitize(raw) ?: return null
        val uri = Uri.withAppendedPath(
            ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
            Uri.encode(number)
        )
        val projection = arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME)
        context.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(ContactsContract.PhoneLookup.DISPLAY_NAME)
                if (index >= 0) return cursor.getString(index)
            }
        }
        return null
    }

    fun createDialIntent(raw: String): Intent? {
        val number = sanitize(raw) ?: return null
        return Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null))
    }
}
