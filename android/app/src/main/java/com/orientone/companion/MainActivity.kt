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
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private data class Capability(
    val title: String,
    val detail: String,
    val status: String = "غير متصل"
)

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
    val capabilities = listOf(
        Capability("المحادثة والمهام", "ستتصل بواجهة Runtime موثقة بعد إضافة المصادقة."),
        Capability("البحث والقراءة", "ستُعرض النتائج مع المصدر وحالة الاتصال."),
        Capability("الملفات والكتابة", "ستحتاج إلى نطاق وصول واضح ومراجعة قبل التعديل."),
        Capability("جهات الاتصال والمتصل", "غير مفعّلة؛ لا توجد صلاحيات حساسة مطلوبة في هذه النسخة."),
        Capability("الصوت والميكروفون", "غير مفعّل؛ لن يبدأ تسجيل أو التقاط صوت في الخلفية."),
        Capability("الإشعارات وأحداث الجهاز", "غير مفعّلة حتى تنفيذ مسارات الصلاحيات والإلغاء.")
    )

    MaterialTheme(colorScheme = darkColorScheme(
        primary = Color(0xFF8AB4FF),
        background = background,
        surface = panel,
        onBackground = Color(0xFFEAF1FB),
        onSurface = Color(0xFFEAF1FB)
    )) {
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
                    Text("نسخة تأسيسية · Android", color = Color(0xFF9BAAC0), fontSize = 13.sp)
                }
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                                Text("حالة Runtime", fontWeight = FontWeight.SemiBold)
                                Text("غير متصل", color = Color(0xFFFFC857), fontWeight = FontWeight.Bold)
                            }
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "لم يتم ربط التطبيق بالخادم بعد. لن تُعرض أي عملية على أنها ناجحة قبل تنفيذ الاتصال والمصادقة والتحقق.",
                                color = Color(0xFFB5C2D5),
                                fontSize = 13.sp
                            )
                        }
                    }
                }
                item {
                    Text("القدرات", fontSize = 19.sp, fontWeight = FontWeight.Bold)
                }
                items(capabilities) { capability ->
                    Card(colors = CardDefaults.cardColors(containerColor = panel), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                                Text(capability.title, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                                Text(capability.status, color = Color(0xFFFFC857), fontSize = 12.sp)
                            }
                            Text(capability.detail, color = Color(0xFFB5C2D5), fontSize = 13.sp)
                        }
                    }
                }
                item {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "الخصوصية أولًا: لا تُطلب صلاحيات جهات الاتصال أو المكالمات أو الميكروفون في هذه المرحلة.",
                        color = Color(0xFF8FA4C0),
                        fontSize = 12.sp
                    )
                }
            }
        }
    }
}
