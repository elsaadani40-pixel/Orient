const fs = require('fs');
const path = require('path');

class WorkflowLeaseRepository {
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

  save(lease) {
    const items = this.read().filter(item => item.workflowId !== lease.workflowId);
    items.push({ ...lease });
    this.write(items);
    return { ...lease };
  }

  findByWorkflowId(workflowId, tenantId = null) {
    return this.read().find(
      item => item.workflowId === workflowId &&
        (!tenantId || item.metadata?.tenantId === tenantId)
    ) || null;
  }

  findAll({ tenantId = null } = {}) {
    return this.read().filter(
      item => !tenantId || item.metadata?.tenantId === tenantId
    );
  }

  delete(workflowId, leaseId) {
    const items = this.read();
    const next = items.filter(item => !(item.workflowId === workflowId && item.leaseId === leaseId));
    if (next.length !== items.length) this.write(next);
    return next.length !== items.length;
  }

  deleteExpired(workflowId, leaseId, now = Date.now()) {
    const items = this.read();
    const current = items.find(
      item => item.workflowId === workflowId && item.leaseId === leaseId
    );
    if (!current || new Date(current.expiresAt).getTime() > now) {
      return false;
    }
    const next = items.filter(
      item => !(item.workflowId === workflowId && item.leaseId === leaseId)
    );
    this.write(next);
    return true;
  }
}

module.exports = WorkflowLeaseRepository;
