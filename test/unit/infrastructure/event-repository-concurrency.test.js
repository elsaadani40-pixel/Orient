const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const EventRepository = require('../../../src/infrastructure/persistence/json/event.repository');

test('serializes concurrent appendMany mutations without losing events', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-events-'));
  const file = path.join(dir, 'events.json');
  const worker = path.join(dir, 'worker.js');
  fs.writeFileSync(worker, `
    const EventRepository = require(${JSON.stringify(path.resolve(__dirname, '../../../src/infrastructure/persistence/json/event.repository'))});
    const repo = new EventRepository(process.argv[2]);
    const id = process.argv[3];
    repo.appendMany([{ id, type: 'concurrent.test', executionId: 'exec-1', data: { tenantId: 'tenant-a' } }], { tenantId: 'tenant-a' });
  `);

  await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, file, `event-${index}`], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`)));
  })));

  const repo = new EventRepository(file);
  const events = repo.findByExecutionId('exec-1', { tenantId: 'tenant-a' });
  assert.equal(events.length, 6);
  assert.deepEqual(new Set(events.map(event => event.id)), new Set(Array.from({ length: 6 }, (_, index) => `event-${index}`)));
});
