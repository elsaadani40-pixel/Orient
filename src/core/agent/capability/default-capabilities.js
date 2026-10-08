const Capability = require('./capability');

function registerDefaultCapabilities(registry) {
  if (!registry) throw new TypeError('capabilityRegistry is required');

  const capabilities = [
    new Capability({ name: 'memory.read', description: 'قراءة المعلومات من ذاكرة ORIENT ONE', risk: 'low' }),
    new Capability({ name: 'memory.write', description: 'إضافة معلومات إلى ذاكرة ORIENT ONE', risk: 'medium' }),
    new Capability({ name: 'memory.delete', description: 'حذف معلومات من ذاكرة ORIENT ONE', risk: 'high' }),
    new Capability({ name: 'workspace.read', description: 'قراءة وتحليل مساحة عمل مسموحة دون تعديل', risk: 'low' }),
    new Capability({ name: 'workspace.write', description: 'تعديل ملفات داخل مساحة عمل معتمدة', risk: 'high' })
  ];

  for (const capability of capabilities) {
    if (!registry.has(capability.name)) registry.register(capability);
  }

  return registry;
}

module.exports = registerDefaultCapabilities;
