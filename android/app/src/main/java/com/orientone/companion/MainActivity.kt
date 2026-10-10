package com.orientone.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { OrientCompanionApp() }
    }
}

@Composable
private fun OrientCompanionApp() {
    val background = Color(0xFF080D16)
    val panel = Color(0xFF131D2B)
    val muted = Color(0xFFB5C2D5)
    val scope = rememberCoroutineScope()

    var portText by remember { mutableStateOf("8080") }
    var password by remember { mutableStateOf("") }
    var taskInput by remember { mutableStateOf("") }
    var resultText by remember { mutableStateOf("") }
    var statusText by remember { mutableStateOf("أدخل كلمة مرور المالك للاتصال بخدمة ORIENT ONE المحلية.") }
    var isBusy by remember { mutableStateOf(false) }
    var isAuthenticated by remember { mutableStateOf(false) }
    var client by remember { mutableStateOf<OwnerSessionClient?>(null) }

    fun handleFailure(error: Exception) {
        statusText = error.message ?: "تعذر الاتصال بخدمة ORIENT ONE."
        if (error is OwnerApiException && error.statusCode == 401) {
            client?.clearSession()
            client = null
            isAuthenticated = false
        }
    }

    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Color(0xFF8AB4FF),
            background = background,
            surface = panel,
            onBackground = Color(0xFFEAF1FB),
            onSurface = Color(0xFFEAF1FB)
        )
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = background) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 18.dp, vertical = 22.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                item {
                    Text("ORIENT ONE", color = MaterialTheme.colorScheme.primary, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(6.dp))
                    Text("المرافق التنفيذي", fontSize = 28.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(6.dp))
                    Text("اتصال محلي مصادق عليه · Android", color = Color(0xFF9BAAC0), fontSize = 13.sp)
                }

                item {
                    Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Text("حالة Runtime", fontWeight = FontWeight.SemiBold)
                                Text(
                                    if (isAuthenticated) "متصل ومصادق عليه" else "غير متصل",
                                    color = if (isAuthenticated) Color(0xFF80D8A2) else Color(0xFFFFC857),
                                    fontWeight = FontWeight.Bold
                                )
                            }
                            Text(statusText, color = muted, fontSize = 13.sp)
                        }
                    }
                }

                if (!isAuthenticated) {
                    item {
                        Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text("تسجيل دخول المالك", fontSize = 19.sp, fontWeight = FontWeight.Bold)
                                Text(
                                    "يجب تشغيل ORIENT ONE على هذا الهاتف عبر Termux. لا يُرسل التطبيق كلمة المرور إلا إلى 127.0.0.1، ولا يحفظها أو يحفظ الجلسة على القرص.",
                                    color = muted,
                                    fontSize = 13.sp
                                )
                                OutlinedTextField(
                                    value = portText,
                                    onValueChange = { value -> if (value.length <= 5 && value.all(Char::isDigit)) portText = value },
                                    modifier = Modifier.fillMaxWidth(),
                                    label = { Text("منفذ الخدمة المحلية") },
                                    singleLine = true,
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                    enabled = !isBusy
                                )
                                OutlinedTextField(
                                    value = password,
                                    onValueChange = { password = it },
                                    modifier = Modifier.fillMaxWidth(),
                                    label = { Text("كلمة مرور المالك") },
                                    singleLine = true,
                                    visualTransformation = PasswordVisualTransformation(),
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                                    enabled = !isBusy
                                )
                                Button(
                                    onClick = {
                                        val port = portText.toIntOrNull()
                                        if (port == null || port !in 1..65535) {
                                            statusText = "أدخل منفذًا صحيحًا من 1 إلى 65535."
                                        } else {
                                            val candidate = try {
                                                OwnerSessionClient(port)
                                            } catch (error: Exception) {
                                                handleFailure(error)
                                                null
                                            }
                                            if (candidate != null) {
                                                isBusy = true
                                                scope.launch {
                                                    try {
                                                        statusText = candidate.login(password)
                                                        client = candidate
                                                        isAuthenticated = true
                                                        password = ""
                                                        resultText = candidate.fetchExecutions()
                                                    } catch (error: Exception) {
                                                        candidate.clearSession()
                                                        handleFailure(error)
                                                    } finally {
                                                        isBusy = false
                                                    }
                                                }
                                            }
                                        }
                                    },
                                    modifier = Modifier.fillMaxWidth(),
                                    enabled = !isBusy
                                ) {
                                    if (isBusy) CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.height(18.dp))
                                    else Text("اتصال آمن")
                                }
                            }
                        }
                    }
                } else {
                    item {
                        Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text("تنفيذ مهمة", fontSize = 19.sp, fontWeight = FontWeight.Bold)
                                Text(
                                    "يُرسل الطلب إلى Runtime الحالي، الذي يطبّق سياساته وصلاحيات الأدوات. هذا لا يفعّل تلقائيًا قدرات غير مسجلة في الخادم.",
                                    color = muted,
                                    fontSize = 13.sp
                                )
                                OutlinedTextField(
                                    value = taskInput,
                                    onValueChange = { taskInput = it },
                                    modifier = Modifier.fillMaxWidth(),
                                    label = { Text("اكتب المهمة") },
                                    minLines = 3,
                                    maxLines = 6,
                                    enabled = !isBusy
                                )
                                Button(
                                    onClick = {
                                        val activeClient = client ?: return@Button
                                        isBusy = true
                                        scope.launch {
                                            try {
                                                statusText = "تم إرسال المهمة؛ بانتظار نتيجة Runtime…"
                                                resultText = activeClient.executeTask(taskInput)
                                                statusText = "وصلت استجابة من Runtime."
                                            } catch (error: Exception) {
                                                handleFailure(error)
                                            } finally {
                                                isBusy = false
                                            }
                                        }
                                    },
                                    modifier = Modifier.fillMaxWidth(),
                                    enabled = !isBusy && taskInput.isNotBlank()
                                ) { Text("تنفيذ المهمة") }

                                OutlinedButton(
                                    onClick = {
                                        val activeClient = client ?: return@OutlinedButton
                                        isBusy = true
                                        scope.launch {
                                            try {
                                                resultText = activeClient.fetchExecutions()
                                                statusText = "تم تحديث سجل التنفيذات."
                                            } catch (error: Exception) {
                                                handleFailure(error)
                                            } finally {
                                                isBusy = false
                                            }
                                        }
                                    },
                                    modifier = Modifier.fillMaxWidth(),
                                    enabled = !isBusy
                                ) { Text("تحديث سجل التنفيذات") }

                                TextButton(
                                    onClick = {
                                        val activeClient = client
                                        isBusy = true
                                        scope.launch {
                                            try {
                                                activeClient?.logout()
                                                statusText = "تم تسجيل الخروج."
                                            } catch (error: Exception) {
                                                statusText = error.message ?: "تعذر إنهاء الجلسة عن بُعد."
                                            } finally {
                                                activeClient?.clearSession()
                                                client = null
                                                isAuthenticated = false
                                                resultText = ""
                                                taskInput = ""
                                                isBusy = false
                                            }
                                        }
                                    },
                                    modifier = Modifier.align(Alignment.End),
                                    enabled = !isBusy
                                ) { Text("تسجيل الخروج") }
                            }
                        }
                    }

                    if (resultText.isNotBlank()) {
                        item {
                            Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text("استجابة الخادم", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                                    Text(resultText, color = muted, fontSize = 12.sp)
                                }
                            }
                        }
                    }
                }

                item {
                    Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("حدود القدرات الحالية", fontWeight = FontWeight.Bold)
                            Text("• تنفيذ المهام وسجل التنفيذات: عبر Runtime بعد المصادقة.", color = muted, fontSize = 13.sp)
                            Text("• البحث الخارجي وقراءة/كتابة الملفات: لا تُعرض كقدرات جاهزة ما لم تكن أدواتها مسجلة ومصرحًا بها في الخادم.", color = muted, fontSize = 13.sp)
                            Text("• جهات الاتصال، معرفة المتصل، المكالمات، الميكروفون والإشعارات: غير مفعّلة في هذه النسخة؛ لا توجد مراقبة خفية أو صلاحيات حساسة تلقائية.", color = muted, fontSize = 13.sp)
                        }
                    }
                }
            }
        }
    }
}
