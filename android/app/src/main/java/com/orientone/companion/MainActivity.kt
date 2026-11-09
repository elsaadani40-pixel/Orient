package com.orientone.companion

import android.content.Context
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

private enum class OrientSection(val title: String, val symbol: String) {
    HOME("الرئيسية", "⌂"),
    TASKS("المهام", "▤"),
    ACTIVITY("النشاط", "◷"),
    PHONE("الهاتف", "▣"),
    SETTINGS("الإعدادات", "⚙")
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { OrientApp() }
    }
}

@Composable
private fun OrientApp() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val preferences = remember(context) {
        context.getSharedPreferences("orient_ui_preferences", Context.MODE_PRIVATE)
    }
    var isDarkTheme by remember { mutableStateOf(preferences.getBoolean("dark_theme", true)) }
    var selectedSection by remember { mutableStateOf(OrientSection.HOME) }
    var portText by remember { mutableStateOf("8080") }
    var password by remember { mutableStateOf("") }
    var taskInput by remember { mutableStateOf("") }
    var taskData by remember { mutableStateOf("") }
    var activityData by remember { mutableStateOf("") }
    var statusText by remember { mutableStateOf("ORIENT جاهز للاتصال بخدمة Runtime المحلية.") }
    var isBusy by remember { mutableStateOf(false) }
    var isAuthenticated by remember { mutableStateOf(false) }
    var client by remember { mutableStateOf<OwnerSessionClient?>(null) }
    val scope = rememberCoroutineScope()

    val background = if (isDarkTheme) Color(0xFF0B1118) else Color(0xFFF4F7F9)
    val panel = if (isDarkTheme) Color(0xFF141F2A) else Color.White
    val muted = if (isDarkTheme) Color(0xFFA8B6C5) else Color(0xFF647386)
    val accent = if (isDarkTheme) Color(0xFF79D4C5) else Color(0xFF147D73)
    val scheme = if (isDarkTheme) {
        darkColorScheme(
            primary = accent, onPrimary = Color(0xFF06231F), background = background,
            surface = panel, surfaceVariant = Color(0xFF1B2A38),
            onBackground = Color(0xFFF0F4F8), onSurface = Color(0xFFF0F4F8),
            onSurfaceVariant = muted
        )
    } else {
        lightColorScheme(
            primary = accent, onPrimary = Color.White, background = background,
            surface = panel, surfaceVariant = Color(0xFFE9EFF3),
            onBackground = Color(0xFF14202B), onSurface = Color(0xFF14202B),
            onSurfaceVariant = muted
        )
    }

    fun showFailure(error: Exception) {
        statusText = error.message ?: "تعذر الاتصال بخدمة ORIENT."
        if (error is OwnerApiException && error.statusCode == 401) {
            client?.clearSession()
            client = null
            isAuthenticated = false
        }
    }

    fun connect() {
        val port = portText.toIntOrNull()
        if (port == null || port !in 1..65535) {
            statusText = "أدخل منفذًا صحيحًا من 1 إلى 65535."
            return
        }
        val candidate = try {
            OwnerSessionClient(port)
        } catch (error: Exception) {
            showFailure(error)
            return
        }
        isBusy = true
        scope.launch {
            try {
                statusText = candidate.login(password)
                client = candidate
                isAuthenticated = true
                password = ""
                statusText = "اتصال آمن ونشط مع Runtime المحلي."
                selectedSection = OrientSection.HOME
            } catch (error: Exception) {
                candidate.clearSession()
                showFailure(error)
            } finally {
                isBusy = false
            }
        }
    }

    fun refreshTasks() {
        val activeClient = client ?: return
        isBusy = true
        scope.launch {
            try {
                taskData = activeClient.fetchTasks()
                statusText = "تم تحديث بيانات المهام من Runtime."
            } catch (error: Exception) {
                showFailure(error)
            } finally {
                isBusy = false
            }
        }
    }

    fun refreshActivity() {
        val activeClient = client ?: return
        isBusy = true
        scope.launch {
            try {
                activityData = activeClient.fetchExecutions()
                statusText = "تم تحديث سجل التنفيذات من Runtime."
            } catch (error: Exception) {
                showFailure(error)
            } finally {
                isBusy = false
            }
        }
    }

    MaterialTheme(colorScheme = scheme) {
        Surface(modifier = Modifier.fillMaxSize(), color = background) {
            Column(modifier = Modifier.fillMaxSize()) {
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        start = 18.dp, end = 18.dp, top = 20.dp, bottom = 24.dp
                    ),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    item {
                        AppHeader(
                            isDarkTheme = isDarkTheme,
                            onThemeToggle = {
                                isDarkTheme = !isDarkTheme
                                preferences.edit().putBoolean("dark_theme", isDarkTheme).apply()
                            }
                        )
                    }
                    item {
                        RuntimeStatusCard(
                            connected = isAuthenticated,
                            status = statusText,
                            panel = panel,
                            muted = muted
                        )
                    }
                    when (selectedSection) {
                        OrientSection.HOME -> {
                            item {
                                HomeScreen(
                                    connected = isAuthenticated,
                                    panel = panel,
                                    muted = muted,
                                    onConnect = { selectedSection = OrientSection.SETTINGS },
                                    onTasks = { selectedSection = OrientSection.TASKS },
                                    onActivity = { selectedSection = OrientSection.ACTIVITY },
                                    onPhone = { selectedSection = OrientSection.PHONE }
                                )
                            }
                        }
                        OrientSection.TASKS -> {
                            item {
                                TasksScreen(
                                    connected = isAuthenticated,
                                    busy = isBusy,
                                    taskInput = taskInput,
                                    taskData = taskData,
                                    panel = panel,
                                    muted = muted,
                                    onInputChange = { taskInput = it },
                                    onRefresh = { refreshTasks() },
                                    onConnect = { selectedSection = OrientSection.SETTINGS },
                                    onExecute = {
                                        val activeClient = client ?: return@TasksScreen
                                        isBusy = true
                                        scope.launch {
                                            try {
                                                taskData = activeClient.executeTask(taskInput)
                                                taskInput = ""
                                                statusText = "وصل رد التنفيذ من Runtime."
                                            } catch (error: Exception) {
                                                showFailure(error)
                                            } finally {
                                                isBusy = false
                                            }
                                        }
                                    }
                                )
                            }
                        }
                        OrientSection.ACTIVITY -> {
                            item {
                                DataScreen(
                                    title = "سجل النشاط",
                                    subtitle = "سجل التنفيذات الذي يعيده Runtime فقط.",
                                    connected = isAuthenticated,
                                    busy = isBusy,
                                    data = activityData,
                                    panel = panel,
                                    muted = muted,
                                    onRefresh = { refreshActivity() },
                                    onConnect = { selectedSection = OrientSection.SETTINGS }
                                )
                            }
                        }
                        OrientSection.PHONE -> {
                            item {
                                if (isAuthenticated) PhoneToolsCard()
                                else LockedFeatureCard(
                                    title = "أدوات الهاتف",
                                    description = "اتصل بخدمة ORIENT المحلية أولًا للوصول إلى مساحة العمل. أذونات الهاتف تظل اختيارية وتُطلب عند الحاجة فقط.",
                                    panel = panel,
                                    muted = muted,
                                    onConnect = { selectedSection = OrientSection.SETTINGS }
                                )
                            }
                        }
                        OrientSection.SETTINGS -> {
                            item {
                                SettingsScreen(
                                    connected = isAuthenticated,
                                    busy = isBusy,
                                    portText = portText,
                                    password = password,
                                    isDarkTheme = isDarkTheme,
                                    panel = panel,
                                    muted = muted,
                                    onPortChange = { portText = it },
                                    onPasswordChange = { password = it },
                                    onConnect = { connect() },
                                    onThemeToggle = {
                                        isDarkTheme = !isDarkTheme
                                        preferences.edit().putBoolean("dark_theme", isDarkTheme).apply()
                                    },
                                    onLogout = {
                                        val activeClient = client
                                        isBusy = true
                                        scope.launch {
                                            try {
                                                activeClient?.logout()
                                                statusText = "تم تسجيل الخروج بأمان."
                                            } catch (error: Exception) {
                                                statusText = error.message ?: "تعذر إنهاء الجلسة عن بُعد."
                                            } finally {
                                                activeClient?.clearSession()
                                                client = null
                                                isAuthenticated = false
                                                taskData = ""
                                                activityData = ""
                                                isBusy = false
                                            }
                                        }
                                    }
                                )
                            }
                        }
                    }
                    item {
                        Text(
                            "ORIENT · صلاحيات واضحة، تنفيذ محكوم، ونتائج من المصدر الفعلي.",
                            color = muted, style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center
                        )
                    }
                }
                NavigationBar(containerColor = panel) {
                    OrientSection.entries.forEach { section ->
                        NavigationBarItem(
                            selected = selectedSection == section,
                            onClick = {
                                selectedSection = section
                                if (section == OrientSection.TASKS && isAuthenticated && taskData.isBlank()) refreshTasks()
                                if (section == OrientSection.ACTIVITY && isAuthenticated && activityData.isBlank()) refreshActivity()
                            },
                            icon = { Text(section.symbol, fontSize = 19.sp) },
                            label = { Text(section.title, fontSize = 10.sp) }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun AppHeader(isDarkTheme: Boolean, onThemeToggle: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text("ORIENT", color = MaterialTheme.colorScheme.primary, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            Text("مساحة عملك الذكية", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text("Personal AI workspace", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        TextButton(onClick = onThemeToggle) {
            Text(if (isDarkTheme) "فاتح ☼" else "داكن ◐")
        }
    }
}

@Composable
private fun RuntimeStatusCard(connected: Boolean, status: String, panel: Color, muted: Color) {
    Card(
        colors = CardDefaults.cardColors(containerColor = panel),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("حالة ORIENT Runtime", fontWeight = FontWeight.SemiBold)
                Text(
                    if (connected) "متصل" else "بانتظار الاتصال",
                    color = if (connected) Color(0xFF39B980) else Color(0xFFE7AE4C),
                    fontWeight = FontWeight.Bold
                )
            }
            Text(status, color = muted, style = MaterialTheme.typography.bodyMedium)
            Text(
                if (connected) "اتصال محلي آمن · الجلسة في الذاكرة" else "محلي أولًا · لا يوجد اتصال بخادم حتى الآن",
                color = muted, style = MaterialTheme.typography.labelSmall
            )
        }
    }
}

@Composable
private fun HomeScreen(
    connected: Boolean,
    panel: Color,
    muted: Color,
    onConnect: () -> Unit,
    onTasks: () -> Unit,
    onActivity: () -> Unit,
    onPhone: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text("مرحبًا بك في ORIENT", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text(
                "مركز واحد لمهامك، خططك، وسجل التنفيذ — مع بقاء القرار والصلاحيات تحت سيطرتك.",
                color = muted, style = MaterialTheme.typography.bodyMedium
            )
        }
        Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("ابدأ من هنا", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(
                    if (connected) "خدمة Runtime متصلة. اختر مساحة العمل التي تريد متابعتها."
                    else "لتفعيل بياناتك الحقيقية، شغّل ORIENT Runtime محليًا ثم اربط التطبيق من الإعدادات.",
                    color = muted, style = MaterialTheme.typography.bodyMedium
                )
                Button(onClick = if (connected) onTasks else onConnect, modifier = Modifier.fillMaxWidth()) {
                    Text(if (connected) "افتح المهام" else "إعداد الاتصال")
                }
            }
        }
        Text("مساحات ORIENT", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        WorkspaceTile("المهام والتنفيذ", "إرسال المهام ومراجعة استجابات Runtime", "↗", panel, muted, onTasks)
        WorkspaceTile("سجل النشاط", "متابعة التنفيذات التي يعيدها الخادم", "◷", panel, muted, onActivity)
        WorkspaceTile("أدوات الهاتف", "أدوات محلية بإذن المستخدم وتأكيده", "▣", panel, muted, onPhone)
        Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("مبدأ ORIENT", fontWeight = FontWeight.Bold)
                Text(
                    "لن نعرض بيانات تجريبية أو قدرات غير متاحة. كل نتيجة تظهر هنا مصدرها خدمة ORIENT الفعلية، وكل إجراء حساس يظل خاضعًا لسياسات الخادم وموافقات المالك.",
                    color = muted, style = MaterialTheme.typography.bodySmall
                )
            }
        }
    }
}

@Composable
private fun WorkspaceTile(
    title: String, description: String, symbol: String,
    panel: Color, muted: Color, onClick: () -> Unit
) {
    Card(
        onClick = onClick,
        colors = CardDefaults.cardColors(containerColor = panel),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(symbol, color = MaterialTheme.colorScheme.primary, fontSize = 25.sp)
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, fontWeight = FontWeight.SemiBold)
                Text(description, color = muted, style = MaterialTheme.typography.bodySmall)
            }
            Text("‹", color = MaterialTheme.colorScheme.primary, fontSize = 22.sp)
        }
    }
}

@Composable
private fun TasksScreen(
    connected: Boolean, busy: Boolean, taskInput: String, taskData: String,
    panel: Color, muted: Color, onInputChange: (String) -> Unit,
    onRefresh: () -> Unit, onConnect: () -> Unit, onExecute: () -> Unit
) {
    if (!connected) {
        LockedFeatureCard(
            title = "المهام والتنفيذ",
            description = "سجّل الاتصال بخدمة Runtime المحلية لعرض مهامك وإرسال طلبات التنفيذ.",
            panel = panel, muted = muted, onConnect = onConnect
        )
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("المهام والتنفيذ", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("اكتب هدفك بوضوح. يراجع Runtime الصلاحيات والسياسات قبل تنفيذ الأدوات.", color = muted)
        OutlinedTextField(
            value = taskInput, onValueChange = onInputChange,
            modifier = Modifier.fillMaxWidth(), label = { Text("ما الذي تريد من ORIENT إنجازه؟") },
            minLines = 3, maxLines = 5, enabled = !busy
        )
        Button(onClick = onExecute, modifier = Modifier.fillMaxWidth(), enabled = !busy && taskInput.isNotBlank()) {
            Text("إرسال إلى Runtime")
        }
        OutlinedButton(onClick = onRefresh, modifier = Modifier.fillMaxWidth(), enabled = !busy) {
            Text("تحديث بيانات المهام")
        }
        if (busy) CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
        DataPanel("استجابة Runtime / بيانات المهام", taskData, panel, muted)
    }
}

@Composable
private fun DataScreen(
    title: String, subtitle: String, connected: Boolean, busy: Boolean, data: String,
    panel: Color, muted: Color, onRefresh: () -> Unit, onConnect: () -> Unit
) {
    if (!connected) {
        LockedFeatureCard(title, subtitle, panel, muted, onConnect)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(subtitle, color = muted)
        OutlinedButton(onClick = onRefresh, modifier = Modifier.fillMaxWidth(), enabled = !busy) {
            Text("تحديث السجل")
        }
        if (busy) CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
        DataPanel("بيانات من Runtime", data, panel, muted)
    }
}

@Composable
private fun DataPanel(title: String, data: String, panel: Color, muted: Color) {
    Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, fontWeight = FontWeight.Bold)
            Text(
                data.ifBlank { "لا توجد بيانات محمّلة بعد. استخدم زر التحديث لجلب البيانات الفعلية." },
                color = muted, style = MaterialTheme.typography.bodySmall
            )
        }
    }
}

@Composable
private fun LockedFeatureCard(
    title: String, description: String, panel: Color, muted: Color, onConnect: () -> Unit
) {
    Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text(description, color = muted)
            Button(onClick = onConnect, modifier = Modifier.fillMaxWidth()) { Text("الانتقال إلى إعداد الاتصال") }
        }
    }
}

@Composable
private fun SettingsScreen(
    connected: Boolean, busy: Boolean, portText: String, password: String,
    isDarkTheme: Boolean, panel: Color, muted: Color,
    onPortChange: (String) -> Unit, onPasswordChange: (String) -> Unit,
    onConnect: () -> Unit, onThemeToggle: () -> Unit, onLogout: () -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("الإعدادات", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("المظهر", fontWeight = FontWeight.Bold)
                Text(if (isDarkTheme) "الوضع الداكن مفعّل" else "الوضع الفاتح مفعّل", color = muted)
                OutlinedButton(onClick = onThemeToggle, modifier = Modifier.fillMaxWidth()) {
                    Text(if (isDarkTheme) "التبديل إلى الوضع الفاتح" else "التبديل إلى الوضع الداكن")
                }
            }
        }
        Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("اتصال Runtime المحلي", fontWeight = FontWeight.Bold)
                Text(
                    "يقبل التطبيق الاتصال بهذا الهاتف فقط عبر 127.0.0.1. كلمة المرور ورموز الجلسة لا تُحفظ على القرص.",
                    color = muted, style = MaterialTheme.typography.bodySmall
                )
                OutlinedTextField(
                    value = portText,
                    onValueChange = { value -> if (value.length <= 5 && value.all(Char::isDigit)) onPortChange(value) },
                    modifier = Modifier.fillMaxWidth(), label = { Text("منفذ الخدمة") },
                    singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    enabled = !busy && !connected
                )
                if (!connected) {
                    OutlinedTextField(
                        value = password, onValueChange = onPasswordChange,
                        modifier = Modifier.fillMaxWidth(), label = { Text("كلمة مرور المالك") },
                        singleLine = true, visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), enabled = !busy
                    )
                    Button(onClick = onConnect, modifier = Modifier.fillMaxWidth(), enabled = !busy && password.isNotBlank()) {
                        if (busy) CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                        else Text("اتصال آمن")
                    }
                } else {
                    Text("الجلسة الحالية مصادق عليها.", color = Color(0xFF39B980))
                    OutlinedButton(onClick = onLogout, modifier = Modifier.fillMaxWidth(), enabled = !busy) {
                        Text("تسجيل الخروج")
                    }
                }
            }
        }
        Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("الخصوصية والأمان", fontWeight = FontWeight.Bold)
                Text("• الاتصال محصور في 127.0.0.1.", color = muted, style = MaterialTheme.typography.bodySmall)
                Text("• لا تُخزّن كلمة المرور أو رموز الجلسة على القرص.", color = muted, style = MaterialTheme.typography.bodySmall)
                Text("• الصلاحيات الحساسة والموافقات يفرضها Runtime، وليس التطبيق.", color = muted, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
