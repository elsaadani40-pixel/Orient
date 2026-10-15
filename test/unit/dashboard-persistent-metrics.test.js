'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('dashboard metrics are sourced from durable execution history, not browser session counters', () => {
  const dashboard = fs.readFileSync(
    path.join(__dirname, '../../src/interfaces/http/dashboard.html'),
    'utf8'
  );

  assert.match(dashboard, /إجمالي التنفيذات المسجلة/);
  assert.match(dashboard, /آخر تنفيذ مسجل/);
  assert.match(dashboard, /async function loadPersistentMetrics\(\)/);
  assert.match(dashboard, /fetch\('\/executions\?limit=1&offset=0'/);
  assert.match(dashboard, /data\.executions\[0\]/);
  assert.match(dashboard, /void loadPersistentMetrics\(\)/);
  assert.doesNotMatch(dashboard, /let sent = 0/);
  assert.doesNotMatch(dashboard, /طلبات أعادت استجابة ناجحة في هذه الجلسة/);
  assert.doesNotMatch(dashboard, /عداد واجهة فقط، وليس سجلًا دائمًا/);
});
