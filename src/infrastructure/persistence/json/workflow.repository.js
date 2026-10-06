const fs = require('fs');
const path = require('path');

class WorkflowRepository {
  constructor(filePath) {
    if (!filePath) throw new TypeError('filePath is required');
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) this.write([]);
  }

  read() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : [];
  }

  write(items) {
    const temp = this.filePath + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(items, null, 2));
    fs.renameSync(temp, this.filePath);
  }

  save(instance, tenantId = null) {
    const item = typeof instance.toJSON === 'function' ? instance.toJSON() : { ...instance };
    const effectiveTenantId = item.tenantId || 'local';
    if (tenantId && effectiveTenantId !== tenantId) throw new Error('Workflow tenant mismatch');
    const existing = this.findById(item.workflowId);
    if (existing && (existing.tenantId || 'local') !== effectiveTenantId) throw new Error('Workflow tenant collision');
    const items = this.read().filter(existing => existing.workflowId !== item.workflowId);
    items.push(item);
    this.write(items);
    return item;
  }

  findById(workflowId, tenantId = null) {
    return this.read().find(
      item => item.workflowId === workflowId && (!tenantId || item.tenantId === tenantId)
    ) || null;
  }

  findAll({ tenantId = null } = {}) {
    return this.read().filter(item => !tenantId || item.tenantId === tenantId);
  }

  delete(workflowId, tenantId = null) {
    const items = this.read();
    const next = items.filter(
      item => !(item.workflowId === workflowId && (!tenantId || item.tenantId === tenantId))
    );
    if (next.length !== items.length) this.write(next);
    return next.length !== items.length;
  }
}

module.exports = WorkflowRepository;
