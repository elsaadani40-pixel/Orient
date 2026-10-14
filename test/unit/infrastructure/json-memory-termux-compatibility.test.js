'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JsonMemoryRepository = require('../../../src/infrastructure/memory/json-memory.repository');

test('initialization and memory writes work when hard links are denied by the filesystem', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-no-hardlinks-'));
  const file = path.join(directory, 'memories.json');
  const originalLink = fs.linkSync;

  try {
    fs.linkSync = function deniedHardLink() {
      const error = new Error('hard links are not permitted in this filesystem');
      error.code = 'EACCES';
      throw error;
    };

    const repository = new JsonMemoryRepository(file);
    assert.deepEqual(repository.readRaw(), []);

    repository.insert({
      id: 'termux-memory-1',
      tenantId: 'local',
      scope: 'personal',
      text: 'portable lock fallback',
      type: 'note'
    });

    assert.equal(repository.findById('termux-memory-1', 'local', 'personal').text,
      'portable lock fallback');
    assert.equal(fs.existsSync(file + '.init-lock'), false,
      'initialization gate must be released after successful publication');
    assert.equal(fs.existsSync(file + '.lock'), false,
      'memory lock must be released after a successful write');
    assert.deepEqual(
      fs.readdirSync(directory).filter(name => name.includes('.candidate.')),
      [],
      'temporary lock candidates must be cleaned up'
    );
  } finally {
    fs.linkSync = originalLink;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('portable initialization preserves an existing store when a concurrent initializer wins', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orient-memory-existing-store-'));
  const file = path.join(directory, 'memories.json');
  const originalLink = fs.linkSync;

  try {
    fs.writeFileSync(file, JSON.stringify([{
      id: 'preserve-me',
      tenantId: 'local',
      scope: 'personal',
      text: 'existing memory',
      type: 'note'
    }]), { encoding: 'utf8', flag: 'wx' });

    fs.linkSync = function deniedHardLink() {
      const error = new Error('hard links are not permitted in this filesystem');
      error.code = 'EACCES';
      throw error;
    };

    const repository = new JsonMemoryRepository(file);
    assert.equal(repository.readRaw().length, 1);
    assert.equal(repository.readRaw()[0].id, 'preserve-me');
  } finally {
    fs.linkSync = originalLink;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
