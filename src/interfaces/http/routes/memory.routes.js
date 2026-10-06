function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString('ar-EG');
  } catch {
    return value;
  }
}

function renderPage(memories, query, config) {
  const rows = memories.map(memory => `
    <tr>
      <td>
        <div class="memory-text">${escapeHtml(memory.text)}</div>
      </td>
      <td class="time">${escapeHtml(formatDate(memory.createdAt))}</td>
      <td>
        <form method="POST" action="/memory/delete" class="delete-form"
              onsubmit="return confirm('تمسح الذاكرة دي؟')">
          <input type="hidden" name="id" value="${escapeHtml(memory.id)}">
          <button type="submit" class="delete">🗑️</button>
        </form>
      </td>
    </tr>
  `).join('');

  let empty = '';

  if (memories.length === 0) {
    empty = query
      ? '<p class="empty">مفيش نتايج للبحث ده 🔍</p>'
      : '<p class="empty">لسه مفيش ذاكرة محفوظة. ابدأ أول Memory 👇</p>';
  }

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.appName)}</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 18px;
  background: #0d1117;
  color: #e6edf3;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.container {
  max-width: 900px;
  margin: 0 auto;
}

header {
  margin-bottom: 20px;
}

h1 {
  margin: 0 0 6px;
  font-size: 25px;
}

.sub {
  color: #8b949e;
  font-size: 13px;
}

.badge {
  display: inline-block;
  background: #238636;
  color: white;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
  vertical-align: middle;
}

form {
  margin: 0;
}

.input-row {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

input[type=text] {
  flex: 1;
  min-width: 0;
  padding: 13px;
  border-radius: 10px;
  border: 1px solid #30363d;
  background: #161b22;
  color: #e6edf3;
  font-size: 16px;
  outline: none;
}

input[type=text]:focus {
  border-color: #1f6feb;
}

button {
  cursor: pointer;
  border: 0;
}

.primary {
  padding: 12px 20px;
  border-radius: 10px;
  background: #238636;
  color: white;
  font-size: 16px;
}

.search {
  display: flex;
  gap: 8px;
  margin-bottom: 18px;
}

.search button {
  padding: 12px 20px;
  border-radius: 10px;
  background: #1f6feb;
  color: white;
  font-size: 16px;
}

table {
  width: 100%;
  border-collapse: collapse;
  overflow: hidden;
}

td {
  padding: 12px 8px;
  border-bottom: 1px solid #21262d;
  vertical-align: top;
}

.memory-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.time {
  color: #8b949e;
  font-size: 12px;
  white-space: nowrap;
}

.delete-form {
  display: inline;
}

.delete {
  background: transparent;
  font-size: 17px;
  padding: 4px;
}

.empty {
  color: #8b949e;
  text-align: center;
  padding: 30px 10px;
}

.status {
  color: #8b949e;
  font-size: 12px;
  margin-bottom: 12px;
}

@media (max-width: 600px) {
  .input-row,
  .search {
    flex-direction: column;
  }

  .primary,
  .search button {
    width: 100%;
  }

  .time {
    display: none;
  }
}
</style>
</head>

<body>
<div class="container">

<header>
  <h1>🧠 ${escapeHtml(config.appName)}
    <span class="badge">v${escapeHtml(config.version)}</span>
  </h1>
  <div class="sub">Personal Memory Core</div>
</header>

<div class="status">
  ${memories.length} ذاكرة
</div>

<form method="POST" action="/memory/add">
  <div class="input-row">
    <input
      type="text"
      name="text"
      placeholder="اكتب معلومة تحفظها..."
      maxlength="10000"
      required
      autocomplete="off"
    >
    <button class="primary" type="submit">احفظ</button>
  </div>
</form>

<form class="search" method="GET" action="/">
  <input
    type="text"
    name="q"
    placeholder="🔍 دوّر في ذاكرتك..."
    value="${escapeHtml(query)}"
    autocomplete="off"
  >
  <button type="submit">دوّر</button>
</form>

${empty}

<table>
  <tbody>
    ${rows}
  </tbody>
</table>

</div>
</body>
</html>`;
}

function createMemoryRoutes(memoryService, config) {
  const memoryContext = {
    agentId: 'ORIENT_RUNTIME',
    tenantId: config.defaultTenantId || 'local'
  };

  return {
    home(req, res, url) {
      const query = (url.searchParams.get('q') || '').trim();
      const memories = memoryService.list(query, memoryContext);

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      });

      res.end(renderPage(memories, query, config));
    },

    add(req, res, body) {
      const text = new URLSearchParams(body).get('text') || '';

      memoryService.add(text, {}, memoryContext);

      res.writeHead(303, {
        Location: '/'
      });

      res.end();
    },

    delete(req, res, body) {
      const id = new URLSearchParams(body).get('id') || '';

      memoryService.delete(id, memoryContext);

      res.writeHead(303, {
        Location: '/'
      });

      res.end();
    }
  };
}

module.exports = createMemoryRoutes;
