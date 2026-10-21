'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const clientPath = path.join(__dirname, '..', '..', '..', 'src', 'interfaces', 'http', 'chat.js');
const source = fs.readFileSync(clientPath, 'utf8');

test('chat client renders approval-required state from the versioned Runtime response', () => {
  assert.match(source, /response\.approvalRequired === true/);
  assert.match(source, /role', 'status'/);
  assert.match(source, /مركز المالك لمراجعة طلب الموافقة/);
});

test('chat client renders bounded evidence references without interpreting server data as HTML', () => {
  assert.match(source, /response\.evidenceReferences\.slice\(0, 100\)/);
  assert.match(source, /typeof reference\.id === 'string'/);
  assert.match(source, /item\.textContent = label \+ ' · ' \+ reference\.type \+ ' · ' \+ reference\.id/);
  assert.doesNotMatch(source, /item\.innerHTML\s*=/);
});

test('chat client refreshes response metadata during task monitoring', () => {
  assert.match(source, /renderResponseMetadata\(bubble, response\)/);
  assert.match(source, /response\.apiVersion === 'v1'/);
});
