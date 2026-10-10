package com.orientone.companion

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat

@Composable
fun PhoneToolsCard() {
    val context = LocalContext.current
    var number by remember { mutableStateOf("") }
    var showContactsPermissionRationale by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("ابحث محليًا عن رقم في جهات الاتصال، أو افتح شاشة الاتصال يدويًا.") }
    var hasContactsPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED)
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasContactsPermission = granted
        status = if (granted) "تم منح إذن جهات الاتصال. اضغط البحث مرة أخرى." else "لم يُمنح إذن جهات الاتصال؛ لم تتم قراءة أي بيانات. يمكنك استخدام بقية ORIENT وفتح شاشة الاتصال دون هذا الإذن. إذا لم يظهر طلب الإذن مجددًا، يمكنك تغييره من إعدادات التطبيق."
    }

    if (showContactsPermissionRationale) {
        AlertDialog(
            onDismissRequest = {
                showContactsPermissionRationale = false
                status = "تم إلغاء البحث في جهات الاتصال؛ لم يُطلب أي إذن."
            },
            title = { Text("إذن اختياري لجهات الاتصال") },
            text = {
                Text("يحتاج البحث إلى إذن قراءة جهات الاتصال على هذا الهاتف فقط لمطابقة الرقم مع اسم محفوظ. الإذن اختياري؛ يمكنك الرفض واستخدام بقية ORIENT أو فتح شاشة الاتصال يدويًا.")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showContactsPermissionRationale = false
                        permissionLauncher.launch(Manifest.permission.READ_CONTACTS)
                    }
                ) { Text("متابعة وطلب الإذن") }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        showContactsPermissionRationale = false
                        status = "تم الرفض؛ لم تتم قراءة جهات الاتصال، ويمكنك استخدام بقية ORIENT."
                    }
                ) { Text("ليس الآن") }
            }
        )
    }

    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text("أدوات الهاتف", style = MaterialTheme.typography.titleLarge)
            Text("البحث يتم على الهاتف فقط. فتح شاشة الاتصال لا يجري المكالمة تلقائيًا.")
            OutlinedTextField(
                value = number,
                onValueChange = { number = it.take(40) },
                label = { Text("رقم الهاتف") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Button(
                onClick = {
                    val normalized = PhoneNumberTools.sanitize(number)
                    if (normalized == null) {
                        status = "رقم غير صالح. استخدم 3 إلى 20 رقمًا، مع + اختياري في البداية."
                    } else if (!hasContactsPermission) {
                        showContactsPermissionRationale = true
                    } else {
                        status = try {
                            PhoneNumberTools.lookupContactName(context, normalized)
                                ?.let { "الاسم المطابق في جهات الاتصال: $it" }
                                ?: "لم يُعثر على اسم مطابق في جهات الاتصال المحلية."
                        } catch (_: SecurityException) {
                            hasContactsPermission = false
                            "تعذر الوصول إلى جهات الاتصال. تحقق من الإذن وحاول مرة أخرى."
                        } catch (_: Exception) {
                            "تعذر البحث في جهات الاتصال على هذا الجهاز."
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth()
            ) { Text("البحث عن صاحب الرقم") }
            OutlinedButton(
                onClick = {
                    val intent = PhoneNumberTools.createDialIntent(number)
                    if (intent == null) {
                        status = "رقم غير صالح؛ لم يتم فتح تطبيق الاتصال."
                    } else {
                        try {
                            context.startActivity(intent)
                            status = "تم فتح شاشة الاتصال؛ راجع الرقم وأكّد المكالمة بنفسك."
                        } catch (_: Exception) {
                            status = "لا يتوفر تطبيق قادر على فتح شاشة الاتصال."
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth()
            ) { Text("فتح شاشة الاتصال") }
            Text(status, style = MaterialTheme.typography.bodySmall)
        }
    }
}
