'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const clientPath = path.join(__dirname, '..', '..', '..', '..', 'src', 'interfaces', 'http', 'chat.js');
const source = fs.readFileSync(clientPath, 'utf8');

test('chat client renders approval-required state from the versioned Runtime response', () => {
  assert.ok(source.includes('response.approvalRequired === true'));
  assert.ok(source.includes("setAttribute('role', 'status')"));
  assert.ok(source.includes('مركز المالك لمراجعة طلب الموافقة'));
});

test('chat client renders bounded evidence references without interpreting server data as HTML', () => {
  assert.ok(source.includes('response.evidenceReferences.slice(0, 100)'));
  assert.ok(source.includes("typeof reference.id !== 'string'"));
  assert.ok(source.includes("typeof reference.type !== 'string'"));
  assert.ok(source.includes("item.textContent = label + ' · ' + reference.type + ' · ' + reference.id"));
  assert.ok(!source.includes('item.innerHTML'));
});

test('chat client refreshes response metadata during task monitoring', () => {
  assert.ok(source.includes('renderResponseMetadata(bubble, response)'));
  assert.ok(source.includes("response?.apiVersion === 'v1'"));
});
